/**
 * Secret loading, rotation and accessors (#145).
 *
 * Boot-time values are resolved synchronously by `loadConfig` (including
 * `<NAME>_FILE`). `initSecrets` moves them into this store; at runtime every
 * consumer reads through `secret()` so a refresh can swap a value without a
 * restart.
 *
 * Raw values are kept as Buffers so a retired value can be zeroed. Strings
 * handed to an SDK are immutable copies and remain until GC — documented in
 * docs/architecture.md.
 */
import fs from 'fs';
import { StrKey } from '@stellar/stellar-sdk';
import { entitlementKeyProblem } from '../services/entitlement/keys';

export const SECRET_NAMES = [
  'JWT_SECRET',
  'AUTH_SIGNING_SECRET',
  'PINATA_API_KEY',
  'PINATA_SECRET_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'NEWSAPI_KEY',
  'FRED_API_KEY',
  'ENTITLEMENT_SIGNING_KEY',
  'DATABASE_URL',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];
export type SecretsProviderKind = 'env' | 'file' | 'vault';

export interface SecretsProvider {
  readonly kind: SecretsProviderKind;
  load(names: readonly SecretName[]): Promise<Partial<Record<SecretName, string>>>;
}

export interface SecretEntry {
  current: string;
  previous?: { value: string; retiredAt: number };
  version: number;
}

export class SecretsNotReadyError extends Error {
  constructor() {
    super('Secrets have not been initialised; call initSecrets() during bootstrap');
    this.name = 'SecretsNotReadyError';
  }
}

interface InternalEntry {
  current: Buffer;
  previous?: { value: Buffer; retiredAt: number };
  version: number;
}

interface ResolvedSecrets {
  JWT_SECRET: string;
  AUTH_SIGNING_SECRET: string;
  PINATA_API_KEY: string;
  PINATA_SECRET_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  NEWSAPI_KEY: string;
  FRED_API_KEY: string;
  ENTITLEMENT_SIGNING_KEY: string;
  DATABASE_URL: string;
  AGENT_SECRET_KEY?: string;
  NODE_ENV?: string;
  JWT_PREVIOUS_SECRET_GRACE_SECS?: number;
  SECRETS_PROVIDER?: SecretsProviderKind;
  SECRETS_REFRESH_MS?: number;
  VAULT_ADDR?: string;
  VAULT_TOKEN_FILE?: string;
  VAULT_KV_PATH?: string;
}

const store = new Map<SecretName, InternalEntry>();
const listeners = new Map<SecretName, Set<(entry: SecretEntry) => void>>();
let ready = false;
let graceMs = 86_400_000;
let activeProvider: SecretsProvider | null = null;

function wraps(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function publicEntry(entry: InternalEntry): SecretEntry {
  const current = entry.current.toString('utf8');
  const previous = entry.previous
    ? { value: entry.previous.value.toString('utf8'), retiredAt: entry.previous.retiredAt }
    : undefined;
  return { current, previous, version: entry.version };
}

function assertReady(): void {
  if (!ready) throw new SecretsNotReadyError();
}

export function secret(name: SecretName): string {
  assertReady();
  return store.get(name)?.current.toString('utf8') ?? '';
}

export function secretEntry(name: SecretName): SecretEntry {
  assertReady();
  const entry = store.get(name);
  if (!entry) return { current: '', version: 0 };
  return publicEntry(entry);
}

/** The previous value while it is inside the JWT rotation grace window. */
export function previousSecret(name: SecretName): string | null {
  assertReady();
  const previous = store.get(name)?.previous;
  if (!previous) return null;
  if (Date.now() - previous.retiredAt > graceMs) {
    retirePrevious(name);
    return null;
  }
  return previous.value.toString('utf8');
}

export function onSecretChange(name: SecretName, cb: (entry: SecretEntry) => void): () => void {
  const set = listeners.get(name) ?? new Set();
  set.add(cb);
  listeners.set(name, set);
  return () => set.delete(cb);
}

function emit(name: SecretName, entry: InternalEntry): void {
  const value = publicEntry(entry);
  for (const cb of listeners.get(name) ?? []) {
    try {
      cb(value);
    } catch {
      // A listener must never break the refresh loop.
    }
  }
}

function retirePrevious(name: SecretName): void {
  const entry = store.get(name);
  if (!entry?.previous) return;
  entry.previous.value.fill(0);
  delete entry.previous;
}

/**
 * Validation shared by boot and refresh. Returns human-readable problems;
 * callers decide whether to throw (boot) or keep the old value (refresh).
 */
export function validateSecrets(
  values: Partial<Record<SecretName | 'AGENT_SECRET_KEY', string>>,
  nodeEnv: string,
  options: { requireProductionSecrets?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const requireProd = options.requireProductionSecrets ?? true;
  if (values.JWT_SECRET && values.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters');
  }
  if (values.AUTH_SIGNING_SECRET && !StrKey.isValidEd25519SecretSeed(values.AUTH_SIGNING_SECRET)) {
    problems.push('AUTH_SIGNING_SECRET must be a Stellar secret seed (S…)');
  }
  if (values.AGENT_SECRET_KEY && !StrKey.isValidEd25519SecretSeed(values.AGENT_SECRET_KEY)) {
    problems.push('AGENT_SECRET_KEY must be a Stellar secret seed (S…)');
  }
  if (values.ENTITLEMENT_SIGNING_KEY) {
    // Never echo the key; only say that it could not be parsed.
    const problem = entitlementKeyProblem(values.ENTITLEMENT_SIGNING_KEY);
    if (problem) problems.push(`ENTITLEMENT_SIGNING_KEY ${problem}`);
  }
  if (nodeEnv === 'production' && requireProd) {
    if (!values.JWT_SECRET) problems.push('JWT_SECRET is required in production');
    if (!values.AUTH_SIGNING_SECRET) problems.push('AUTH_SIGNING_SECRET is required in production');
    if (!values.ENTITLEMENT_SIGNING_KEY) problems.push('ENTITLEMENT_SIGNING_KEY is required in production');
  }
  return problems;
}

function setEntry(name: SecretName, value: string, options: { rotate?: boolean } = {}): boolean {
  const existing = store.get(name);
  const next = wraps(value);
  if (!existing) {
    store.set(name, { current: next, version: 1 });
    emit(name, store.get(name)!);
    return true;
  }
  if (existing.current.equals(next)) {
    next.fill(0);
    return false;
  }
  if (options.rotate && existing.current.length > 0) {
    if (existing.previous) existing.previous.value.fill(0);
    existing.previous = { value: existing.current, retiredAt: Date.now() };
  } else {
    existing.current.fill(0);
  }
  existing.current = next;
  existing.version += 1;
  emit(name, existing);
  return true;
}

/** Populates the store from already-resolved config. */
export async function initSecrets(cfg: ResolvedSecrets, provider?: SecretsProvider): Promise<void> {
  const values: Partial<Record<SecretName, string>> = {};
  for (const name of SECRET_NAMES) values[name] = (cfg as unknown as Record<string, string>)[name] ?? '';

  const kind = cfg.SECRETS_PROVIDER ?? 'env';
  const remote = provider ?? (kind === 'vault' ? vaultProvider(cfg) : undefined);
  if (remote) {
    const loaded = await remote.load(SECRET_NAMES);
    for (const name of SECRET_NAMES) {
      if (loaded[name] !== undefined && loaded[name] !== '') values[name] = loaded[name];
    }
  }

  const problems = validateSecrets(
    { ...values, AGENT_SECRET_KEY: cfg.AGENT_SECRET_KEY },
    cfg.NODE_ENV ?? process.env.NODE_ENV ?? 'development',
  );
  if (problems.length > 0) throw new Error(`Invalid secrets:\n${problems.map((p) => `  ${p}`).join('\n')}`);

  graceMs = (cfg.JWT_PREVIOUS_SECRET_GRACE_SECS ?? 86_400) * 1000;
  for (const name of SECRET_NAMES) setEntry(name, values[name] ?? '');
  activeProvider = remote ?? (kind === 'file' ? fileProvider() : envProvider());
  ready = true;

  // Prisma reads DATABASE_URL from the environment when the client is built.
  if (values.DATABASE_URL) process.env.DATABASE_URL = values.DATABASE_URL;
}

export function setSecretsForTest(values: Partial<Record<SecretName, string>>): void {
  for (const name of SECRET_NAMES) setEntry(name, values[name] ?? '');
  ready = true;
  activeProvider = null;
}


/**
 * One refresh pass. Exported so tests can exercise rotation without waiting
 * for the production minimum interval.
 */
export async function refreshSecretsOnce(
  cfg: ResolvedSecrets,
  provider: SecretsProvider | null = activeProvider,
): Promise<{ updated: SecretName[]; problems: string[] }> {
  if (!provider) return { updated: [], problems: [] };
  graceMs = (cfg.JWT_PREVIOUS_SECRET_GRACE_SECS ?? 86_400) * 1000;
  const updated: SecretName[] = [];
  const problems: string[] = [];
  let loaded: Partial<Record<SecretName, string>>;
  try {
    loaded = await provider.load(SECRET_NAMES);
  } catch {
    return { updated, problems: ['provider refresh failed; keeping current values'] };
  }
  for (const name of SECRET_NAMES) {
    const value = loaded[name];
    if (value === undefined) continue;
    const current = secret(name);
    if (value === '' && current !== '') {
      problems.push(`${name} refresh returned an empty value; keeping the previous value`);
      continue;
    }
    if (name === 'JWT_SECRET' && value && value.length < 32) {
      problems.push('JWT_SECRET refresh failed validation; keeping the previous value');
      continue;
    }
    if (name === 'AUTH_SIGNING_SECRET' && value && !StrKey.isValidEd25519SecretSeed(value)) {
      problems.push('AUTH_SIGNING_SECRET refresh failed validation; keeping the previous value');
      continue;
    }
    if (name === 'ENTITLEMENT_SIGNING_KEY' && value && entitlementKeyProblem(value)) {
      problems.push('ENTITLEMENT_SIGNING_KEY refresh failed validation; keeping the previous value');
      continue;
    }
    if (setEntry(name, value, { rotate: true })) updated.push(name);
  }
  for (const name of SECRET_NAMES) {
    const previous = store.get(name)?.previous;
    if (previous && Date.now() - previous.retiredAt > graceMs) retirePrevious(name);
  }
  return { updated, problems };
}

export function startSecretRefresh(cfg: ResolvedSecrets): () => void {
  const provider = activeProvider;
  if (!provider) return () => undefined;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  graceMs = (cfg.JWT_PREVIOUS_SECRET_GRACE_SECS ?? 86_400) * 1000;

  const tick = async () => {
    const result = await refreshSecretsOnce(cfg, provider);
    for (const problem of result.problems) console.warn(`[secrets] ${problem}`);

    if (!stopped) {
      const base = Math.max(30_000, cfg.SECRETS_REFRESH_MS ?? 300_000);
      const jitter = Math.floor(base * 0.1 * (Math.random() * 2 - 1));
      timer = setTimeout(tick, Math.max(1_000, base + jitter));
      timer.unref?.();
    }
  };

  const base = Math.max(30_000, cfg.SECRETS_REFRESH_MS ?? 300_000);
  timer = setTimeout(tick, base);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    activeProvider = null;
  };
}

class EnvSecretsProvider implements SecretsProvider {
  readonly kind = 'env' as const;
  async load(names: readonly SecretName[]): Promise<Partial<Record<SecretName, string>>> {
    const values: Partial<Record<SecretName, string>> = {};
    for (const name of names) {
      if (process.env[name] !== undefined) values[name] = process.env[name]!;
    }
    return values;
  }
}

class FileSecretsProvider implements SecretsProvider {
  readonly kind = 'file' as const;
  async load(names: readonly SecretName[]): Promise<Partial<Record<SecretName, string>>> {
    const values: Partial<Record<SecretName, string>> = {};
    for (const name of names) {
      const file = process.env[`${name}_FILE`];
      if (file) values[name] = readSecretFile(file, name);
      else if (process.env[name] !== undefined) values[name] = process.env[name]!;
    }
    return values;
  }
}

/** Vault KV v2. Reads its token from a file, never from the environment. */
class VaultSecretsProvider implements SecretsProvider {
  readonly kind = 'vault' as const;
  constructor(
    private readonly address: string,
    private readonly tokenFile: string,
    private readonly kvPath: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async load(names: readonly SecretName[]): Promise<Partial<Record<SecretName, string>>> {
    const token = fs.readFileSync(this.tokenFile, 'utf8').trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.fetchImpl(
        `${this.address.replace(/\/$/, '')}/v1/${this.kvPath.replace(/^\//, '')}`,
        { headers: { 'X-Vault-Token': token }, signal: controller.signal },
      );
      if (!response.ok) throw new Error(`Vault responded ${response.status}`);
      const body = (await response.json()) as { data?: { data?: Record<string, unknown> } };
      const data = body.data?.data ?? {};
      const values: Partial<Record<SecretName, string>> = {};
      for (const name of names) {
        if (typeof data[name] === 'string') values[name] = data[name] as string;
      }
      return values;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function vaultProvider(cfg: ResolvedSecrets, fetchImpl?: typeof fetch): SecretsProvider {
  if (!cfg.VAULT_ADDR || !cfg.VAULT_TOKEN_FILE || !cfg.VAULT_KV_PATH) {
    throw new Error('vault provider requires VAULT_ADDR, VAULT_TOKEN_FILE and VAULT_KV_PATH');
  }
  return new VaultSecretsProvider(cfg.VAULT_ADDR, cfg.VAULT_TOKEN_FILE, cfg.VAULT_KV_PATH, fetchImpl);
}

export function envProvider(): SecretsProvider {
  return new EnvSecretsProvider();
}

export function fileProvider(): SecretsProvider {
  return new FileSecretsProvider();
}

/** Reads a mounted secret file with a size cap; never includes contents in errors. */
export function readSecretFile(path: string, name: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch {
    throw new Error(`${name}_FILE could not be read`);
  }
  if (!stat.isFile()) throw new Error(`${name}_FILE is not a regular file`);
  if (stat.size > 64 * 1024) throw new Error(`${name}_FILE is larger than 64 KiB`);
  const value = fs.readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
  if (value.trim() === '') throw new Error(`${name}_FILE is empty`);
  return value;
}

/**
 * Resolves `<NAME>_FILE` for every secret before Zod parses the environment.
 * Synchronous so `loadConfig` stays unit-testable.
 */
export function resolveFileVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of SECRET_NAMES) {
    const fileVar = `${name}_FILE`;
    if (!next[fileVar]) continue;
    if (next[name]) throw new Error(`${name} and ${fileVar} cannot both be set`);
    try {
      next[name] = readSecretFile(next[fileVar]!, name);
    } catch (err) {
      // Never echo file contents, only the variable name.
      throw new Error(err instanceof Error ? err.message : `${fileVar} could not be read`);
    }
  }
  return next;
}
