/**
 * Contract spec compatibility gate (#34).
 *
 * The backend assumes the contracts at the CONTRACTS addresses run exactly
 * the wasm the bindings in src/generated/ were generated from; nothing else
 * checks this, and drift fails late and confusingly (MissingValue on renamed
 * entrypoints, half-decoded structs, parseEvent returning null or throwing).
 *
 * Every deployed Soroban contract carries its interface: the wasm has a
 * `contractspecv0` custom section with the same ScSpecEntry XDR the bindings
 * embed as base64, and the contract instance records its wasm hash. At boot
 * this module fetches each deployed contract's wasm hash and embedded spec,
 * diffs them structurally (docs ignored) against the synced binding, and
 * classifies each difference as breaking or compatible using a usage table
 * of what the backend actually calls and projects. Live mode refuses to
 * start on breaking differences or a wasm-hash mismatch against the pinned
 * manifest; dry-run warns and keeps running. SPEC_COMPAT_ENFORCE overrides.
 */
import { Contract, rpc, xdr } from '@stellar/stellar-sdk';
import { Spec } from '@stellar/stellar-sdk/contract';
import { config } from '../../config';
import { CONTRACTS } from '../../config/contracts';
import { logger } from '../../lib/logger';
import { withTimeout } from '../../lib/resilience';
import { rpcServer, readClients } from './clients';
import manifest from '../../generated/contracts-manifest.json';

export type BindingContract = 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry';
export type Severity = 'breaking' | 'compatible';

export interface SpecDiff {
  contract: string;
  /** e.g. "fn agent_buy", "struct Market", "event Trade", "wasm", "spec" */
  item: string;
  /** e.g. "arg min_shares_out type i128 → u128" */
  change: string;
  severity: Severity;
}

export interface DeployedContract {
  contract: string;
  contractId: string;
  wasmHash: string | null;
  kind: 'wasm' | 'stellar-asset';
  /** null when the spec could not be read; `reason` says why. */
  spec: xdr.ScSpecEntry[] | null;
  reason?: string;
}

/**
 * What the backend uses per contract: entrypoints called anywhere in
 * src/services (through readClients / agentClients) and events the indexer
 * projects (applySideEffects / hasPublicEvent). A unit test greps the
 * services and fails when this table is out of date. Changes to anything
 * not listed here are compatible by definition.
 */
export interface UsageTable {
  functions: readonly string[];
  events: readonly string[];
}

export const USAGE: Record<BindingContract, UsageTable> = {
  marketCore: {
    functions: ['market_count', 'get_market', 'get_price', 'quote_buy', 'quote_sell', 'get_position', 'get_config'],
    events: ['Trade', 'MarketResolved'],
  },
  treasury: {
    functions: ['available_capital', 'get_config', 'daily_usage', 'agent_create_market', 'agent_buy', 'agent_sell'],
    events: [],
  },
  resolver: {
    functions: ['state', 'attest', 'finalize_signers', 'register_price_spec', 'register_signer_spec', 'resolve_price'],
    events: ['ResolutionProposed', 'ResolutionFinalized'],
  },
  reasoningRegistry: {
    functions: ['get_trace', 'trace_count', 'market_trace_count', 'market_trace_at', 'publish_trace'],
    events: ['TracePublished'],
  },
};

const BINDING_CONTRACTS = Object.keys(USAGE) as BindingContract[];

// ─── Wasm / spec fetching ────────────────────────────────────────────────────

export interface RpcReader {
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse>;
}

/** Spec entries embedded in a wasm's `contractspecv0` custom section. */
export function specEntriesFromWasm(wasm: Buffer): xdr.ScSpecEntry[] {
  // stellar-sdk ≥14 parses the custom section itself; entries are the raw XDR.
  return Spec.fromWasm(wasm).entries;
}

// Parsed specs keyed by wasm hash, kept for the process lifetime. Only
// successful parses are cached: an archived code entry can be restored.
const specByWasmHash = new Map<string, xdr.ScSpecEntry[]>();

/**
 * The executable behind a deployed contract id: its wasm hash and the spec
 * embedded in its code entry, or kind 'stellar-asset' for SAC contracts.
 * A missing or archived ledger entry reports `spec: null` with a reason —
 * never a throw — so the caller decides what "cannot verify" means.
 */
export async function fetchDeployed(
  contract: string,
  contractId: string,
  deps: { rpc: RpcReader } = { rpc: rpcServer },
): Promise<DeployedContract> {
  const base: Omit<DeployedContract, 'wasmHash' | 'kind' | 'spec'> = { contract, contractId };

  const instanceRes = await withTimeout('rpc-read', async () =>
    deps.rpc.getLedgerEntries(new Contract(contractId).getFootprint()),
  );
  const instance = instanceRes.entries[0];
  if (!instance) {
    return { ...base, wasmHash: null, kind: 'wasm', spec: null, reason: 'contract instance not found (or archived)' };
  }

  const executable = instance.val.contractData().val().instance().executable();
  if (executable.switch() === xdr.ContractExecutableType.contractExecutableStellarAsset()) {
    return { ...base, wasmHash: null, kind: 'stellar-asset', spec: null };
  }

  const hash = executable.wasmHash();
  const wasmHash = hash.toString('hex');
  const cached = specByWasmHash.get(wasmHash);
  if (cached) return { ...base, wasmHash, kind: 'wasm', spec: cached };

  const codeRes = await withTimeout('rpc-read', async () =>
    deps.rpc.getLedgerEntries(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }))),
  );
  const code = codeRes.entries[0];
  if (!code) return { ...base, wasmHash, kind: 'wasm', spec: null, reason: 'code archived' };

  try {
    const spec = specEntriesFromWasm(code.val.contractCode().code());
    specByWasmHash.set(wasmHash, spec);
    return { ...base, wasmHash, kind: 'wasm', spec };
  } catch (err) {
    return {
      ...base,
      wasmHash,
      kind: 'wasm',
      spec: null,
      reason: `no readable contractspecv0 section: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Canonical (doc-free) views of spec entries ──────────────────────────────

/**
 * Canonical serialisation of an ScSpecTypeDef. Structural, so Option / Vec /
 * Map / BytesN / Result nest, and UDTs compare by name — never by XDR bytes,
 * which would see doc-only differences.
 */
export function typeKey(def: xdr.ScSpecTypeDef): string {
  switch (def.switch().name) {
    case 'scSpecTypeOption':
      return `option<${typeKey(def.option().valueType())}>`;
    case 'scSpecTypeVec':
      return `vec<${typeKey(def.vec().elementType())}>`;
    case 'scSpecTypeMap':
      return `map<${typeKey(def.map().keyType())},${typeKey(def.map().valueType())}>`;
    case 'scSpecTypeTuple':
      return `tuple<${def.tuple().valueTypes().map(typeKey).join(',')}>`;
    case 'scSpecTypeBytesN':
      return `bytesn<${def.bytesN().n()}>`;
    case 'scSpecTypeResult':
      return `result<${typeKey(def.result().okType())},${typeKey(def.result().errorType())}>`;
    case 'scSpecTypeUdt':
      return def.udt().name().toString();
    default:
      return def.switch().name.replace(/^scSpecType/, '').toLowerCase();
  }
}

type EntryKind = 'fn' | 'struct' | 'union' | 'enum' | 'errors' | 'event';

function entryKindAndName(e: xdr.ScSpecEntry): { kind: EntryKind; name: string } {
  switch (e.switch().name) {
    case 'scSpecEntryFunctionV0':
      return { kind: 'fn', name: e.functionV0().name().toString() };
    case 'scSpecEntryUdtStructV0':
      return { kind: 'struct', name: e.udtStructV0().name().toString() };
    case 'scSpecEntryUdtUnionV0':
      return { kind: 'union', name: e.udtUnionV0().name().toString() };
    case 'scSpecEntryUdtEnumV0':
      return { kind: 'enum', name: e.udtEnumV0().name().toString() };
    case 'scSpecEntryUdtErrorEnumV0':
      return { kind: 'errors', name: e.udtErrorEnumV0().name().toString() };
    case 'scSpecEntryEventV0':
      return { kind: 'event', name: e.eventV0().name().toString() };
    default:
      return { kind: 'struct', name: `<unknown ${e.switch().name}>` };
  }
}

interface NamedType { name: string; type: string }
interface UnionCase { name: string; types: string[] }
interface EnumCase { name: string; value: number }
interface EventParam { name: string; type: string; location: string }

const fnInputs = (f: xdr.ScSpecFunctionV0): NamedType[] =>
  f.inputs().map((i) => ({ name: i.name().toString(), type: typeKey(i.type()) }));
const fnOutputs = (f: xdr.ScSpecFunctionV0): string[] => f.outputs().map(typeKey);
const structFields = (s: xdr.ScSpecUdtStructV0): NamedType[] =>
  s
    .fields()
    .map((f) => ({ name: f.name().toString(), type: typeKey(f.type()) }))
    // On-chain structs are ScMaps keyed by field name, so order never matters.
    .sort((a, b) => a.name.localeCompare(b.name));
const unionCases = (u: xdr.ScSpecUdtUnionV0): UnionCase[] =>
  u.cases().map((c) =>
    c.switch().name === 'scSpecUdtUnionCaseVoidV0'
      ? { name: c.voidCase().name().toString(), types: [] }
      : { name: c.tupleCase().name().toString(), types: c.tupleCase().type().map(typeKey) },
  );
const enumCases = (e: xdr.ScSpecUdtEnumV0 | xdr.ScSpecUdtErrorEnumV0): EnumCase[] =>
  e.cases().map((c) => ({ name: c.name().toString(), value: c.value() }));
const eventParams = (e: xdr.ScSpecEventV0): EventParam[] =>
  e.params().map((p) => ({ name: p.name().toString(), type: typeKey(p.type()), location: p.location().name }));

/** UDT names referenced by a type, recursively through containers. */
function collectUdts(def: xdr.ScSpecTypeDef, out: Set<string>): void {
  switch (def.switch().name) {
    case 'scSpecTypeUdt':
      out.add(def.udt().name().toString());
      return;
    case 'scSpecTypeOption':
      return collectUdts(def.option().valueType(), out);
    case 'scSpecTypeVec':
      return collectUdts(def.vec().elementType(), out);
    case 'scSpecTypeMap':
      collectUdts(def.map().keyType(), out);
      return collectUdts(def.map().valueType(), out);
    case 'scSpecTypeTuple':
      for (const t of def.tuple().valueTypes()) collectUdts(t, out);
      return;
    case 'scSpecTypeResult':
      collectUdts(def.result().okType(), out);
      return collectUdts(def.result().errorType(), out);
    default:
      return;
  }
}

/**
 * UDT names reachable from the given seed types, closed over references
 * inside struct fields and union cases of the binding's own entries (the
 * contracts use experimental_spec_shaking, so each binding is compared only
 * against itself and never against types another binding happens to have).
 */
function closeOverUdts(seeds: Set<string>, entries: xdr.ScSpecEntry[]): Set<string> {
  const byName = new Map<string, xdr.ScSpecEntry>();
  for (const e of entries) {
    const { kind, name } = entryKindAndName(e);
    if (kind === 'struct' || kind === 'union') byName.set(name, e);
  }
  const closed = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (closed.has(name)) continue;
    closed.add(name);
    const entry = byName.get(name);
    if (!entry) continue;
    const referenced = new Set<string>();
    if (entry.switch().name === 'scSpecEntryUdtStructV0') {
      for (const f of entry.udtStructV0().fields()) collectUdts(f.type(), referenced);
    } else {
      for (const c of entry.udtUnionV0().cases()) {
        if (c.switch().name === 'scSpecUdtUnionCaseTupleV0') {
          for (const t of c.tupleCase().type()) collectUdts(t, referenced);
        }
      }
    }
    for (const r of referenced) queue.push(r);
  }
  return closed;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Positional diff of named-and-typed lists (function args, event params). */
function diffNamedTypes(label: string, before: NamedType[], after: NamedType[]): string[] {
  const changes: string[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const b = before[i];
    const a = after[i];
    if (b && !a) changes.push(`${label} ${b.name} removed`);
    else if (!b && a) changes.push(`${label} ${a.name} added`);
    else if (b && a) {
      if (b.name !== a.name) changes.push(`${label} ${b.name} renamed → ${a.name}`);
      if (b.type !== a.type) changes.push(`${label} ${b.name} type ${b.type} → ${a.type}`);
    }
  }
  return changes;
}

function diffFields(before: NamedType[], after: NamedType[]): string[] {
  const changes: string[] = [];
  const b = new Map(before.map((f) => [f.name, f.type]));
  const a = new Map(after.map((f) => [f.name, f.type]));
  for (const [name, type] of b) {
    if (!a.has(name)) changes.push(`field ${name} removed`);
    else if (a.get(name) !== type) changes.push(`field ${name} type ${type} → ${a.get(name)}`);
  }
  for (const name of a.keys()) if (!b.has(name)) changes.push(`field ${name} added`);
  return changes;
}

const caseLabel = (c: UnionCase): string => (c.types.length > 0 ? `${c.name}(${c.types.join(',')})` : c.name);

/**
 * Structural diff of one contract's binding spec against its deployed spec,
 * classified with the documented rules:
 *
 * - used function missing / signature changed → breaking; unused or new → compatible
 * - struct/union/enum reachable from a used function or projected event
 *   changed → breaking; union/enum case appended at the end → compatible for
 *   read-only types, breaking for types the backend encodes (e.g. Category)
 * - error enum: an existing name's code changed or reused → breaking
 *   (error naming relies on it); new codes → compatible
 * - projected event changed in topics or data fields → breaking; others → compatible
 *
 * Doc strings never participate: every comparison reads names, types and
 * values only.
 */
export function diffSpecs(
  contract: string,
  binding: xdr.ScSpecEntry[],
  deployed: xdr.ScSpecEntry[],
  usage: UsageTable,
): SpecDiff[] {
  const diffs: SpecDiff[] = [];
  const add = (item: string, change: string, severity: Severity) => diffs.push({ contract, item, change, severity });

  const index = (entries: xdr.ScSpecEntry[]) => {
    const map = new Map<string, xdr.ScSpecEntry>();
    for (const e of entries) {
      const { kind, name } = entryKindAndName(e);
      map.set(`${kind}:${name}`, e);
    }
    return map;
  };
  const bIdx = index(binding);
  const dIdx = index(deployed);

  const usedFns = new Set(usage.functions);
  const usedEvents = new Set(usage.events);

  // Types the backend touches: read types come back from used functions and
  // projected events; written types are encoded into used functions' inputs.
  const readSeeds = new Set<string>();
  const writeSeeds = new Set<string>();
  for (const e of binding) {
    const { kind, name } = entryKindAndName(e);
    if (kind === 'fn' && usedFns.has(name)) {
      for (const i of e.functionV0().inputs()) collectUdts(i.type(), writeSeeds);
      for (const o of e.functionV0().outputs()) collectUdts(o, readSeeds);
    }
    if (kind === 'event' && usedEvents.has(name)) {
      for (const p of e.eventV0().params()) collectUdts(p.type(), readSeeds);
    }
  }
  const writtenTypes = closeOverUdts(writeSeeds, binding);
  const usedTypes = closeOverUdts(new Set([...readSeeds, ...writeSeeds]), binding);

  for (const [key, bEntry] of bIdx) {
    const { kind, name } = entryKindAndName(bEntry);
    const dEntry = dIdx.get(key);
    const item = `${kind} ${name}`;

    if (kind === 'fn') {
      const used = usedFns.has(name);
      const severity: Severity = used ? 'breaking' : 'compatible';
      if (!dEntry) {
        add(item, 'removed', severity);
        continue;
      }
      const b = bEntry.functionV0();
      const d = dEntry.functionV0();
      const changes = diffNamedTypes('arg', fnInputs(b), fnInputs(d));
      if (!sameJson(fnOutputs(b), fnOutputs(d))) {
        changes.push(`output ${fnOutputs(b).join(',') || 'void'} → ${fnOutputs(d).join(',') || 'void'}`);
      }
      for (const change of changes) add(item, change, severity);
      continue;
    }

    if (kind === 'struct') {
      const severity: Severity = usedTypes.has(name) ? 'breaking' : 'compatible';
      if (!dEntry) {
        add(item, 'removed', severity);
        continue;
      }
      for (const change of diffFields(structFields(bEntry.udtStructV0()), structFields(dEntry.udtStructV0()))) {
        add(item, change, severity);
      }
      continue;
    }

    if (kind === 'union' || kind === 'enum') {
      const used = usedTypes.has(name);
      if (!dEntry) {
        add(item, 'removed', used ? 'breaking' : 'compatible');
        continue;
      }
      const b: Array<UnionCase | EnumCase> =
        kind === 'union' ? unionCases(bEntry.udtUnionV0()) : enumCases(bEntry.udtEnumV0());
      const d: Array<UnionCase | EnumCase> =
        kind === 'union' ? unionCases(dEntry.udtUnionV0()) : enumCases(dEntry.udtEnumV0());
      if (sameJson(b, d)) continue;
      if (d.length > b.length && sameJson(b, d.slice(0, b.length))) {
        // Appended at the end: fine to read (existing cases decode the same),
        // breaking when the backend encodes this type — the binding and the
        // contract no longer agree on the full set of values it may write.
        const appended = d
          .slice(b.length)
          .map((c) => ('types' in c ? caseLabel(c) : `${c.name}=${c.value}`))
          .join(', ');
        add(item, `case ${appended} appended`, writtenTypes.has(name) ? 'breaking' : 'compatible');
        continue;
      }
      const render = (cs: Array<UnionCase | EnumCase>) =>
        cs.map((c) => ('types' in c ? caseLabel(c) : `${c.name}=${c.value}`)).join(', ');
      add(item, `cases ${render(b)} → ${render(d)}`, used ? 'breaking' : 'compatible');
      continue;
    }

    if (kind === 'errors') {
      // Error naming (stellar/errors.ts) maps "Error(Contract, #N)" through
      // this table, so every contract's error enum counts as used.
      if (!dEntry) {
        add(item, 'removed', 'breaking');
        continue;
      }
      const b = enumCases(bEntry.udtErrorEnumV0());
      const d = enumCases(dEntry.udtErrorEnumV0());
      const dByName = new Map(d.map((c) => [c.name, c.value]));
      const dByValue = new Map(d.map((c) => [c.value, c.name]));
      const bNames = new Set(b.map((c) => c.name));
      const bValues = new Set(b.map((c) => c.value));
      for (const c of b) {
        const dValue = dByName.get(c.name);
        if (dValue !== undefined && dValue !== c.value) {
          add(item, `code ${c.name} ${c.value} → ${dValue}`, 'breaking');
        } else if (dValue === undefined) {
          const holder = dByValue.get(c.value);
          if (holder !== undefined) add(item, `code ${c.value} renamed ${c.name} → ${holder}`, 'breaking');
          else add(item, `code ${c.name}=${c.value} removed`, 'compatible');
        }
      }
      for (const c of d) {
        if (!bNames.has(c.name) && !bValues.has(c.value)) add(item, `code ${c.name}=${c.value} added`, 'compatible');
      }
      continue;
    }

    if (kind === 'event') {
      const severity: Severity = usedEvents.has(name) ? 'breaking' : 'compatible';
      if (!dEntry) {
        add(item, 'removed', severity);
        continue;
      }
      const b = bEntry.eventV0();
      const d = dEntry.eventV0();
      const changes = diffNamedTypes(
        'param',
        eventParams(b).map(({ name: n, type, location }) => ({ name: n, type: `${type}@${location}` })),
        eventParams(d).map(({ name: n, type, location }) => ({ name: n, type: `${type}@${location}` })),
      );
      const bTopics = b.prefixTopics().map(String);
      const dTopics = d.prefixTopics().map(String);
      if (!sameJson(bTopics, dTopics)) changes.push(`topics ${bTopics.join(',')} → ${dTopics.join(',')}`);
      if (b.dataFormat().name !== d.dataFormat().name) {
        changes.push(`data format ${b.dataFormat().name} → ${d.dataFormat().name}`);
      }
      for (const change of changes) add(item, change, severity);
      continue;
    }
  }

  // Entries only the deployed contract has are additions the binding does not
  // know about yet — always compatible.
  for (const [key] of dIdx) {
    if (bIdx.has(key)) continue;
    const [kind, name] = key.split(':');
    add(`${kind} ${name}`, 'added', 'compatible');
  }

  return diffs;
}

// ─── Startup gate ────────────────────────────────────────────────────────────

export type EnforceMode = 'enforce' | 'warn' | 'off';
export type GateAction = 'ok' | 'warn' | 'refuse';

export function effectiveMode(): EnforceMode {
  if (config.SPEC_COMPAT_ENFORCE) return config.SPEC_COMPAT_ENFORCE as EnforceMode;
  return config.CHAIN_EXECUTION_MODE === 'live' ? 'enforce' : 'warn';
}

export interface ContractCompat {
  contract: string;
  contractId: string;
  kind: 'wasm' | 'stellar-asset' | 'unknown';
  wasmHash: string | null;
  expectedWasmHash: string | null;
  /** null when no hash is pinned (manifest has none, or the id is overridden). */
  wasmHashMatch: boolean | null;
  /** false when the deployed spec could not be read (archived, RPC error, …). */
  verified: boolean;
  reason?: string;
  diffs: SpecDiff[];
}

export interface SpecCompatReport {
  checkedAt: string;
  mode: EnforceMode;
  bindingsCommit: string;
  ok: boolean;
  breaking: SpecDiff[];
  contracts: ContractCompat[];
}

type FetchFn = typeof fetchDeployed;

let lastReport: SpecCompatReport | null = null;
let disabled = new Set<string>();

/** The last report, for GET /admin/chain/spec-compat. Null before the gate ran. */
export function specCompatReport(): SpecCompatReport | null {
  return lastReport;
}

/**
 * `contractName:eventName` keys whose deployed event spec changed in a
 * breaking way. The indexer keeps storing these events but stops projecting
 * them, instead of throwing on every poll.
 */
export function disabledEventProjections(): ReadonlySet<string> {
  return disabled;
}

function bindingSpec(contract: BindingContract): xdr.ScSpecEntry[] {
  return readClients[contract]().spec.entries;
}

/**
 * Fetches every deployed contract and diffs it against the synced bindings.
 * Never throws: an unreachable or unverifiable contract becomes a breaking
 * "cannot verify" diff, because a gate that fails open is no gate.
 */
export async function checkSpecCompat(
  deps: { fetch?: FetchFn; rpc?: RpcReader } = {},
): Promise<SpecCompatReport> {
  const fetch: FetchFn = deps.fetch ?? ((contract, id) => fetchDeployed(contract, id, { rpc: deps.rpc ?? rpcServer }));
  const manifestContracts = manifest.contracts as Record<
    string,
    { contractId: string | null; expectedWasmHash: string | null }
  >;
  const contracts: ContractCompat[] = [];

  for (const contract of BINDING_CONTRACTS) {
    const contractId = CONTRACTS[contract];
    const pinned = manifestContracts[contract];
    // The pinned wasm hash belongs to the deployment the manifest was synced
    // from; an env override pointing elsewhere is checked by spec diff only.
    const expectedWasmHash = pinned?.contractId === contractId ? pinned?.expectedWasmHash ?? null : null;
    const row: ContractCompat = {
      contract,
      contractId,
      kind: 'unknown',
      wasmHash: null,
      expectedWasmHash,
      wasmHashMatch: null,
      verified: false,
      diffs: [],
    };
    contracts.push(row);

    let deployed: DeployedContract;
    try {
      deployed = await fetch(contract, contractId);
    } catch (err) {
      row.reason = err instanceof Error ? err.message : String(err);
      row.diffs.push({ contract, item: 'spec', change: `cannot verify: ${row.reason}`, severity: 'breaking' });
      continue;
    }

    row.kind = deployed.kind;
    row.wasmHash = deployed.wasmHash;
    row.reason = deployed.reason;
    if (expectedWasmHash !== null) {
      row.wasmHashMatch = deployed.wasmHash === expectedWasmHash;
      if (!row.wasmHashMatch) {
        row.diffs.push({
          contract,
          item: 'wasm',
          change: `hash ${deployed.wasmHash ?? 'none'} ≠ pinned ${expectedWasmHash}`,
          severity: 'breaking',
        });
      }
    }
    if (deployed.kind === 'stellar-asset') {
      row.diffs.push({
        contract,
        item: 'wasm',
        change: 'executable is a Stellar Asset, expected contract wasm',
        severity: 'breaking',
      });
      continue;
    }
    if (deployed.spec === null) {
      row.diffs.push({
        contract,
        item: 'spec',
        change: `cannot verify deployed spec: ${deployed.reason ?? 'unknown'}`,
        severity: 'breaking',
      });
      continue;
    }
    row.verified = true;
    row.diffs.push(...diffSpecs(contract, bindingSpec(contract), deployed.spec, USAGE[contract]));
  }

  // USDC is a Stellar Asset Contract: the gate only checks its executable
  // kind, never its spec (non-goal in #34).
  const usdc: ContractCompat = {
    contract: 'usdc',
    contractId: CONTRACTS.usdc,
    kind: 'unknown',
    wasmHash: null,
    expectedWasmHash: null,
    wasmHashMatch: null,
    verified: false,
    diffs: [],
  };
  contracts.push(usdc);
  try {
    const deployed = await fetch('usdc', CONTRACTS.usdc);
    usdc.kind = deployed.kind;
    usdc.wasmHash = deployed.wasmHash;
    usdc.verified = deployed.kind === 'stellar-asset';
    if (!usdc.verified) {
      usdc.diffs.push({
        contract: 'usdc',
        item: 'wasm',
        change: 'executable is contract wasm, expected a Stellar Asset',
        severity: 'breaking',
      });
    }
  } catch (err) {
    usdc.reason = err instanceof Error ? err.message : String(err);
    usdc.diffs.push({ contract: 'usdc', item: 'spec', change: `cannot verify: ${usdc.reason}`, severity: 'breaking' });
  }

  const breaking = contracts.flatMap((c) => c.diffs.filter((d) => d.severity === 'breaking'));
  const report: SpecCompatReport = {
    checkedAt: new Date().toISOString(),
    mode: effectiveMode(),
    bindingsCommit: manifest.commit,
    ok: breaking.length === 0,
    breaking,
    contracts,
  };

  lastReport = report;
  disabled = new Set(
    breaking.filter((d) => d.item.startsWith('event ')).map((d) => `${d.contract}:${d.item.slice('event '.length)}`),
  );
  return report;
}

/** What the boot gate does with a report under the given mode. */
export function gateDecision(report: SpecCompatReport, mode: EnforceMode): GateAction {
  if (report.ok) return 'ok';
  return mode === 'enforce' ? 'refuse' : 'warn';
}

/**
 * Runs the check and logs the outcome. Returns null when the gate is off.
 * The caller exits the process on a 'refuse' decision; this module never
 * calls process.exit itself.
 */
export async function runSpecCompatGate(deps: { fetch?: FetchFn } = {}): Promise<SpecCompatReport | null> {
  const mode = effectiveMode();
  if (mode === 'off') {
    logger.warn('SPEC_COMPAT_ENFORCE=off: contract spec compatibility check skipped');
    return null;
  }
  const report = await checkSpecCompat(deps);
  const action = gateDecision(report, mode);
  if (action === 'ok') {
    const matched = report.contracts.filter((c) => c.verified && c.kind === 'wasm').length;
    logger.info(
      { bindingsCommit: report.bindingsCommit.slice(0, 7), compatible: report.contracts.flatMap((c) => c.diffs).length },
      `spec-compat: ${matched} contracts match`,
    );
  } else if (action === 'refuse') {
    for (const d of report.breaking) {
      logger.fatal({ contract: d.contract }, `spec-compat: ${d.contract} ${d.item}: ${d.change} [breaking]`);
    }
    logger.fatal(
      { breaking: report.breaking.length, bindingsCommit: report.bindingsCommit.slice(0, 7) },
      'spec-compat: deployed contracts do not match the synced bindings; refusing to start. Re-sync the bindings or set SPEC_COMPAT_ENFORCE=warn to override.',
    );
  } else {
    logger.warn(
      { breaking: report.breaking, bindingsCommit: report.bindingsCommit.slice(0, 7) },
      'spec-compat: deployed contracts drifted from the synced bindings; continuing (dry-run). Projections for affected events are disabled.',
    );
  }
  return report;
}
