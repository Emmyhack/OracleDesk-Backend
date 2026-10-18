import crypto from 'crypto';
import dotenv from 'dotenv';
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { resolveFileVars, validateSecrets, SECRET_NAMES } from './secrets';

dotenv.config();

const optionalString = z.string().default('');

const stellarAccount = z
  .string()
  .refine((v) => StrKey.isValidEd25519PublicKey(v), 'must be a G… Stellar public key');

const optionalContract = z
  .string()
  .default('')
  .refine((v) => v === '' || StrKey.isValidContract(v), 'must be a C… Stellar contract id');

const optionalAddress = z
  .string()
  .default('')
  .refine(
    (v) => v === '' || StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v),
    'must be a G… account or C… contract address',
  );

export const PROBE_NAMES = ['database', 'redis', 'rpc', 'indexer'] as const;

const probeName = z
  .string()
  .refine((v) => (PROBE_NAMES as readonly string[]).includes(v), `must be one of ${PROBE_NAMES.join(', ')}`);

const commaList = (item: z.ZodType<string, string>, fallback = "") =>
  z
    .string()
    .default(fallback)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item));

const envSchema = z
  .object({
    DATABASE_URL: z.string({ error: 'is required' }).min(1, 'is required'),
    PORT: z.string().default('8000').transform(Number),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // ── HTTP ──────────────────────────────────────────────────────────────
    // Comma-separated origins allowed to call the API with credentials.
    CORS_ORIGINS: commaList(z.string().url(), 'http://localhost:3000'),

    // ── Auth ──────────────────────────────────────────────────────────────
    // Signs JWTs. Required in production; an ephemeral one is generated in
    // development/test so a fresh .env boots (sessions then end on restart).
    JWT_SECRET: optionalString,
    // Server key that signs SEP-10 challenge transactions. Not a funded
    // account and never the agent key. Same ephemeral fallback as above.
    AUTH_SIGNING_SECRET: optionalString,
    AUTH_HOME_DOMAIN: z.string().default('localhost'),
    AUTH_WEB_AUTH_DOMAIN: optionalString,
    // G… addresses allowed to call admin endpoints.
    ADMIN_ADDRESSES: commaList(stellarAccount),

    // ── Secrets (#145) ────────────────────────────────────────────────────
    // env: process environment (default); file: <NAME>_FILE mounts; vault:
    // Vault KV v2, refreshed every SECRETS_REFRESH_MS.
    SECRETS_PROVIDER: z.enum(['env', 'file', 'vault']).default('env'),
    SECRETS_REFRESH_MS: z
      .string()
      .default('300000')
      .transform(Number)
      .refine((v) => Number.isFinite(v) && v >= 30000, 'must be at least 30000 ms'),
    JWT_PREVIOUS_SECRET_GRACE_SECS: z
      .string()
      .default('86400')
      .transform(Number)
      .refine((v) => Number.isFinite(v) && v >= 0, 'must be a non-negative integer'),
    VAULT_ADDR: optionalString,
    VAULT_TOKEN_FILE: optionalString,
    VAULT_KV_PATH: optionalString,

    // ── Stellar ───────────────────────────────────────────────────────────
    STELLAR_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
    STELLAR_NETWORK_PASSPHRASE: z.string().default(Networks.TESTNET),
    MARKET_CORE_CONTRACT_ID: optionalContract,
    TREASURY_CONTRACT_ID: optionalContract,
    RESOLVER_CONTRACT_ID: optionalContract,
    REASONING_REGISTRY_CONTRACT_ID: optionalContract,
    USDC_CONTRACT_ID: optionalContract,
    // Where premium payments must be sent. Defaults to the treasury contract
    // (see docs/api.md: that makes subscription revenue trading capital).
    PAYMENTS_RECIPIENT: optionalAddress,
    DAILY_PASS_PRICE_RAW: z.string().regex(/^\d+$/, 'must be an integer in 7-decimal base units').default('5000000'),

    // dry-run: every write is built and simulated, never signed or sent.
    // live: writes are signed with AGENT_SECRET_KEY and submitted (testnet only).
    CHAIN_EXECUTION_MODE: z.enum(['dry-run', 'live']).default('dry-run'),
    AGENT_SECRET_KEY: optionalString,

    // Resolution spec committed at market creation (ADR 0001). Signer mode:
    // RESOLUTION_SIGNERS attest the outcome on the resolver contract. Empty
    // means the agent account is the only signer.
    RESOLUTION_SIGNERS: commaList(stellarAccount),
    RESOLUTION_THRESHOLD: z.string().default('1').transform(Number),
    RESOLUTION_DISPUTE_WINDOW_SECS: z.string().default('86400').transform(Number),

    TRUST_INBOUND_REQUEST_ID: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    INDEXER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    INDEXER_POLL_MS: z.string().default('5000').transform(Number),

    // ── Health probes (#111) ──────────────────────────────────────────────
    // Dependencies that make /readyz fail. RPC is non-critical by default so
    // cached DB reads can still be served while chain reads return 502.
    HEALTH_CRITICAL: commaList(probeName, 'database,redis'),
    HEALTH_PROBE_TIMEOUT_MS: z.string().default('1500').transform(Number),
    HEALTH_CACHE_TTL_MS: z.string().default('2000').transform(Number),
    INDEXER_MAX_LAG_LEDGERS: z.string().default('120').transform(Number),
    INDEXER_MAX_STALENESS_MS: z.string().default('60000').transform(Number),
    LIVENESS_MAX_LOOP_DELAY_MS: z.string().default('2000').transform(Number),
    // Time /readyz reports "draining" before the HTTP server stops accepting.
    SHUTDOWN_DRAIN_MS: z.string().default('5000').transform(Number),

    // ── Calibration (#68) ─────────────────────────────────────────────────
    // Slices with fewer resolved markets report insufficientData instead of noise.
    MIN_CALIBRATION_MARKETS: z.string().default('20').transform(Number)
      .pipe(z.number().int().min(1)),
    // How a market's weight is split between its traces: time | last | first.
    CALIBRATION_WEIGHTING: z.enum(['time', 'last', 'first']).default('time'),
    // Shrink the trader's probability toward 0.5 by the fitted calibration factor.
    CALIBRATION_SHRINKAGE_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

    // Build commit, recorded in trace provenance (#66). Set by CI/deploy.
    GIT_SHA: optionalString,

    // ── LLM providers (optional; generation fails at runtime without one) ─
    ANTHROPIC_API_KEY: optionalString,
    GEMINI_API_KEY: optionalString,
    // OpenAI or any OpenAI-compatible endpoint (used by the router, #157).
    OPENAI_API_KEY: optionalString,
    OPENAI_BASE_URL: optionalString.refine(
      (v) => v === '' || /^https?:\/\//.test(v),
      'must be an http(s) URL',
    ),
    // JSON object keyed by LlmTask, or a path to a JSON file. Defaults to the
    // built-in policy that reproduces the pre-router behaviour.
    LLM_POLICY: optionalString,
    LLM_POLICY_FILE: optionalString,

    // ── LLM budgets and shared guards (#71) ───────────────────────────────
    // Counted per UTC day across all providers and instances (see
    // src/lib/llm-budget.ts). Costs are estimates from a static price table.
    LLM_DAILY_TOKEN_BUDGET: z.string().default('2000000').transform(Number)
      .pipe(z.number().int().positive()),
    LLM_DAILY_COST_BUDGET_MICROS: z.string().default('20000000').transform(Number)
      .pipe(z.number().int().positive()),
    // Share of the budgets held back for admin-triggered work (cron stops first).
    LLM_ADMIN_RESERVE_PCT: z.string().default('10').transform(Number)
      .pipe(z.number().min(0).max(100)),
    LLM_ANTHROPIC_RPM: z.string().default('12').transform(Number)
      .pipe(z.number().int().positive()),
    LLM_GEMINI_RPM: z.string().default('15').transform(Number)
      .pipe(z.number().int().positive()),
    LLM_BREAKER_FAILURE_THRESHOLD: z.string().default('3').transform(Number)
      .pipe(z.number().int().positive()),
    LLM_BREAKER_OPEN_MS: z.string().default('3600000').transform(Number)
      .pipe(z.number().int().positive()),
    // What to do when the guard store (Redis) is unreachable: refuse LLM calls
    // (closed, recommended in production) or use a per-process limiter (open).
    LLM_REDIS_FAIL_MODE: z.enum(['closed', 'open']).default('closed'),

    // ── IPFS ──────────────────────────────────────────────────────────────
    PINATA_API_KEY: optionalString,
    PINATA_SECRET_API_KEY: optionalString,
    IPFS_GATEWAY_URL: z.string().url().default('https://gateway.pinata.cloud/ipfs'),
    // Local verified content store (#100). Both are byte caps.
    IPFS_CACHE_MAX_OBJECT_BYTES: z.string().default('262144').transform(Number)
      .pipe(z.number().int().positive()),
    IPFS_CACHE_BUDGET_BYTES: z.string().default('268435456').transform(Number)
      .pipe(z.number().int().positive()),

    // ── Transparency reports (#159) ───────────────────────────────────────
    REPORTS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    REPORT_CRON: z.string().default('10 0 * * *'),
    REPORT_MODE: z.enum(['dry-run', 'live']).default('dry-run'),

    // ── Treasury admin console (#156) ─────────────────────────────────────
    // Lifetime of a prepared unsigned transaction.
    TREASURY_OP_TTL_SECONDS: z.string().default('3600').transform(Number)
      .pipe(z.number().int().positive()),
    // Optional stricter backend policy for withdraw operations.
    TREASURY_WITHDRAW_MIN_SIGNERS: z.string().default('0').transform(Number)
      .pipe(z.number().int().min(0).max(20)),
    // #147 — development-only local IPFS stub selected explicitly.
    IPFS_TRANSPORT: z.enum(['pinata', 'local']).default('pinata'),
    IPFS_LOCAL_DIR: z.string().default('.ipfs-local'),

    // ── Data sources ──────────────────────────────────────────────────────
    NEWSAPI_KEY: optionalString,
    FRED_API_KEY: optionalString,

    // ── Resilience & Timeouts ─────────────────────────────────────────────
    TIMEOUT_RPC_READ_MS: z.string().default('8000').transform(Number),
    TIMEOUT_RPC_WRITE_MS: z.string().default('45000').transform(Number),
    TIMEOUT_RPC_EVENTS_MS: z.string().default('15000').transform(Number),
    TIMEOUT_LLM_MS: z.string().default('60000').transform(Number),
    TIMEOUT_IPFS_PIN_MS: z.string().default('20000').transform(Number),
    TIMEOUT_IPFS_FETCH_MS: z.string().default('15000').transform(Number),
    TIMEOUT_DATASOURCE_MS: z.string().default('10000').transform(Number),

    // Bulkheads (max concurrent)
    BULKHEAD_LLM: z.string().default('2').transform(Number),
    BULKHEAD_IPFS: z.string().default('4').transform(Number),
    BULKHEAD_RPC_READ: z.string().default('16').transform(Number),
    BULKHEAD_RPC_WRITE: z.string().default('4').transform(Number),
    BULKHEAD_RPC_EVENTS: z.string().default('4').transform(Number),
    BULKHEAD_DATASOURCE: z.string().default('8').transform(Number),
    BULKHEAD_QUEUE: z.string().default('32').transform(Number),

    // Request & cycle deadlines
    HTTP_REQUEST_TIMEOUT_MS: z.string().default('30000').transform(Number),
    CYCLE_DEADLINE_MS: z.string().default('600000').transform(Number),
    IPFS_MAX_BYTES: z.string().default('2097152').transform(Number),

    // ── Trace Audit (Issue #150) ──────────────────────────────────────────
    TRACE_AUDIT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    TRACE_AUDIT_CRON: z.string().default('40 */2 * * *'),
    TRACE_AUDIT_RECHECK_HOURS: z.string().default('168').transform(Number),
    TRACE_AUDIT_MAX_RPC: z.string().default('500').transform(Number),
    TRACE_AUDIT_MAX_FETCHES: z.string().default('100').transform(Number),
    TRACE_AUDIT_MAX_BYTES: z.string().default('2097152').transform(Number),

    // ── Trace publication queue (Issue #131) ──────────────────────────────
    TRACE_PUBLISH_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    TRACE_PUBLISH_CRON: z.string().default('*/30 * * * * *'),
    TRACE_PUBLISH_MAX_ATTEMPTS: z
      .string()
      .default('8')
      .transform(Number)
      .refine((n) => Number.isInteger(n) && n >= 1 && n <= 100, 'must be an integer between 1 and 100'),
    TRACE_CONFIRM_TIMEOUT_MS: z
      .string()
      .default('600000')
      .transform(Number)
      .refine((n) => Number.isInteger(n) && n >= 10_000, 'must be an integer >= 10000'),

    // ── Copy Trading (Issue #151) ─────────────────────────────────────────
    COPY_TRADE_TTL_MINUTES: z.string().default('30').transform(Number),
    COPY_TRADE_MAX_PENDING: z.string().default('5').transform(Number),
  })
  .superRefine((env, ctx) => {
    if (env.SECRETS_PROVIDER === 'vault') {
      if (!env.VAULT_ADDR) ctx.addIssue({ code: 'custom', path: ['VAULT_ADDR'], message: 'is required when SECRETS_PROVIDER=vault' });
      else if (!URL.canParse(env.VAULT_ADDR)) ctx.addIssue({ code: 'custom', path: ['VAULT_ADDR'], message: 'must be a URL' });
      if (!env.VAULT_TOKEN_FILE) ctx.addIssue({ code: 'custom', path: ['VAULT_TOKEN_FILE'], message: 'is required when SECRETS_PROVIDER=vault' });
      if (!env.VAULT_KV_PATH) ctx.addIssue({ code: 'custom', path: ['VAULT_KV_PATH'], message: 'is required when SECRETS_PROVIDER=vault' });
    }
    if (env.NODE_ENV === 'production' && env.IPFS_TRANSPORT === 'local') {
      ctx.addIssue({ code: 'custom', path: ['IPFS_TRANSPORT'], message: 'local IPFS is development-only' });
    }
    if (env.CHAIN_EXECUTION_MODE === 'live') {
      if (!env.AGENT_SECRET_KEY) {
        ctx.addIssue({ code: 'custom', path: ['AGENT_SECRET_KEY'], message: 'is required when CHAIN_EXECUTION_MODE=live' });
      }
      if (env.STELLAR_NETWORK_PASSPHRASE !== Networks.TESTNET) {
        ctx.addIssue({
          code: 'custom',
          path: ['STELLAR_NETWORK_PASSPHRASE'],
          message: 'live mode is testnet-only; use the testnet passphrase',
        });
      }
    }
  });

export type Config = z.infer<typeof envSchema> & {
  /** Secrets generated for this process because they were not configured. */
  ephemeralSecrets: string[];
};

export class ConfigError extends Error {}

/** Parses an env object. Throws ConfigError naming every bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  let resolvedEnv: NodeJS.ProcessEnv;
  try {
    resolvedEnv = resolveFileVars(env);
  } catch (err) {
    throw new ConfigError(`Invalid environment configuration:\n  ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = envSchema.safeParse(resolvedEnv);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'} ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const data = parsed.data;
  // Using <NAME>_FILE implies the file provider, so refresh re-reads the
  // mounts instead of the (possibly empty) plain environment variable.
  if (
    data.SECRETS_PROVIDER === 'env' &&
    SECRET_NAMES.some((name) => Boolean(resolvedEnv[`${name}_FILE`]))
  ) {
    data.SECRETS_PROVIDER = 'file';
  }

  const problems = validateSecrets(data, data.NODE_ENV, {
    // A remote provider supplies secret values after loadConfig; boot-time
    // presence checks move to initSecrets().
    requireProductionSecrets: data.SECRETS_PROVIDER !== 'vault',
  });
  if (problems.length > 0) {
    throw new ConfigError(`Invalid environment configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }

  const ephemeralSecrets: string[] = [];
  if (!data.JWT_SECRET && data.NODE_ENV !== 'production') {
    data.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    ephemeralSecrets.push('JWT_SECRET');
  }
  if (!data.AUTH_SIGNING_SECRET && data.NODE_ENV !== 'production') {
    data.AUTH_SIGNING_SECRET = Keypair.random().secret();
    ephemeralSecrets.push('AUTH_SIGNING_SECRET');
  }
  if (!data.AUTH_WEB_AUTH_DOMAIN) data.AUTH_WEB_AUTH_DOMAIN = data.AUTH_HOME_DOMAIN;
  // Prisma's env("DATABASE_URL") reads this process-wide value at client build.
  if (data.DATABASE_URL) process.env.DATABASE_URL = data.DATABASE_URL;
  return { ...data, ephemeralSecrets };
}

function loadOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export const config = loadOrExit();
