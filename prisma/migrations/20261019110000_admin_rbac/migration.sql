SET lock_timeout = '5s';

CREATE TABLE "admin_permissions" (
    "key" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "admin_roles" (
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("name")
);

CREATE TABLE "admin_role_permissions" (
    "roleName" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_role_permissions_pkey" PRIMARY KEY ("roleName", "permissionKey")
);

CREATE TABLE "admin_role_assignments" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "assignedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_role_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "roleName" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_role_assignments_walletAddress_key" ON "admin_role_assignments"("walletAddress");
CREATE INDEX "admin_role_assignments_roleName_idx" ON "admin_role_assignments"("roleName");
CREATE INDEX "admin_role_permissions_permissionKey_idx" ON "admin_role_permissions"("permissionKey");
CREATE INDEX "admin_audit_logs_createdAt_idx" ON "admin_audit_logs"("createdAt");
CREATE INDEX "admin_audit_logs_actor_createdAt_idx" ON "admin_audit_logs"("actor", "createdAt");
CREATE INDEX "admin_audit_logs_target_idx" ON "admin_audit_logs"("target");

ALTER TABLE "admin_role_permissions"
    ADD CONSTRAINT "admin_role_permissions_roleName_fkey"
    FOREIGN KEY ("roleName") REFERENCES "admin_roles"("name") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_role_permissions"
    ADD CONSTRAINT "admin_role_permissions_permissionKey_fkey"
    FOREIGN KEY ("permissionKey") REFERENCES "admin_permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_role_assignments"
    ADD CONSTRAINT "admin_role_assignments_roleName_fkey"
    FOREIGN KEY ("roleName") REFERENCES "admin_roles"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The audit trail is append-only at the database level, not just in the service.
CREATE OR REPLACE FUNCTION admin_audit_logs_immutable()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_logs_no_update
    BEFORE UPDATE ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION admin_audit_logs_immutable();

CREATE TRIGGER admin_audit_logs_no_delete
    BEFORE DELETE ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION admin_audit_logs_immutable();
