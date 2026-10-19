/**
 * Decodes Stellar Asset Contract (SEP-41) `transfer` events out of a
 * transaction's meta (#51).
 *
 * Payment verification must derive value movement from what the token
 * contract actually did, not from what the envelope asked for. The SAC emits
 * a `transfer` event for every executed transfer; it is recorded in the
 * transaction meta. This module turns those events into a flat list of
 * {@link SacTransfer}s, supporting both the legacy layout (topics
 * `[transfer, from, to, asset]`, `i128` data) and the CAP-67 unified layout
 * (map data with `amount` and `to_muxed_id`), and both `TransactionMeta` v3
 * and v4 as well as the RPC `events.contractEventsXdr` field.
 */
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';

export interface SacTransfer {
  /** C… contract that emitted the event. */
  contractId: string;
  /** Base G…/C… address the value moved from. */
  from: string;
  /** Base G…/C… address the value moved to. */
  to: string;
  amount: bigint;
  /** Muxed id of the recipient when present (CAP-67), else null. */
  toMuxedId: string | null;
  /** Operation index the event came from, when known. */
  opIndex: number | null;
  /** Asset string topic (`CODE:ISSUER`) when the event carried one. */
  asset: string | null;
}

export interface SacMetaInput {
  resultMetaXdr?: xdr.TransactionMeta | string | null;
  contractEventsXdr?: xdr.ContractEvent[][] | string[][] | null;
}

/** Accepts a parsed ContractEvent or its base64 form. */
function asContractEvent(ev: unknown): xdr.ContractEvent | null {
  if (!ev) return null;
  if (typeof ev === 'string') {
    try {
      return xdr.ContractEvent.fromXDR(ev, 'base64');
    } catch {
      return null;
    }
  }
  return ev as xdr.ContractEvent;
}

function normalizeMeta(meta: SacMetaInput['resultMetaXdr']): xdr.TransactionMeta | null {
  if (!meta) return null;
  if (typeof meta === 'string') {
    try {
      return xdr.TransactionMeta.fromXDR(meta, 'base64');
    } catch {
      return null;
    }
  }
  return meta;
}

/** Reads the string name of a contract-event type, tolerating mocks. */
function eventTypeName(ev: any): string | null {
  try {
    if (typeof ev?.type === 'function') {
      const t = ev.type();
      return typeof t === 'string' ? t : (t?.name ?? null);
    }
    if (typeof ev?.type === 'string') return ev.type;
  } catch {
    // fall through
  }
  return null;
}

/** Decodes one contract event into a transfer, or null when it is not one. */
export function decodeSacTransferEvent(ev: unknown, opIndex: number | null): SacTransfer | null {
  const event = asContractEvent(ev);
  if (!event) return null;
  try {
    const typeName = eventTypeName(event);
    if (typeName && typeName !== 'contract') return null;

    let contractId = '';
    const cid = typeof (event as any).contractId === 'function' ? (event as any).contractId() : null;
    if (cid) contractId = Address.fromScAddress(cid).toString();

    const body = typeof (event as any).body === 'function' ? (event as any).body() : null;
    const v0 = body && typeof body.v0 === 'function' ? body.v0() : null;
    const topics: xdr.ScVal[] | null =
      v0 && typeof v0.topics === 'function' ? v0.topics() : ((event as any).topics ?? null);
    const data: xdr.ScVal | null =
      v0 && typeof v0.data === 'function' ? v0.data() : ((event as any).data ?? null);
    if (!topics || topics.length < 3 || !data) return null;

    let name: unknown;
    try {
      name = scValToNative(topics[0]);
    } catch {
      return null;
    }
    if (name !== 'transfer') return null;

    let from: string;
    let to: string;
    try {
      from = Address.fromScVal(topics[1]).toString();
      to = Address.fromScVal(topics[2]).toString();
    } catch {
      return null;
    }

    let asset: string | null = null;
    if (topics.length >= 4) {
      try {
        const a = scValToNative(topics[3]);
        asset = typeof a === 'string' ? a : null;
      } catch {
        asset = null;
      }
    }

    const decoded = decodeAmount(data);
    if (decoded === null) return null;

    return {
      contractId,
      from,
      to,
      amount: decoded.amount,
      toMuxedId: decoded.toMuxedId,
      opIndex,
      asset,
    };
  } catch {
    return null;
  }
}

/** Reads the amount (and optional muxed id) from legacy or CAP-67 event data. */
function decodeAmount(data: xdr.ScVal): { amount: bigint; toMuxedId: string | null } | null {
  let switchName: string | null = null;
  try {
    const sw = typeof (data as any).switch === 'function' ? (data as any).switch() : null;
    switchName = typeof sw === 'string' ? sw : (sw?.name ?? null);
  } catch {
    switchName = null;
  }

  if (switchName === 'scvMap') {
    const entries = typeof (data as any).map === 'function' ? (data as any).map() : null;
    if (!Array.isArray(entries)) return null;
    let amount: bigint | null = null;
    let toMuxedId: string | null = null;
    for (const entry of entries) {
      let key: unknown;
      const val = typeof entry.val === 'function' ? entry.val() : entry.val;
      try {
        key = scValToNative(entry.key());
      } catch {
        continue;
      }
      if (key === 'amount') {
        const n = scValToNative(val);
        if (typeof n === 'bigint') amount = n;
      } else if (key === 'to_muxed_id') {
        const id = scValToNative(val);
        toMuxedId = typeof id === 'bigint' ? id.toString() : String(id);
      }
    }
    return amount === null ? null : { amount, toMuxedId };
  }

  const native = scValToNative(data);
  if (typeof native === 'bigint') return { amount: native, toMuxedId: null };
  return null;
}

/** Events declared directly on a v4 `OperationMetaV2`. */
function decodeContractEvents(events: unknown[], opIndex: number | null): SacTransfer[] {
  const out: SacTransfer[] = [];
  for (const ev of events) {
    const transfer = decodeSacTransferEvent(ev, opIndex);
    if (transfer) out.push(transfer);
  }
  return out;
}

/**
 * Extracts SAC `transfer` events from a transaction response.
 *
 * `contractEventsXdr` (per operation, RPC ≥ 23) is preferred when it carries
 * events; otherwise the events are read from `resultMetaXdr` (v3
 * `sorobanMeta.events`, v4 per-operation `events`). Diagnostic events are
 * never considered.
 */
export function sacTransfersFromMeta(input: SacMetaInput): SacTransfer[] {
  const out: SacTransfer[] = [];

  const contractEvents = input.contractEventsXdr;
  if (Array.isArray(contractEvents) && contractEvents.some((ops) => Array.isArray(ops) && ops.length > 0)) {
    contractEvents.forEach((ops, i) => {
      if (!Array.isArray(ops)) return;
      out.push(...decodeContractEvents(ops, i));
    });
    return out;
  }

  const meta = normalizeMeta(input.resultMetaXdr);
  if (!meta) return out;

  let switchValue: number | null = null;
  try {
    switchValue = typeof (meta as any).switch === 'function' ? (meta as any).switch() : null;
  } catch {
    switchValue = null;
  }

  if (switchValue === 3) {
    try {
      const sorobanMeta = (meta as any).v3().sorobanMeta();
      const events = sorobanMeta && typeof sorobanMeta.events === 'function' ? sorobanMeta.events() : [];
      out.push(...decodeContractEvents(events ?? [], null));
    } catch {
      // malformed meta: no transfers
    }
  } else if (switchValue === 4) {
    try {
      const operations = (meta as any).v4().operations() ?? [];
      operations.forEach((op: any, i: number) => {
        const events = op && typeof op.events === 'function' ? op.events() : [];
        out.push(...decodeContractEvents(events ?? [], i));
      });
    } catch {
      // malformed meta: no transfers
    }
  }

  return out;
}
