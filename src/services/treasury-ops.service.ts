/**
 * Treasury admin operations console (#156).
 *
 * The backend never holds the treasury admin key. It prepares unsigned,
 * simulated transactions for the on-chain admin (or multisig) to sign, merges
 * verified signatures, and submits only a transaction whose hash matches the
 * prepared body.
 */
import {
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  Networks,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';
import { config } from '../config';
import { CONTRACTS } from '../config/contracts';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { formatUsdc, parseU64, parseUsdc } from '../lib/amounts';
import { AppError } from '../middlewares/error.middleware';
import { TreasuryClient, MarketCoreClient, rpcServer } from './stellar/clients';
import { contractErrorName } from './stellar/errors';
import {
  getOnChainMarket,
  marketCoreConfig,
  treasuryAvailableCapital,
  treasuryConfig,
  treasuryDailyUsage,
} from './chain.service';
import type { RiskConfig } from '../generated/treasury';

export type AdminOp =
  | { kind: 'treasury.set_paused'; paused: boolean }
  | { kind: 'treasury.withdraw'; to: string; amountRaw: string }
  | { kind: 'treasury.deposit'; from: string; amountRaw: string }
  | { kind: 'treasury.collect_market_fees'; onChainMarketId: string }
  | { kind: 'market_core.set_paused'; paused: boolean };

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  critical?: boolean;
}

export interface AccountSigner {
  key: string;
  kind: 'ed25519' | 'preAuthTx' | 'hashX';
  weight: number;
}

export interface AccountState {
  address: string;
  kind: 'account' | 'contract';
  balanceXlm: string | null;
  masterWeight: number;
  thresholds: { low: number; medium: number; high: number };
  signers: AccountSigner[];
}

export interface TreasuryState {
  network: string;
  contracts: { treasury: string; marketCore: string; usdc: string };
  treasury: {
    config: RiskConfig | null;
    availableCapitalRaw: string;
    usdcBalanceRaw: string;
    dailyUsage: { amountRaw: string; dayStart: number; resetsAt: string; remainingRaw: string };
    paused: boolean | null;
    admin: { address: string; kind: 'account' | 'contract' } | null;
  };
  marketCore: { paused: boolean | null; admin: string | null };
  agent: { address: string; xlmBalance: string | null };
}

export interface PreparedOperation {
  id: string;
  kind: string;
  xdr: string;
  networkPassphrase: string;
  hash: string;
  expiresAt: string;
  requiredSigners: number;
  thresholds: AccountState['thresholds'];
  checks: PreflightCheck[];
  humanSummary: string;
  status: string;
}

export interface SignatureRecord {
  signer: string;
  hint: string;
  signature: string;
  addedAt: string;
  addedBy: string;
}

export interface OpsDeps {
  state?: () => Promise<TreasuryState>;
  build?: (op: AdminOp, state: TreasuryState) => Promise<{ xdr: string; hash: string; contractId: string; sourceAccount: string }>;
  submit?: (xdr: string) => Promise<{ status: string; hash: string; ledger?: number; resultXdr?: string; error?: unknown }>;
  now?: () => number;
  account?: (address: string) => Promise<AccountState>;
}

const TREASURY_EVENT = 'ADMIN_OP';

function nowMs(deps?: OpsDeps): number {
  return deps?.now ? deps.now() : Date.now();
}

function signerKind(key: xdr.SignerKey): AccountSigner['kind'] {
  try {
    if (key.switch().name === 'signerKeyTypeEd25519') return 'ed25519';
    if (key.switch().name === 'signerKeyTypePreAuthTx') return 'preAuthTx';
    return 'hashX';
  } catch {
    return 'hashX';
  }
}

function signerKeyString(key: xdr.SignerKey): string {
  const kind = signerKind(key);
  if (kind === 'ed25519') return StrKey.encodeEd25519PublicKey(key.ed25519());
  if (kind === 'preAuthTx') return Buffer.from(key.preAuthTx()).toString('hex');
  return Buffer.from(key.hashX()).toString('hex');
}

function serialiseInstanceKey(key: xdr.ScVal): string | null {
  try {
    const native = scValToNative(key) as unknown;
    if (typeof native === 'string') return native;
    if (Array.isArray(native) && native.length > 0 && typeof native[0] === 'string') return native[0];
    if (native && typeof native === 'object' && 'tag' in native) return String((native as { tag: unknown }).tag);
    return null;
  } catch {
    return null;
  }
}

async function readInstanceStorage(contractId: string): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  try {
    const key = (xdr.LedgerKey.contractData as any)({
      contract: new Contract(contractId).address(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    });
    const res = await rpcServer.getLedgerEntries(key);
    const entry = res.entries?.[0];
    const storage = entry?.val.contractData().val().instance().storage();
    if (!storage) return map;
    for (const item of storage) {
      const name = serialiseInstanceKey(item.key());
      if (name) map.set(name, scValToNative(item.val()));
    }
  } catch (err) {
    logger.warn({ err, contractId }, 'Unable to read contract instance storage');
  }
  return map;
}

async function readAccount(address: string): Promise<AccountState> {
  const base: AccountState = {
    address,
    kind: 'account',
    balanceXlm: null,
    masterWeight: 0,
    thresholds: { low: 0, medium: 0, high: 0 },
    signers: [],
  };
  if (StrKey.isValidContract(address)) {
    return { ...base, kind: 'contract' };
  }
  try {
    const res = await rpcServer.getLedgerEntries((xdr.LedgerKey.account as any)({ accountId: address }));
    const account = res.entries?.[0]?.val.account();
    if (!account) return base;
    const thresholds = account.thresholds();
    return {
      address,
      kind: 'account',
      balanceXlm: account.balance().toString(),
      masterWeight: thresholds[0] ?? 0,
      thresholds: { low: thresholds[1] ?? 0, medium: thresholds[2] ?? 0, high: thresholds[3] ?? 0 },
      signers: account.signers().map((s) => ({
        key: signerKeyString(s.key()),
        kind: signerKind(s.key()),
        weight: s.weight(),
      })),
    };
  } catch (err) {
    logger.warn({ err, address }, 'Unable to read account state');
    return base;
  }
}

/** Reads live treasury, market-core and account state for the console. */
export async function getTreasuryState(deps: OpsDeps = {}): Promise<TreasuryState> {
  if (deps.state) return deps.state();

  const [risk, usage, available, marketCfg, instance] = await Promise.all([
    treasuryConfig().catch(() => null),
    treasuryDailyUsage().catch(() => null),
    treasuryAvailableCapital().catch(() => 0n),
    marketCoreConfig().catch(() => null),
    readInstanceStorage(CONTRACTS.treasury),
  ]);

  const adminAddress = typeof instance.get('Admin') === 'string' ? String(instance.get('Admin')) : null;
  const paused = typeof instance.get('Paused') === 'boolean' ? Boolean(instance.get('Paused')) : null;
  const adminAccount = adminAddress ? await readAccount(adminAddress) : null;
  const agentAddress = risk?.agent ?? '';
  const agentAccount = agentAddress ? await readAccount(agentAddress) : null;

  const amountRaw = BigInt(usage?.amount ?? 0);
  const maxDaily = BigInt(risk?.max_daily ?? 0);
  const remaining = maxDaily > amountRaw ? maxDaily - amountRaw : 0n;
  const dayStart = Number(usage?.day_start ?? 0);
  const resetsAt = new Date((dayStart + 86_400) * 1000).toISOString();

  return {
    network: config.STELLAR_NETWORK_PASSPHRASE,
    contracts: { treasury: CONTRACTS.treasury, marketCore: CONTRACTS.marketCore, usdc: CONTRACTS.usdc },
    treasury: {
      config: risk,
      availableCapitalRaw: available.toString(),
      usdcBalanceRaw: available.toString(),
      dailyUsage: { amountRaw: amountRaw.toString(), dayStart, resetsAt, remainingRaw: remaining.toString() },
      paused,
      admin: adminAddress ? { address: adminAddress, kind: adminAccount?.kind ?? 'account' } : null,
    },
    marketCore: { paused: marketCfg?.paused ?? null, admin: marketCfg?.admin ?? null },
    agent: { address: agentAddress, xlmBalance: agentAccount?.balanceXlm ?? null },
  };
}

function humanUsdc(raw: string): string {
  const value = BigInt(raw);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, '0');
  return `${whole.toLocaleString('en-US')}.${fraction}`;
}

export function humanSummary(op: AdminOp): string {
  switch (op.kind) {
    case 'treasury.withdraw':
      return `Withdraw ${humanUsdc(op.amountRaw)} USDC from treasury ${CONTRACTS.treasury} to ${op.to}`;
    case 'treasury.deposit':
      return `Deposit ${humanUsdc(op.amountRaw)} USDC into treasury ${CONTRACTS.treasury} from ${op.from}`;
    case 'treasury.set_paused':
      return `${op.paused ? 'Pause' : 'Unpause'} treasury ${CONTRACTS.treasury}`;
    case 'treasury.collect_market_fees':
      return `Collect accrued fees from market ${op.onChainMarketId} into treasury ${CONTRACTS.treasury}`;
    case 'market_core.set_paused':
      return `${op.paused ? 'Pause' : 'Unpause'} market-core ${CONTRACTS.marketCore}`;
  }
}

function validateOp(op: AdminOp): void {
  if (op.kind === 'treasury.withdraw') {
    parseUsdc(formatUsdcSafe(op.amountRaw));
    if (!StrKey.isValidEd25519PublicKey(op.to) && !StrKey.isValidContract(op.to)) {
      throw new AppError(400, 'INVALID_DESTINATION', 'to must be a G… account or C… contract');
    }
  }
  if (op.kind === 'treasury.deposit') {
    parseUsdc(formatUsdcSafe(op.amountRaw));
    if (!StrKey.isValidEd25519PublicKey(op.from)) {
      throw new AppError(400, 'INVALID_SOURCE', 'from must be a G… account');
    }
  }
  if (op.kind === 'treasury.collect_market_fees' && parseU64(op.onChainMarketId) === null) {
    throw new AppError(400, 'INVALID_MARKET_ID', 'onChainMarketId must be a u64 decimal string');
  }
}

function formatUsdcSafe(raw: string): string {
  if (!/^\d+$/.test(raw)) throw new AppError(400, 'INVALID_AMOUNT', 'amountRaw must be an integer string');
  return formatUsdc(BigInt(raw));
}

async function checkTrustline(destination: string): Promise<PreflightCheck> {
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    return { name: 'destination_trustline', ok: true, detail: 'contract destination; trustline not applicable' };
  }
  try {
    const res = await rpcServer.getLedgerEntries((xdr.LedgerKey.account as any)({ accountId: destination }));
    const account = res.entries?.[0]?.val.account();
    if (!account) return { name: 'destination_trustline', ok: false, detail: 'destination account not found' };
    return { name: 'destination_trustline', ok: true, detail: 'destination account exists (trustline checked on simulation)' };
  } catch {
    return { name: 'destination_trustline', ok: true, detail: 'could not read destination; simulation will decide', critical: false };
  }
}

// Soroban invokeHostFunction operations use the account's HIGH threshold.
export const REQUIRED_THRESHOLD_CATEGORY = 'invokeHostFunction';

export async function prepareOperation(
  op: AdminOp,
  requestedBy: string,
  deps: OpsDeps = {},
): Promise<PreparedOperation> {
  validateOp(op);
  const state = deps.state ? await deps.state() : await getTreasuryState(deps);
  const admin = state.treasury.admin;
  if (!admin) throw new AppError(503, 'TREASURY_ADMIN_UNAVAILABLE', 'Could not read the on-chain treasury admin');
  if (admin.kind === 'contract') {
    throw new AppError(501, 'UNSUPPORTED_ADMIN_KIND', 'Contract (C…) admin wallets require auth-entry signing and are not supported by this console');
  }

  const sourceAccount = op.kind === 'treasury.deposit' ? op.from : admin.address;
  const account = deps.account ? await deps.account(sourceAccount) : await readAccount(sourceAccount);
  const threshold = account.thresholds.high;
  const required = Math.max(1, threshold, op.kind === 'treasury.withdraw' ? config.TREASURY_WITHDRAW_MIN_SIGNERS : 0);

  const checks: PreflightCheck[] = [];
  const available = BigInt(state.treasury.availableCapitalRaw);
  if (op.kind === 'treasury.withdraw') {
    const amount = BigInt(op.amountRaw);
    checks.push({
      name: 'amount_within_available_capital',
      ok: amount <= available,
      detail: `${formatUsdc(amount)} requested, ${formatUsdc(available)} available`,
      critical: true,
    });
    checks.push({
      name: 'destination_not_internal',
      ok: op.to !== CONTRACTS.treasury && op.to !== CONTRACTS.marketCore,
      detail: 'withdrawing to the treasury/market-core contract would lock the funds',
      critical: true,
    });
    checks.push(await checkTrustline(op.to));
    const remainingAfter = available > amount ? available - amount : 0n;
    const maxDaily = BigInt(state.treasury.config?.max_daily ?? 0);
    if (maxDaily > 0n && remainingAfter < maxDaily) {
      checks.push({
        name: 'capital_below_daily_cap',
        ok: true,
        detail: `warning: remaining capital ${formatUsdc(remainingAfter)} is below max_daily ${formatUsdc(maxDaily)}`,
        critical: false,
      });
    }
  }
  if (op.kind === 'treasury.collect_market_fees') {
    try {
      const market = await getOnChainMarket(BigInt(op.onChainMarketId));
      checks.push({
        name: 'market_has_fees',
        ok: BigInt(market.fees_accrued) > 0n,
        detail: `${market.fees_accrued.toString()} base units accrued`,
        critical: true,
      });
    } catch (err) {
      checks.push({ name: 'market_readable', ok: false, detail: err instanceof Error ? err.message : String(err), critical: true });
    }
  }

  const blocking = checks.some((c) => !c.ok && c.critical !== false);
  if (blocking) {
    throw new AppError(422, 'PREFLIGHT_FAILED', 'Pre-flight checks failed', { checks });
  }

  const built = deps.build
    ? await deps.build(op, state)
    : await buildUnsigned(op, sourceAccount, admin.address);
  checks.unshift({
    name: 'simulation',
    ok: true,
    detail: 'simulation succeeded; footprint, resource fee and auth entries assembled',
    critical: true,
  });

  const now = nowMs(deps);
  const expiresAt = new Date(now + config.TREASURY_OP_TTL_SECONDS * 1000);
  const row = await prisma.adminOperation.create({
    data: {
      kind: op.kind,
      params: op as unknown as object,
      contractId: built.contractId,
      sourceAccount: built.sourceAccount,
      unsignedXdr: built.xdr,
      txHash: built.hash,
      status: 'PREPARED',
      requestedBy,
      expiresAt,
    },
  });
  await audit(row.id, 'PREPARED', requestedBy, { kind: op.kind, checks });

  return {
    id: row.id,
    kind: op.kind,
    xdr: built.xdr,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    hash: built.hash,
    expiresAt: expiresAt.toISOString(),
    requiredSigners: required,
    thresholds: account.thresholds,
    checks,
    humanSummary: humanSummary(op),
    status: 'PREPARED',
  };
}

async function buildUnsigned(
  op: AdminOp,
  sourceAccount: string,
  adminAddress: string,
): Promise<{ xdr: string; hash: string; contractId: string; sourceAccount: string }> {
  const options = { timeoutInSeconds: config.TREASURY_OP_TTL_SECONDS };
  let tx: AssembledTransaction<unknown>;
  let contractId: string;

  if (op.kind === 'market_core.set_paused') {
    contractId = CONTRACTS.marketCore;
    const client = new MarketCoreClient({
      contractId,
      rpcUrl: config.STELLAR_RPC_URL,
      networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
      publicKey: sourceAccount,
    });
    tx = await client.set_paused({ paused: op.paused }, options);
  } else {
    contractId = CONTRACTS.treasury;
    const client = new TreasuryClient({
      contractId,
      rpcUrl: config.STELLAR_RPC_URL,
      networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
      publicKey: sourceAccount,
    });
    if (op.kind === 'treasury.set_paused') tx = await client.set_paused({ paused: op.paused }, options);
    else if (op.kind === 'treasury.withdraw') tx = await client.withdraw({ to: op.to, amount: BigInt(op.amountRaw) }, options);
    else if (op.kind === 'treasury.deposit') tx = await client.deposit({ from: op.from, amount: BigInt(op.amountRaw) }, options);
    else tx = await client.collect_market_fees({ market_id: BigInt(op.onChainMarketId) }, options);
  }

  const simError = (tx.simulation as { error?: string } | undefined)?.error;
  if (simError) {
    throw new AppError(422, 'SIMULATION_FAILED', 'Transaction simulation failed', {
      contractError: contractErrorName(op.kind.startsWith('market_core') ? 'marketCore' : 'treasury', simError, simError),
    });
  }
  if (!tx.built) throw new AppError(502, 'BUILD_FAILED', 'Simulation did not produce a transaction envelope');
  return {
    xdr: tx.toXDR(),
    hash: tx.built.hash().toString('hex'),
    contractId,
    sourceAccount,
  };
}

async function audit(operationId: string, state: string, actor: string, data?: Record<string, unknown>): Promise<void> {
  await prisma.agentLog
    .create({
      data: {
        agentType: 'TRADER',
        level: state === 'FAILED' ? 'ERROR' : 'INFO',
        action: `${TREASURY_EVENT}_${state}`,
        data: { operationId, actor, ...data } as object,
      },
    })
    .catch((err) => logger.error({ err, operationId }, 'Failed to write admin operation audit entry'));
}

function parseSignatures(row: { signatures: unknown }): SignatureRecord[] {
  return Array.isArray(row.signatures) ? (row.signatures as unknown as SignatureRecord[]) : [];
}

/** Merges a signed XDR into the prepared operation after hash/signature checks. */
export async function addSignature(
  operationId: string,
  signedXdr: string,
  addedBy: string,
  deps: OpsDeps = {},
): Promise<{ status: string; weightCollected: number; requiredSigners: number; signatures: SignatureRecord[] }> {
  const row = await prisma.adminOperation.findUnique({ where: { id: operationId } });
  if (!row) throw new AppError(404, 'ADMIN_OP_NOT_FOUND', 'Admin operation not found');
  const now = nowMs(deps);
  if (row.expiresAt.getTime() <= now || row.status === 'EXPIRED') {
    await prisma.adminOperation.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
    await audit(row.id, 'EXPIRED', addedBy);
    throw new AppError(410, 'ADMIN_OP_EXPIRED', 'This operation has expired; prepare a new one');
  }
  if (!['PREPARED', 'PARTIALLY_SIGNED'].includes(row.status)) {
    throw new AppError(409, 'ADMIN_OP_NOT_SIGNABLE', `Operation is ${row.status}`);
  }

  let incoming: unknown;
  try {
    incoming = TransactionBuilder.fromXDR(signedXdr, config.STELLAR_NETWORK_PASSPHRASE);
  } catch {
    throw new AppError(400, 'INVALID_SIGNED_XDR', 'signedXdr is not a valid Stellar transaction envelope');
  }
  const incomingTx = incoming as { hash(): Buffer; signatures?: Array<{ hint(): Buffer; signature(): Buffer }> };
  const hashHex = incomingTx.hash().toString('hex');
  if (hashHex !== row.txHash) {
    throw new AppError(409, 'ADMIN_OP_HASH_MISMATCH', 'Signed transaction body does not match the prepared operation');
  }

  const admin = (row.sourceAccount && (deps.account ? await deps.account(row.sourceAccount) : await readAccount(row.sourceAccount))) || null;
  if (!admin) throw new AppError(503, 'ADMIN_STATE_UNAVAILABLE', 'Could not read the admin account state');

  const existing = parseSignatures(row);
  const seenSigners = new Set(existing.map((s) => s.signer));
  const records = [...existing];
  const required = Math.max(
    1,
    admin.thresholds.high,
    row.kind === 'treasury.withdraw' ? config.TREASURY_WITHDRAW_MIN_SIGNERS : 0,
  );

  const candidates: AccountSigner[] = [
    ...(admin.masterWeight > 0 ? [{ key: admin.address, kind: 'ed25519' as const, weight: admin.masterWeight }] : []),
    ...admin.signers,
  ];

  for (const sig of incomingTx.signatures ?? []) {
    const hint = sig.hint();
    const match = candidates.find((candidate) => {
      if (candidate.kind !== 'ed25519') return false;
      try {
        return Keypair.fromPublicKey(candidate.key).signatureHint().equals(hint);
      } catch {
        return false;
      }
    });
    if (!match || seenSigners.has(match.key)) continue;
    let valid = false;
    try {
      valid = Keypair.fromPublicKey(match.key).verify(incomingTx.hash(), sig.signature());
    } catch {
      valid = false;
    }
    if (!valid) continue;
    seenSigners.add(match.key);
    records.push({
      signer: match.key,
      hint: hint.toString('hex'),
      signature: sig.signature().toString('base64'),
      addedAt: new Date(now).toISOString(),
      addedBy,
    });
  }

  // Rebuild the envelope with every accepted signature.
  const merged = TransactionBuilder.fromXDR(row.unsignedXdr, config.STELLAR_NETWORK_PASSPHRASE) as unknown as {
    addDecoratedSignature(sig: unknown): void;
  };
  for (const record of records) {
    merged.addDecoratedSignature(
      new xdr.DecoratedSignature({ hint: Buffer.from(record.hint, 'hex'), signature: Buffer.from(record.signature, 'base64') }),
    );
  }
  const weightCollected = records.reduce((sum, record) => {
    const signer = candidates.find((candidate) => candidate.key === record.signer);
    return sum + (signer?.weight ?? 0);
  }, 0);

  const status = weightCollected >= required ? 'READY' : 'PARTIALLY_SIGNED';
  const signedXdrOut = (merged as unknown as { toXDR(): string }).toXDR();
  await prisma.adminOperation.update({
    where: { id: row.id },
    data: {
      signedXdr: signedXdrOut,
      signatures: records as unknown as object,
      weightCollected,
      status,
    },
  });
  await audit(row.id, status, addedBy, { weightCollected, required });

  return { status, weightCollected, requiredSigners: required, signatures: records };
}

/** Submits a READY operation and records its final result. No server key is used. */
export async function submitOperation(
  operationId: string,
  deps: OpsDeps = {},
): Promise<{ status: string; ledger?: number; resultXdr?: string; hash: string }> {
  const row = await prisma.adminOperation.findUnique({ where: { id: operationId } });
  if (!row) throw new AppError(404, 'ADMIN_OP_NOT_FOUND', 'Admin operation not found');
  const now = nowMs(deps);
  if (row.expiresAt.getTime() <= now) {
    await prisma.adminOperation.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
    await audit(row.id, 'EXPIRED', 'system');
    throw new AppError(410, 'ADMIN_OP_EXPIRED', 'This operation has expired; prepare a new one');
  }
  if (row.status !== 'READY' || !row.signedXdr) {
    throw new AppError(409, 'ADMIN_OP_NOT_READY', `Operation is ${row.status}; collect enough signatures first`);
  }
  if (config.STELLAR_NETWORK_PASSPHRASE !== Networks.TESTNET) {
    throw new AppError(403, 'TESTNET_ONLY', 'Admin submission is testnet-only');
  }

  const result = deps.submit
    ? await deps.submit(row.signedXdr)
    : await submitToRpc(row.signedXdr);

  const success = result.status === 'SUCCESS';
  await prisma.adminOperation.update({
    where: { id: row.id },
    data: {
      status: success ? 'SUCCESS' : 'FAILED',
      resultXdr: result.resultXdr,
      ledger: result.ledger,
      error: result.error !== undefined ? (result.error as object) : undefined,
    },
  });
  await audit(row.id, success ? 'SUCCESS' : 'FAILED', 'system', { hash: result.hash, ledger: result.ledger });
  return result;
}

async function submitToRpc(signedXdr: string): Promise<{ status: string; ledger?: number; resultXdr?: string; hash: string; error?: unknown }> {
  const tx = TransactionBuilder.fromXDR(signedXdr, config.STELLAR_NETWORK_PASSPHRASE);
  const hash = tx.hash().toString('hex');
  const sent = await rpcServer.sendTransaction(tx);
  if (sent.status === 'ERROR') {
    return { status: 'FAILED', hash, error: sent.errorResult ?? sent };
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await rpcServer.getTransaction(hash);
    if (result.status !== 'NOT_FOUND') {
      const done = result as any;
      return {
        status: result.status,
        hash,
        ledger: done.ledger,
        resultXdr: done.resultXdr?.toXDR?.('base64') ?? undefined,
        error: result.status === 'FAILED' ? done.resultXdr : undefined,
      };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { status: 'FAILED', hash, error: { message: 'Timed out waiting for the transaction result' } };
}

export async function recordSubmitted(operationId: string, txHash: string, actor: string): Promise<void> {
  const row = await prisma.adminOperation.findUnique({ where: { id: operationId } });
  if (!row) throw new AppError(404, 'ADMIN_OP_NOT_FOUND', 'Admin operation not found');
  const result = await rpcServer.getTransaction(txHash);
  const done = result as any;
  const success = result.status === 'SUCCESS';
  await prisma.adminOperation.update({
    where: { id: row.id },
    data: {
      status: success ? 'SUCCESS' : result.status === 'NOT_FOUND' ? 'SUBMITTED' : 'FAILED',
      resultXdr: done.resultXdr?.toXDR?.('base64') ?? undefined,
      ledger: done.ledger,
    },
  });
  await audit(row.id, success ? 'SUCCESS' : 'SUBMITTED', actor, { txHash });
}

export async function cancelOperation(operationId: string, actor: string): Promise<void> {
  const row = await prisma.adminOperation.findUnique({ where: { id: operationId } });
  if (!row) throw new AppError(404, 'ADMIN_OP_NOT_FOUND', 'Admin operation not found');
  if (['SUBMITTED', 'SUCCESS', 'FAILED', 'EXPIRED'].includes(row.status)) {
    throw new AppError(409, 'ADMIN_OP_NOT_CANCELLABLE', `Operation is ${row.status}`);
  }
  await prisma.adminOperation.update({ where: { id: row.id }, data: { status: 'CANCELLED' } });
  await audit(row.id, 'CANCELLED', actor);
}

export async function getOperation(operationId: string) {
  const row = await prisma.adminOperation.findUnique({ where: { id: operationId } });
  if (!row) throw new AppError(404, 'ADMIN_OP_NOT_FOUND', 'Admin operation not found');
  return row;
}

export async function listOperations(page: number, limit: number) {
  const [rows, total] = await Promise.all([
    prisma.adminOperation.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.adminOperation.count(),
  ]);
  return { rows, total };
}
