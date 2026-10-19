import { Address, nativeToScVal, StrKey, xdr } from '@stellar/stellar-sdk';

/**
 * Synthetic transaction-meta builders for SAC `transfer` events (#51).
 *
 * These mirror what `getTransaction` returns on protocol 23+. Real captures
 * cannot be produced in CI (they need a funded testnet account), so the shapes
 * here are built with the same XDR constructors the RPC uses. See
 * tests/fixtures/payments/README.md for how to regenerate real ones.
 */

export interface TransferEventInput {
  contract: string;
  from: string;
  to: string;
  amount: bigint;
  asset?: string;
  /** CAP-67 muxed recipient id, which switches the data to a map. */
  toMuxedId?: string | bigint;
  /** Emit a different topic name (e.g. `mint`) to spoof a transfer. */
  name?: string;
  /** Override the event type (defaults to contract). */
  type?: 'contract' | 'diagnostic' | 'system';
  /** Override the contract id encoded in the event. */
  eventContract?: string;
}

function eventType(type: TransferEventInput['type']): xdr.ContractEventType {
  switch (type) {
    case 'diagnostic':
      return xdr.ContractEventType.diagnostic();
    case 'system':
      return xdr.ContractEventType.system();
    default:
      return xdr.ContractEventType.contract();
  }
}

// The runtime accepts the raw 32-byte hash; only the generated d.ts disagrees.
function eventContractId(contract: string): xdr.ContractId {
  return StrKey.decodeContract(contract) as unknown as xdr.ContractId;
}

/** Builds the legacy or CAP-67 data for a transfer event. */
export function transferEventData(amount: bigint, toMuxedId?: string | bigint): xdr.ScVal {
  if (toMuxedId === undefined) return nativeToScVal(amount, { type: 'i128' });
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: nativeToScVal(amount, { type: 'i128' }) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('to_muxed_id'),
      val: nativeToScVal(BigInt(toMuxedId), { type: 'u64' }),
    }),
  ]);
}

export function transferEvent(input: TransferEventInput): xdr.ContractEvent {
  const topics: xdr.ScVal[] = [
    xdr.ScVal.scvSymbol(input.name ?? 'transfer'),
    new Address(input.from).toScVal(),
    new Address(input.to).toScVal(),
  ];
  if (input.asset) topics.push(nativeToScVal(input.asset, { type: 'string' }));
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: eventContractId(input.eventContract ?? input.contract),
    type: eventType(input.type),
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data: transferEventData(input.amount, input.toMuxedId) })),
  });
}

function sorobanMeta(events: xdr.ContractEvent[]): xdr.SorobanTransactionMeta {
  return new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events,
    returnValue: xdr.ScVal.scvVoid(),
    diagnosticEvents: [],
  });
}

/** A v3 `TransactionMeta` carrying `events` in `sorobanMeta.events`. */
export function metaV3(events: xdr.ContractEvent[]): xdr.TransactionMeta {
  return new xdr.TransactionMeta(
    3,
    new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: sorobanMeta(events),
    }),
  );
}

/** A v4 `TransactionMeta` carrying `eventsByOp` on each operation. */
export function metaV4(eventsByOp: xdr.ContractEvent[][]): xdr.TransactionMeta {
  return new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: eventsByOp.map(
        (events) =>
          new xdr.OperationMetaV2({ ext: new xdr.ExtensionPoint(0), changes: [], events }),
      ),
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [],
    }),
  );
}

/** The RPC `events.contractEventsXdr` field (per operation). */
export function contractEventsField(eventsByOp: xdr.ContractEvent[][]): xdr.ContractEvent[][] {
  return eventsByOp;
}
