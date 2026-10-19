import { config } from '../../config';
import { AppError } from '../../middlewares/error.middleware';
import type { OperationClass } from './fees';

/**
 * Transaction lifetime (#42). Every live write carries explicit timebounds
 * (minTime 0, maxTime = build time + the class timeout). Whether a missing
 * transaction has expired is decided from ledger time reported by RPC, never
 * from the host clock.
 */

export type ExpiryDecision = 'LANDED' | 'FAILED' | 'EXPIRED' | 'UNKNOWN' | 'PENDING';

/** Seconds of tolerance past maxTime before NOT_FOUND counts as expired. */
export const DEFAULT_EXPIRY_SKEW_SECONDS = 10;
/** Nominal ledger close time used to turn a deadline into a ledger count. */
export const NOMINAL_LEDGER_SECONDS = 5;

export interface DecideExpiryParams {
  status: string;
  /** latestLedgerCloseTime from the getTransaction response (unix seconds). */
  latestLedgerCloseTime: number;
  /** maxTime of the signed transaction (unix seconds). */
  maxTime: number;
  skewSeconds?: number;
  submittedLedger?: number | null;
  submittedAtCloseTime?: number | null;
  /** RPC retention floor from the same response. */
  oldestLedger?: number | null;
  oldestLedgerCloseTime?: number | null;
}

/**
 * Pure. LANDED on SUCCESS, FAILED on FAILED. For NOT_FOUND: UNKNOWN when the
 * submission is older than the RPC retention floor; PENDING until the latest
 * ledger close time is past maxTime + skew; then EXPIRED only if the
 * submission is provably inside the retention window, otherwise UNKNOWN.
 */
export function decideExpiry(p: DecideExpiryParams): ExpiryDecision {
  if (p.status === 'SUCCESS') return 'LANDED';
  if (p.status === 'FAILED') return 'FAILED';
  if (p.status !== 'NOT_FOUND') return 'PENDING';

  const skew = p.skewSeconds ?? DEFAULT_EXPIRY_SKEW_SECONDS;
  const byLedger = p.submittedLedger != null && p.oldestLedger != null ? p.submittedLedger >= p.oldestLedger : null;
  const byTime = p.submittedAtCloseTime != null && p.oldestLedgerCloseTime != null
    ? p.submittedAtCloseTime >= p.oldestLedgerCloseTime
    : null;
  if (byLedger === false || byTime === false) return 'UNKNOWN';

  if (!(p.latestLedgerCloseTime > p.maxTime + skew)) return 'PENDING';
  return byLedger === true || byTime === true ? 'EXPIRED' : 'UNKNOWN';
}

/** Configured timeout (seconds) for an operation class. */
export function timeoutFor(opClass: OperationClass): number {
  switch (opClass) {
    case 'market_create': return config.TIMEOUT_MARKET_CREATE_SECONDS;
    case 'trade': return config.TIMEOUT_TRADE_SECONDS;
    case 'trace_publish': return config.TIMEOUT_TRACE_PUBLISH_SECONDS;
    case 'maintenance': return config.TIMEOUT_MAINTENANCE_SECONDS;
  }
}

/**
 * Expiration ledger for an auth entry, derived from the transaction deadline:
 * the ledger expected to cover maxTime plus a margin. The entry therefore never
 * expires before its transaction can no longer be included, and outlives it by
 * at most `marginLedgers` (at the nominal close time).
 */
export function authExpirationLedger(p: {
  latestLedger: number;
  latestLedgerCloseTime: number;
  maxTime: number;
  marginLedgers?: number;
}): number {
  const margin = p.marginLedgers ?? config.AUTH_EXPIRY_MARGIN_LEDGERS;
  const remaining = Math.max(0, p.maxTime - p.latestLedgerCloseTime);
  return p.latestLedger + Math.ceil(remaining / NOMINAL_LEDGER_SECONDS) + margin;
}

export class ExpiredError extends AppError {
  constructor(
    message = 'Transaction expired without inclusion',
    public readonly attemptId?: string,
    public readonly txHash?: string | null,
  ) {
    super(504, 'CHAIN_TX_EXPIRED', message, { attemptId, txHash });
    this.name = 'ExpiredError';
  }
}
