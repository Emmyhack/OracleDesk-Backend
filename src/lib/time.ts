/** Start of the current UTC day. All allowance windows use UTC, not host TZ. */
export function utcDayStart(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Stellar RPC `createdAt` is ledger close time in Unix seconds. */
export function ledgerCloseDate(createdAt: number | null | undefined): Date | null {
  if (createdAt == null || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  return new Date(createdAt * 1000);
}

export const DAY_MS = 24 * 60 * 60 * 1000;
