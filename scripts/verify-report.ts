/**
 * Independent transparency-report verifier (#159).
 *
 * Uses only @stellar/stellar-sdk + the generated bindings. No database.
 *
 *   npm run verify:report -- --date 2026-10-14 [--rpc URL] [--gateway URL]
 */
import crypto from 'node:crypto';
import { rpc } from '@stellar/stellar-sdk';
import { Client as RegistryClient } from '../src/generated/reasoning-registry';
import { Client as TreasuryClient } from '../src/generated/treasury';
import deployments from '../src/generated/deployments.testnet.json';

export const REPORT_MARKET_ID = 18446744073709551615n;

export interface VerifyOptions {
  date?: string;
  traceId?: string;
  rpcUrl?: string;
  gatewayUrl?: string;
  networkPassphrase?: string;
  contracts?: { reasoningRegistry?: string; treasury?: string };
  /** Test seam for unit tests; the CLI never passes this. */
  deps?: {
    registry?: any;
    treasury?: any;
    fetch?: typeof fetch;
    latestLedger?: () => Promise<{ sequence: number }>;
  };
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  traceId?: string;
  cid?: string;
  computedHash?: string;
  checks: VerifyCheck[];
}

function unwrap<T>(tx: { result: unknown }): T {
  const result = tx.result as { isOk?: () => boolean; unwrap?: () => T };
  if (typeof result?.isOk === 'function') {
    if (!result.isOk()) throw new Error('contract returned an error');
    return result.unwrap!();
  }
  return result as T;
}

function clientBase(contractId: string, rpcUrl: string, networkPassphrase: string) {
  return { contractId, rpcUrl, networkPassphrase, allowHttp: rpcUrl.startsWith('http://') };
}

export async function verify(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const networkPassphrase = opts.networkPassphrase ?? process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
  const rpcUrl = opts.rpcUrl ?? process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const gateway = (opts.gatewayUrl ?? process.env.IPFS_GATEWAY_URL ?? 'https://gateway.pinata.cloud/ipfs').replace(/\/$/, '');
  const registryId = opts.contracts?.reasoningRegistry ?? process.env.REASONING_REGISTRY_CONTRACT_ID ?? deployments.contracts.reasoning_registry;
  const treasuryId = opts.contracts?.treasury ?? process.env.TREASURY_CONTRACT_ID ?? deployments.contracts.treasury;
  const registry = opts.deps?.registry ?? new RegistryClient(clientBase(registryId, rpcUrl, networkPassphrase));
  const treasury = opts.deps?.treasury ?? new TreasuryClient(clientBase(treasuryId, rpcUrl, networkPassphrase));
  const fetchImpl = opts.deps?.fetch ?? fetch;
  const checks: VerifyCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let traceId = opts.traceId ? BigInt(opts.traceId) : null;
  if (traceId === null) {
    const count = unwrap<bigint>(await registry.market_trace_count({ market_id: REPORT_MARKET_ID }));
    if (!opts.date) {
      add('find_report', false, 'provide --date or --trace-id');
      return { ok: false, checks };
    }
    for (let i = 0n; i < count; i++) {
      const id = unwrap<bigint>(await registry.market_trace_at({ market_id: REPORT_MARKET_ID, index: i }));
      const trace = unwrap<{ ipfs_cid: string }>(await registry.get_trace({ trace_id: id }));
      try {
        const res = await fetchImpl(`${gateway}/${encodeURIComponent(trace.ipfs_cid)}`);
        if (!res.ok) continue;
        const doc = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8')) as { period?: { from?: string } };
        if (doc.period?.from?.slice(0, 10) === opts.date) {
          traceId = id;
          break;
        }
      } catch {
        // keep scanning
      }
    }
  }

  if (traceId === null) {
    add('find_report', false, `no report trace found for ${opts.date}`);
    return { ok: false, checks };
  }
  add('find_report', true, `trace ${traceId.toString()}`);

  const trace = unwrap<{
    agent: string;
    action: string;
    ipfs_cid: string;
    trace_hash: Buffer;
    market_id: bigint;
  }>(await registry.get_trace({ trace_id: traceId }));
  add('sentinel_market', trace.market_id === REPORT_MARKET_ID, `market_id=${trace.market_id.toString()}`);
  add('action', trace.action === 'report', `action=${trace.action}`);

  let bytes: Buffer;
  try {
    const res = await fetchImpl(`${gateway}/${encodeURIComponent(trace.ipfs_cid)}`);
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    add('fetch_content', false, err instanceof Error ? err.message : String(err));
    return { ok: false, traceId: traceId.toString(), cid: trace.ipfs_cid, checks };
  }
  add('fetch_content', true, `${bytes.length} bytes`);

  const computedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const onChainHash = Buffer.from(trace.trace_hash).toString('hex');
  add('content_hash', computedHash === onChainHash, `${computedHash} vs ${onChainHash}`);

  let report: any;
  try {
    report = JSON.parse(bytes.toString('utf8'));
  } catch {
    add('parse_document', false, 'content is not JSON');
    return { ok: false, traceId: traceId.toString(), cid: trace.ipfs_cid, computedHash, checks };
  }
  add('parse_document', true, `${report.kind} v${report.schemaVersion}`);

  const risk = unwrap<{ agent: string }>(await treasury.get_config());
  add('report_agent_matches_trace', report.agent === trace.agent, `${report.agent} vs ${trace.agent}`);
  add('agent_matches_treasury', trace.agent === risk.agent, `${trace.agent} vs ${risk.agent}`);

  const mark = (report.markets ?? []).reduce((sum: bigint, m: any) => sum + BigInt(m.markValueRaw), 0n);
  const nav = BigInt(report.treasury.usdcBalanceRaw) + mark;
  add('totals_mark', mark.toString() === report.totals.positionsMarkRaw, `${mark.toString()} vs ${report.totals.positionsMarkRaw}`);
  add('totals_nav', nav.toString() === report.totals.navRaw, `${nav.toString()} vs ${report.totals.navRaw}`);

  if (report.previous) {
    try {
      const prevId = BigInt(report.previous.onChainTraceId);
      const prev = unwrap<{ trace_hash: Buffer; action: string; ipfs_cid: string }>(await registry.get_trace({ trace_id: prevId }));
      const prevHash = Buffer.from(prev.trace_hash).toString('hex');
      add('previous_hash_chain', prevHash === report.previous.traceHash, `${prevHash} vs ${report.previous.traceHash}`);
      add('previous_is_report', prev.action === 'report', `action=${prev.action}`);
      add('previous_cid', Boolean(prev.ipfs_cid), prev.ipfs_cid);
    } catch (err) {
      add('previous_hash_chain', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    add('previous_hash_chain', true, 'genesis report (no previous)');
  }

  const latest = opts.deps?.latestLedger
    ? await opts.deps.latestLedger()
    : await new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') }).getLatestLedger();
  add('anchor_not_future', report.anchor.ledger <= latest.sequence, `anchor=${report.anchor.ledger}, latest=${latest.sequence}`);
  if (report.anchor.ledger < latest.sequence) {
    add('state_moved_since_anchor', true, `state moved ${latest.sequence - report.anchor.ledger} ledgers; re-simulation is advisory`);
  }

  return {
    ok: checks.every((c) => c.ok),
    traceId: traceId.toString(),
    cid: trace.ipfs_cid,
    computedHash,
    checks,
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run verify:report -- --date YYYY-MM-DD [--rpc URL] [--gateway URL] [--trace-id ID]');
    process.exit(0);
  }
  verify({ date: arg('date'), traceId: arg('trace-id'), rpcUrl: arg('rpc'), gatewayUrl: arg('gateway') })
    .then((result) => {
      for (const check of result.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
      console.log(result.ok ? '\nreport verified' : '\nreport verification FAILED');
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
