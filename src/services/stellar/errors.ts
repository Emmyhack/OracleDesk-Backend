import { Errors as MarketCoreErrors } from '../../generated/market-core';
import { Errors as TreasuryErrors } from '../../generated/treasury';
import { Errors as ResolverErrors } from '../../generated/resolver';
import { Errors as ReasoningRegistryErrors } from '../../generated/reasoning-registry';
import { AppError } from '../../middlewares/error.middleware';

const TABLES: Record<string, Record<number, { message: string }>> = {
  marketCore: MarketCoreErrors,
  treasury: TreasuryErrors,
  resolver: ResolverErrors,
  reasoningRegistry: ReasoningRegistryErrors,
};

/**
 * Name of a contract error, e.g. "SlippageExceeded".
 *
 * The SDK's `Err` takes its message from the spec's doc strings, which are
 * empty for these contracts, so the reliable source is the "Error(Contract,
 * #N)" code in the simulation/host error text, looked up in the binding's
 * `Errors` table.
 */
export function contractErrorName(contract: keyof typeof TABLES, err: unknown, hostErrorText?: string): string | null {
  const text = [hostErrorText ?? '', err instanceof Error ? err.message : String(err)].join(' ');
  const match = text.match(/Error\(Contract, #(\d+)\)/);
  if (match) return TABLES[contract][Number(match[1])]?.message ?? `ContractError${match[1]}`;
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error?: { message?: string } }).error;
    if (inner?.message) return inner.message;
  }
  return null;
}

export class ChainError extends AppError {
  constructor(
    message: string,
    public readonly contractError: string | null,
    details?: Record<string, unknown>,
    code = 'CHAIN_ERROR',
  ) {
    super(502, code, message, { contractError, ...details });
    this.name = 'ChainError';
  }
}

/**
 * Terminal failure of a live write (#40). Carries the classified failure so
 * callers can distinguish genuinely retryable from permanent without parsing
 * message text.
 */
export class TransactionError extends ChainError {
  constructor(
    message: string,
    failure: {
      class: string;
      txCode: string | null;
      opCode: string | null;
      contractError: string | null;
      txHash: string | null;
      submitted: boolean;
    },
    attempts: number,
  ) {
    super(message, failure.contractError, {
      failureClass: failure.class,
      txCode: failure.txCode,
      opCode: failure.opCode,
      txHash: failure.txHash,
      submitted: failure.submitted,
      attempts,
    }, 'CHAIN_TX_FAILED');
    this.name = 'TransactionError';
  }
}

/**
 * A live write was submitted but its outcome was not confirmed within the
 * inline wait (#35). The outbox row owns resolution from here: the recovery
 * worker confirms, fails or expires it and runs the completion handler.
 * Callers record an intermediate state (e.g. a Trade stays PENDING), never a
 * failure.
 */
export class ChainPendingError extends AppError {
  constructor(
    message: string,
    public readonly outboxId: string,
    public readonly txHash: string | null,
  ) {
    super(502, 'CHAIN_PENDING', message, { outboxId, txHash });
    this.name = 'ChainPendingError';
  }
}

export class ArchivedEntryError extends AppError {
  constructor(message = 'Entry is archived on-chain', details?: Record<string, unknown>) {
    super(410, 'ARCHIVED_ENTRY', message, details);
    this.name = 'ArchivedEntryError';
  }
}
