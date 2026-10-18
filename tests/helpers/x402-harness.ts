/**
 * Harness for the end-to-end x402 test (#64).
 *
 * The contracts repo's x402 service is an ESM TypeScript package, while the
 * backend tests compile to CommonJS. We load it at runtime through a real
 * dynamic `import()` (hidden from tsc in a `Function`) after registering
 * `tsx`'s ESM loader, so the submodule's sources are executed as-is at the
 * pinned commit and nothing is copied into src/. The backend's own `tsx`
 * devDependency does the loading; the package's runtime dependencies
 * (express, @x402/*) resolve from `contracts/oracledesk-stellar/x402/node_modules`,
 * installed by `npm run test:x402:prepare`.
 *
 * tsx registration is process-global, which is why the tests that use this
 * harness each run in their own `node --test` child process.
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const importEsm = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

/** Repository root, from dist-tests/tests/helpers. */
const REPO_ROOT = resolve(__dirname, '../../..');
export const CONTRACTS_ROOT = join(REPO_ROOT, 'contracts', 'oracledesk-stellar');
export const X402_ROOT = join(CONTRACTS_ROOT, 'x402');

// ── Local types (the submodule's .ts is never typechecked by the backend) ──
export interface TraceRecord {
  traceId: string;
  ipfsCid: string;
  traceHash: string;
}

export interface TracePaymentNetwork {
  network: 'stellar:testnet' | 'stellar:pubnet';
  payTo: string;
  facilitatorUrl: string;
}

export interface TraceApiModule {
  createTraceApi(options: {
    repository: { get(traceId: string): Promise<TraceRecord | undefined> };
    ipfsGateway: string;
    price: string;
    networks: TracePaymentNetwork[];
    fetchImpl?: typeof fetch;
  }): http.RequestListener;
  MapTraceRepository: new (records: ReadonlyMap<string, TraceRecord>) => {
    get(traceId: string): Promise<TraceRecord | undefined>;
  };
}

export interface ContractsTraceModule {
  canonicalize(value: unknown): string;
}

export type Unavailable = { ok: false; reason: string };
export type Loaded<T> = { ok: true; value: T };

let registered = false;
async function registerTsx(): Promise<void> {
  if (registered) return;
  const { register } = await importEsm('tsx/esm/api');
  register();
  registered = true;
}

function submoduleMissing(file: string): string | null {
  if (!existsSync(file)) {
    return `contracts submodule is not initialised (missing ${file}); run: git submodule update --init`;
  }
  return null;
}

/** Loads agents/core/trace.ts (needs only the submodule, no npm deps). */
export async function loadContractsTrace(): Promise<Loaded<ContractsTraceModule> | Unavailable> {
  const file = join(CONTRACTS_ROOT, 'agents', 'core', 'trace.ts');
  const missing = submoduleMissing(file);
  if (missing) return { ok: false, reason: missing };
  await registerTsx();
  return { ok: true, value: (await importEsm(pathToFileURL(file).href)) as ContractsTraceModule };
}

/** Loads x402/trace-api.ts (needs the submodule and its npm dependencies). */
export async function loadTraceApi(): Promise<Loaded<TraceApiModule> | Unavailable> {
  const file = join(X402_ROOT, 'trace-api.ts');
  const missing = submoduleMissing(file);
  if (missing) return { ok: false, reason: missing };
  if (!existsSync(join(X402_ROOT, 'node_modules', '@x402'))) {
    return { ok: false, reason: 'x402 dependencies are not installed; run: npm run test:x402:prepare' };
  }
  await registerTsx();
  return { ok: true, value: (await importEsm(pathToFileURL(file).href)) as TraceApiModule };
}

/** Skip locally, fail in CI, so a misconfigured pipeline cannot go green silently. */
export function skipOrFail(t: { skip(msg?: string): void }, reason: string): void {
  if (process.env.CI === 'true') throw new Error(`x402 e2e prerequisites missing in CI: ${reason}`);
  t.skip(reason);
}

// ── Hermetic network guard ──────────────────────────────────────────────────
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const FAKE_IPFS_ORIGIN = 'http://ipfs.test';

function urlOf(input: any): URL {
  return new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
}

/**
 * Replaces global fetch so any request that is not to a loopback address
 * throws. The x402 service's own IPFS reads use an injected `fetchImpl`, so
 * this also catches an accidental real call. Returns the list of blocked URLs
 * and a restore function.
 */
export function installNetworkGuard(): { blocked: string[]; restore(): void } {
  const original = globalThis.fetch;
  const blocked: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = urlOf(input);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      blocked.push(url.href);
      throw new Error(`Hermetic test attempted a real network call: ${url.href}`);
    }
    return original(input, init);
  }) as typeof fetch;
  return { blocked, restore: () => { globalThis.fetch = original; } };
}

// ── In-memory IPFS ──────────────────────────────────────────────────────────
export class MemoryIpfs {
  readonly blobs = new Map<string, Buffer>();

  /** IpfsTransport for the backend's setIpfsTransport() seam. */
  transport(cidForBytes: (bytes: Buffer) => string) {
    return {
      pin: async (bytes: Buffer): Promise<string> => {
        const cid = cidForBytes(bytes);
        this.blobs.set(cid, Buffer.from(bytes));
        return cid;
      },
      fetch: async (cid: string): Promise<Buffer> => {
        const b = this.blobs.get(cid);
        if (!b) throw new Error(`not pinned: ${cid}`);
        return b;
      },
    };
  }

  /** `fetch` for createTraceApi: serves http://ipfs.test/<cid> from the same map. */
  fetchImpl = (async (input: any): Promise<Response> => {
    const url = urlOf(input);
    if (url.origin !== FAKE_IPFS_ORIGIN) {
      throw new Error(`Hermetic test attempted a real network call: ${url.href}`);
    }
    const bytes = this.blobs.get(decodeURIComponent(url.pathname.slice(1)));
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as typeof fetch;
}

// ── Stub facilitator ────────────────────────────────────────────────────────
/**
 * In-process x402 facilitator for protocol v2 (@x402/core ^2.23, the version
 * pinned by the submodule's package-lock.json). Endpoints used by
 * HTTPFacilitatorClient: GET /supported, POST /verify, POST /settle.
 * Spec: https://github.com/coinbase/x402 (specs/x402-specification-v2.md).
 *
 * The test is about the server path and content parity, not cryptographic
 * payment validity, so this stub accepts any well-formed payload and answers
 * with switchable results.
 */
export interface StubFacilitator {
  url: string;
  calls: { verify: number; settle: number; supported: number };
  verifyOk: boolean;
  settleOk: boolean;
  close(): Promise<void>;
}

export const PAYER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections?.();
  });
}

export async function startStubFacilitator(network = 'stellar:testnet'): Promise<StubFacilitator> {
  const state = { verifyOk: true, settleOk: true, calls: { verify: 0, settle: 0, supported: 0 } };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/supported') {
        state.calls.supported++;
        return send(200, {
          kinds: [{ x402Version: 2, scheme: 'exact', network, extra: { areFeesSponsored: true } }],
          extensions: [],
          signers: {},
        });
      }
      if (req.method === 'POST' && req.url === '/verify') {
        state.calls.verify++;
        return send(200, state.verifyOk
          ? { isValid: true, payer: PAYER }
          : { isValid: false, invalidReason: 'invalid_exact_stellar_payload_signature', payer: PAYER });
      }
      if (req.method === 'POST' && req.url === '/settle') {
        state.calls.settle++;
        return send(200, state.settleOk
          ? { success: true, payer: PAYER, transaction: 'ab'.repeat(32), network }
          : { success: false, errorReason: 'settle_exact_stellar_transaction_failed', payer: PAYER, transaction: '', network });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: state.calls,
    get verifyOk() { return state.verifyOk; },
    set verifyOk(v: boolean) { state.verifyOk = v; },
    get settleOk() { return state.settleOk; },
    set settleOk(v: boolean) { state.settleOk = v; },
    close: () => closeServer(server),
  };
}

// ── x402 server under test ──────────────────────────────────────────────────
export interface RunningX402 {
  base: string;
  close(): Promise<void>;
}

export async function startX402(params: {
  api: TraceApiModule;
  records: Iterable<[string, TraceRecord]>;
  ipfs: MemoryIpfs;
  facilitator: StubFacilitator;
  payTo: string;
}): Promise<RunningX402> {
  const app = params.api.createTraceApi({
    repository: new params.api.MapTraceRepository(new Map(params.records)),
    ipfsGateway: FAKE_IPFS_ORIGIN,
    price: '0.01',
    networks: [{ network: 'stellar:testnet', payTo: params.payTo, facilitatorUrl: params.facilitator.url }],
    fetchImpl: params.ipfs.fetchImpl,
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

/**
 * Builds the `PAYMENT-SIGNATURE` header answering the first requirement of a
 * 402 challenge. The payload is opaque to the stub facilitator.
 */
export async function paymentHeader(challenge: Response): Promise<string> {
  const raw = challenge.headers.get('payment-required');
  const required = raw
    ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    : await challenge.clone().json();
  const payload = {
    x402Version: required.x402Version ?? 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: { transaction: 'AAAA-stub-signed-transaction' },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
