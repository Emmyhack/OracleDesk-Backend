import { StrKey } from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { withAdvisoryLock } from '../lib/advisory-lock';

export const ADMIN_ROLES = ['super_admin', 'operator', 'auditor'] as const;
export type AdminRoleName = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  'admin.read',
  'admin.manage',
  'admin.audit.read',
  'markets.generate',
  'treasury.read',
  'treasury.operate',
  'agents.manage',
  'disputes.manage',
  'trace_audit.run',
  'reconciliation.run',
  'calibration.recompute',
  'refund.request',
  'refund.approve',
  'refund.prepare',
  'indexer.replay',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AdminRoleName, readonly AdminPermission[]> = {
  super_admin: ADMIN_PERMISSIONS,
  operator: [
    'admin.read',
    'markets.generate',
    'treasury.read',
    'treasury.operate',
    'agents.manage',
    'disputes.manage',
    'trace_audit.run',
    'reconciliation.run',
    'calibration.recompute',
    'refund.request',
    'refund.prepare',
  ],
  auditor: [
    'admin.read',
    'admin.audit.read',
    'treasury.read',
    'trace_audit.run',
    'reconciliation.run',
    'refund.approve',
  ],
};

const ROLE_DESCRIPTIONS: Record<AdminRoleName, string> = {
  super_admin: 'Full control, including granting and revoking admin roles',
  operator: 'Runs markets, treasury operations, agents and reconciliation',
  auditor: 'Read-only oversight plus audit and reconciliation reviews',
};

export interface AdminAccess {
  roleName: AdminRoleName;
  permissions: Set<string>;
}

export function isAdminRole(value: unknown): value is AdminRoleName {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

export function isAdminAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    StrKey.isValidEd25519PublicKey(value)
  );
}

/**
 * Seeds the fixed permission/role catalogue and, only on an uninitialised
 * database, assigns ADMIN_ADDRESSES as super admins. Once any role exists the
 * database is authoritative: an address removed or revoked there is never
 * re-granted from the environment.
 */
export async function ensureAdminRbacSeeded(): Promise<void> {
  if ((await prisma.adminRole.count()) > 0) return;

  const result = await withAdvisoryLock('admin:rbac:bootstrap', async (tx) => {
    if ((await tx.adminRole.count()) > 0) return;
    await tx.adminPermission.createMany({
      data: ADMIN_PERMISSIONS.map((key) => ({ key, description: key })),
      skipDuplicates: true,
    });
    await tx.adminRole.createMany({
      data: ADMIN_ROLES.map((name) => ({ name, description: ROLE_DESCRIPTIONS[name] })),
      skipDuplicates: true,
    });
    for (const role of ADMIN_ROLES) {
      await tx.adminRolePermission.createMany({
        data: ROLE_PERMISSIONS[role].map((permissionKey) => ({ roleName: role, permissionKey })),
        skipDuplicates: true,
      });
    }
    if (config.ADMIN_ADDRESSES.length > 0) {
      await tx.adminRoleAssignment.createMany({
        data: config.ADMIN_ADDRESSES.map((walletAddress) => ({
          walletAddress,
          roleName: 'super_admin',
          assignedBy: 'ADMIN_ADDRESSES',
        })),
        skipDuplicates: true,
      });
    }
    logger.info(
      { admins: config.ADMIN_ADDRESSES.length, roles: ADMIN_ROLES.length },
      'Seeded admin RBAC from ADMIN_ADDRESSES',
    );
  });
  if (!result.acquired) {
    // Another instance is doing the first-boot seed. Wait briefly for its
    // transaction to commit so the first admin requests have a catalogue.
    logger.info('Admin RBAC seed is already in progress on another instance');
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if ((await prisma.adminRole.count()) > 0) return;
    }
    throw new Error('Admin RBAC seed did not complete; refusing to boot without a role catalogue');
  }
}

/**
 * In the test environment the in-memory or testcontainer database may not have
 * the RBAC seed; ADMIN_ADDRESSES keeps existing admin tests meaningful. This
 * fallback is test-only and never runs in development or production.
 */
function testBootstrapAccess(walletAddress: string): AdminAccess | null {
  if (config.NODE_ENV !== 'test') return null;
  if (!config.ADMIN_ADDRESSES.includes(walletAddress)) return null;
  return { roleName: 'super_admin', permissions: new Set<string>(ADMIN_PERMISSIONS) };
}

export async function adminAccessFor(walletAddress: string): Promise<AdminAccess | null> {
  const testAccess = testBootstrapAccess(walletAddress);
  if (testAccess) return testAccess;
  const assignment = await prisma.adminRoleAssignment.findUnique({
    where: { walletAddress },
    include: { role: { include: { permissions: { select: { permissionKey: true } } } } },
  });
  if (!assignment) return null;
  return {
    roleName: assignment.roleName as AdminRoleName,
    permissions: new Set<string>(assignment.role.permissions.map((p) => p.permissionKey)),
  };
}

export async function hasAdminPermission(walletAddress: string, permission: AdminPermission): Promise<boolean> {
  const access = await adminAccessFor(walletAddress);
  return access?.permissions.has(permission) ?? false;
}

async function actorRole(actor: string): Promise<AdminAccess> {
  const access = await adminAccessFor(actor);
  if (!access) throw new AppError(403, 'FORBIDDEN', 'This action is limited to OracleDesk admins');
  return access;
}

export async function listAdmins(): Promise<Array<{ walletAddress: string; roleName: string; assignedBy: string | null; createdAt: Date }>> {
  const rows = await prisma.adminRoleAssignment.findMany({
    orderBy: [{ roleName: 'asc' }, { createdAt: 'asc' }],
    select: { walletAddress: true, roleName: true, assignedBy: true, createdAt: true },
  });
  return rows.map((row) => ({ ...row, roleName: row.roleName }));
}

export async function listRoles(): Promise<Array<{ name: string; description: string | null; permissions: string[]; admins: number }>> {
  const roles = await prisma.adminRole.findMany({
    orderBy: { name: 'asc' },
    include: {
      permissions: { select: { permissionKey: true }, orderBy: { permissionKey: 'asc' } },
      _count: { select: { assignments: true } },
    },
  });
  return roles.map((role) => ({
    name: role.name,
    description: role.description,
    permissions: role.permissions.map((p) => p.permissionKey),
    admins: role._count.assignments,
  }));
}

export async function listAdminAudit(limit: number, skip: number): Promise<{ rows: unknown[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit, skip }),
    prisma.adminAuditLog.count(),
  ]);
  return { rows, total };
}

export async function grantAdminRole(params: {
  walletAddress: string;
  roleName: AdminRoleName;
  actor: string;
}): Promise<void> {
  const { walletAddress, roleName, actor } = params;
  if (!isAdminAddress(walletAddress)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'walletAddress must be a Stellar G… address');
  }
  if (!isAdminRole(roleName)) {
    throw new AppError(400, 'VALIDATION_ERROR', `roleName must be one of: ${ADMIN_ROLES.join(', ')}`);
  }

  const access = await actorRole(actor);
  const role = await prisma.adminRole.findUnique({
    where: { name: roleName },
    include: { permissions: { select: { permissionKey: true } } },
  });
  if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'Admin role not found');
  if (access.roleName !== 'super_admin') {
    const missing = role.permissions
      .map((p) => p.permissionKey)
      .filter((permission) => !access.permissions.has(permission));
    if (missing.length > 0) {
      throw new AppError(403, 'FORBIDDEN', 'Cannot grant a role with permissions you do not hold', { missing });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.adminRoleAssignment.upsert({
      where: { walletAddress },
      create: { walletAddress, roleName, assignedBy: actor },
      update: { roleName, assignedBy: actor },
    });
    await tx.adminAuditLog.create({
      data: {
        actor,
        action: 'ADMIN_ROLE_GRANTED',
        target: walletAddress,
        roleName,
        metadata: { roleName },
      },
    });
  });
}

export async function revokeAdminRole(params: { walletAddress: string; actor: string }): Promise<void> {
  const { walletAddress, actor } = params;
  if (!isAdminAddress(walletAddress)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'walletAddress must be a Stellar G… address');
  }
  const current = await prisma.adminRoleAssignment.findUnique({ where: { walletAddress } });
  if (!current) throw new AppError(404, 'ADMIN_NOT_FOUND', 'This address has no admin role');

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('admin:super_admin'))`;
    const locked = await tx.adminRoleAssignment.findUnique({ where: { walletAddress } });
    if (!locked) throw new AppError(404, 'ADMIN_NOT_FOUND', 'This address has no admin role');
    const another = await tx.adminRoleAssignment.findFirst({
      where: { roleName: 'super_admin', walletAddress: { not: walletAddress } },
      select: { id: true },
    });
    if (locked.roleName === 'super_admin' && !another) {
      throw new AppError(409, 'LAST_SUPER_ADMIN', 'Cannot revoke the last super admin');
    }
    await tx.adminRoleAssignment.delete({ where: { walletAddress } });
    await tx.adminAuditLog.create({
      data: {
        actor,
        action: 'ADMIN_ROLE_REVOKED',
        target: walletAddress,
        roleName: locked.roleName,
        metadata: { previousRole: locked.roleName },
      },
    });
  });
}
