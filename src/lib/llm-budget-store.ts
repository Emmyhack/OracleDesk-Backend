/**
 * Storage for the shared LLM guards (#71): a per-provider token bucket, a
 * per-provider circuit breaker with half-open probing, and daily token/cost
 * budgets with reservations.
 *
 * `RedisGuardStore` runs each decision as one atomic Lua script. Time comes
 * from Redis `TIME` inside the script (never Node's clock), so instances with
 * skewed clocks agree on bucket refill, breaker expiry and the UTC budget day.
 * `MemoryGuardStore` is a line-for-line JS reference of the same logic with an
 * injectable clock; tests run one table of scenarios against both.
 *
 * Key layout (all under `<prefix>:`):
 *   breaker:<provider>   hash  state, openedUntil, failures, probeHolder, probeUntil
 *   bucket:<provider>    hash  tokens, ts
 *   budget:<yyyy-mm-dd>  hash  tokens, costMicros, reserved   (48 h TTL)
 *   leases               zset  member "<leaseId>|<day>|<estimate>", score = expiry ms
 * A lease that is never recorded (crash, hung request) is reclaimed when its
 * score passes: the next `acquire` subtracts its estimate from `reserved`.
 * The budget key is derived inside the script from Redis time, so this layout
 * targets a single Redis (or one hash slot), not a sharded cluster.
 */
import type Redis from 'ioredis';

export type Provider = 'anthropic' | 'gemini';
export type Priority = 'cron' | 'admin';
export type BreakerState = 'closed' | 'open' | 'half-open';
export type CallOutcome = 'ok' | 'error' | 'quota';

export interface AcquireParams {
  provider: Provider;
  leaseId: string;
  priority: Priority;
  /** Tokens to reserve (input estimate + max output). */
  estimate: number;
  rpm: number;
  tokenBudget: number;
  costBudgetMicros: number;
  reservePct: number;
  /** How long a reservation lives if never recorded. */
  leaseTtlMs: number;
  /** How long a half-open probe may hold the breaker. */
  probeTtlMs: number;
}

export type AcquireResult =
  | { ok: true; day: string; probe: boolean }
  | { ok: false; reason: 'CIRCUIT_OPEN' | 'RATE_LIMITED' | 'BUDGET_EXCEEDED'; retryAfterMs: number };

export interface RecordParams {
  provider: Provider;
  leaseId: string;
  day: string;
  estimate: number;
  probe: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  outcome: CallOutcome;
  failureThreshold: number;
  /** Breaker open time for failures and for quotas with no provider hint. */
  openMs: number;
  /** For quotas: hold the breaker at least until the next UTC midnight. */
  openUntilMidnight: boolean;
}

export interface UsageSnapshot {
  day: string;
  tokens: number;
  costMicros: number;
  reserved: number;
  breakers: Record<Provider, { state: BreakerState; openedUntil: number | null }>;
}

export interface LlmGuardStore {
  acquire(p: AcquireParams): Promise<AcquireResult>;
  record(p: RecordParams): Promise<void>;
  breakerState(provider: Provider): Promise<BreakerState>;
  usage(): Promise<UsageSnapshot>;
  /** SET NX with a TTL; true when this caller created the key. */
  setOnce(key: string, ttlSeconds: number): Promise<boolean>;
}

const DAY_MS = 86_400_000;
const providers: Provider[] = ['anthropic', 'gemini'];

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ─── Lua ──────────────────────────────────────────────────────────────────────

const LUA_PRELUDE = `
local t = redis.call('TIME')
local secs = tonumber(t[1])
local now = secs * 1000 + math.floor(tonumber(t[2]) / 1000)
local function civil(sec)
  local z = math.floor(sec / 86400) + 719468
  local era = math.floor(z / 146097)
  local doe = z - era * 146097
  local yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365)
  local y = yoe + era * 400
  local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
  local mp = math.floor((5 * doy + 2) / 153)
  local d = doy - math.floor((153 * mp + 2) / 5) + 1
  local m = mp < 10 and mp + 3 or mp - 9
  if m <= 2 then y = y + 1 end
  return string.format('%04d-%02d-%02d', y, m, d)
end
local function msToMidnight() return (86400 - (secs % 86400)) * 1000 end
`;

/**
 * KEYS: [1] breaker, [2] bucket, [3] leases
 * ARGV: 1 leaseId, 2 priority, 3 estimate, 4 rpm, 5 tokenBudget, 6 costBudgetMicros,
 *       7 reservePct, 8 leaseTtlMs, 9 probeTtlMs, 10 prefix
 * Returns {'OK', day, probe} or {reason, retryAfterMs}.
 */
export const ACQUIRE_LUA = `${LUA_PRELUDE}
local day = civil(secs)
local prefix = ARGV[10]
local budgetKey = prefix .. ':budget:' .. day

-- 0. reclaim reservations whose lease expired without a record() (crash/hang)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)
for _, member in ipairs(expired) do
  local _, d, est = string.match(member, '^(.-)|(.-)|(%d+)$')
  if d then
    local bk = prefix .. ':budget:' .. d
    local r = tonumber(redis.call('HGET', bk, 'reserved') or '0') - tonumber(est)
    if r < 0 then r = 0 end
    redis.call('HSET', bk, 'reserved', r)
  end
  redis.call('ZREM', KEYS[3], member)
end

-- a. breaker
local b = redis.call('HMGET', KEYS[1], 'state', 'openedUntil', 'probeUntil')
local state = b[1] or 'closed'
local becomeProbe = false
if state == 'open' then
  local openedUntil = tonumber(b[2] or '0')
  if now < openedUntil then return {'CIRCUIT_OPEN', openedUntil - now} end
  becomeProbe = true
elseif state == 'half-open' then
  local probeUntil = tonumber(b[3] or '0')
  if now < probeUntil then return {'CIRCUIT_OPEN', probeUntil - now} end
  becomeProbe = true -- the previous probe hung past its TTL
end

-- b. token bucket (capacity = rpm, refilled at rpm/60000 per ms)
local rpm = tonumber(ARGV[4])
local bk = redis.call('HMGET', KEYS[2], 'tokens', 'ts')
local tokens = tonumber(bk[1])
local ts = tonumber(bk[2])
if not tokens then tokens = rpm; ts = now end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(rpm, tokens + elapsed * rpm / 60000)
if tokens < 1 then
  return {'RATE_LIMITED', math.ceil((1 - tokens) * 60000 / rpm)}
end

-- c. daily budget
local bud = redis.call('HMGET', budgetKey, 'tokens', 'costMicros', 'reserved')
local used = tonumber(bud[1] or '0')
local cost = tonumber(bud[2] or '0')
local reserved = tonumber(bud[3] or '0')
local est = tonumber(ARGV[3])
local tokenCap = tonumber(ARGV[5])
local costCap = tonumber(ARGV[6])
if ARGV[2] == 'cron' then
  local keep = (100 - tonumber(ARGV[7])) / 100
  tokenCap = tokenCap * keep
  costCap = costCap * keep
end
if used + reserved + est > tokenCap or cost >= costCap then
  return {'BUDGET_EXCEEDED', msToMidnight()}
end

-- commit
redis.call('HSET', KEYS[2], 'tokens', tokens - 1, 'ts', now)
redis.call('PEXPIRE', KEYS[2], 3600000)
redis.call('HINCRBY', budgetKey, 'reserved', est)
redis.call('EXPIRE', budgetKey, 172800)
redis.call('ZADD', KEYS[3], now + tonumber(ARGV[8]), ARGV[1] .. '|' .. day .. '|' .. ARGV[3])
local probe = 0
if becomeProbe then
  redis.call('HSET', KEYS[1], 'state', 'half-open', 'probeHolder', ARGV[1], 'probeUntil', now + tonumber(ARGV[9]))
  probe = 1
end
return {'OK', day, probe}
`;

/**
 * KEYS: [1] breaker, [2] leases
 * ARGV: 1 leaseId, 2 day, 3 estimate, 4 probe, 5 inputTokens, 6 outputTokens, 7 costMicros,
 *       8 outcome, 9 failureThreshold, 10 openMs, 11 openUntilMidnight, 12 prefix
 */
export const RECORD_LUA = `${LUA_PRELUDE}
local prefix = ARGV[12]
local bk = prefix .. ':budget:' .. ARGV[2]
local member = ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3]

-- release the reservation (unless acquire already reclaimed it)
if redis.call('ZREM', KEYS[2], member) == 1 then
  local r = tonumber(redis.call('HGET', bk, 'reserved') or '0') - tonumber(ARGV[3])
  if r < 0 then r = 0 end
  redis.call('HSET', bk, 'reserved', r)
end
local total = tonumber(ARGV[5]) + tonumber(ARGV[6])
if total > 0 then redis.call('HINCRBY', bk, 'tokens', total) end
if tonumber(ARGV[7]) > 0 then redis.call('HINCRBY', bk, 'costMicros', tonumber(ARGV[7])) end
redis.call('EXPIRE', bk, 172800)

local b = redis.call('HMGET', KEYS[1], 'state', 'failures', 'probeHolder')
local state = b[1] or 'closed'
local failures = tonumber(b[2] or '0')
local holder = b[3]
local outcome = ARGV[8]
local openMs = tonumber(ARGV[10])

local function open(ms)
  redis.call('HSET', KEYS[1], 'state', 'open', 'openedUntil', now + ms, 'failures', 0)
  redis.call('HDEL', KEYS[1], 'probeHolder', 'probeUntil')
end

if outcome == 'ok' then
  if state == 'half-open' then
    if holder == ARGV[1] then
      redis.call('HSET', KEYS[1], 'state', 'closed', 'failures', 0)
      redis.call('HDEL', KEYS[1], 'probeHolder', 'probeUntil', 'openedUntil')
    end
  elseif state == 'closed' and failures > 0 then
    redis.call('HSET', KEYS[1], 'failures', 0)
  end
elseif outcome == 'quota' then
  if ARGV[11] == '1' then
    local m = msToMidnight()
    if m > openMs then openMs = m end
  end
  open(openMs)
else
  if state == 'half-open' then
    if holder == ARGV[1] then open(openMs) end
  elseif state == 'closed' then
    failures = failures + 1
    if failures >= tonumber(ARGV[9]) then open(openMs)
    else redis.call('HSET', KEYS[1], 'failures', failures) end
  end
end
return 1
`;

// ─── Redis ────────────────────────────────────────────────────────────────────

export class RedisGuardStore implements LlmGuardStore {
  private defined = new WeakSet<Redis>();

  constructor(private readonly redis: () => Redis, private readonly prefix = 'llm') {}

  private client(): any {
    const r = this.redis();
    if (!this.defined.has(r)) {
      // defineCommand uses EVALSHA and falls back to EVAL after SCRIPT FLUSH.
      r.defineCommand('llmAcquire', { numberOfKeys: 3, lua: ACQUIRE_LUA });
      r.defineCommand('llmRecord', { numberOfKeys: 2, lua: RECORD_LUA });
      this.defined.add(r);
    }
    return r;
  }

  private key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  async acquire(p: AcquireParams): Promise<AcquireResult> {
    const res: Array<string | number> = await this.client().llmAcquire(
      this.key('breaker', p.provider), this.key('bucket', p.provider), this.key('leases'),
      p.leaseId, p.priority, p.estimate, p.rpm, p.tokenBudget, p.costBudgetMicros,
      p.reservePct, p.leaseTtlMs, p.probeTtlMs, this.prefix,
    );
    if (res[0] === 'OK') return { ok: true, day: String(res[1]), probe: Number(res[2]) === 1 };
    return { ok: false, reason: res[0] as 'CIRCUIT_OPEN' | 'RATE_LIMITED' | 'BUDGET_EXCEEDED', retryAfterMs: Number(res[1]) };
  }

  async record(p: RecordParams): Promise<void> {
    await this.client().llmRecord(
      this.key('breaker', p.provider), this.key('leases'),
      p.leaseId, p.day, p.estimate, p.probe ? 1 : 0, p.inputTokens, p.outputTokens, p.costMicros,
      p.outcome, p.failureThreshold, p.openMs, p.openUntilMidnight ? 1 : 0, this.prefix,
    );
  }

  private async serverNowMs(): Promise<number> {
    const [s, us] = await this.redis().time();
    return Number(s) * 1000 + Math.floor(Number(us) / 1000);
  }

  private async readBreaker(provider: Provider, now: number) {
    const [state, openedUntil] = await this.redis().hmget(this.key('breaker', provider), 'state', 'openedUntil');
    const until = openedUntil ? Number(openedUntil) : null;
    let s = (state as BreakerState | null) ?? 'closed';
    // An expired open breaker admits one probe on the next call.
    if (s === 'open' && until !== null && now >= until) s = 'half-open';
    return { state: s, openedUntil: until };
  }

  async breakerState(provider: Provider): Promise<BreakerState> {
    return (await this.readBreaker(provider, await this.serverNowMs())).state;
  }

  async usage(): Promise<UsageSnapshot> {
    const now = await this.serverNowMs();
    const day = utcDay(now);
    const [tokens, costMicros, reserved] = await this.redis().hmget(this.key('budget', day), 'tokens', 'costMicros', 'reserved');
    const breakers = {} as UsageSnapshot['breakers'];
    for (const p of providers) breakers[p] = await this.readBreaker(p, now);
    return { day, tokens: Number(tokens ?? 0), costMicros: Number(costMicros ?? 0), reserved: Number(reserved ?? 0), breakers };
  }

  async setOnce(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis().set(this.key('once', key), '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }
}

// ─── Memory reference implementation ──────────────────────────────────────────

interface MemBreaker { state: BreakerState; openedUntil: number; failures: number; probeHolder?: string; probeUntil: number }
interface MemBudget { tokens: number; costMicros: number; reserved: number }

export class MemoryGuardStore implements LlmGuardStore {
  private breakers = new Map<Provider, MemBreaker>();
  private buckets = new Map<Provider, { tokens: number; ts: number }>();
  private budgets = new Map<string, MemBudget>();
  private leases = new Map<string, number>(); // member -> expiry
  private once = new Map<string, number>();

  constructor(public clock: () => number = Date.now) {}

  private budget(day: string): MemBudget {
    let b = this.budgets.get(day);
    if (!b) { b = { tokens: 0, costMicros: 0, reserved: 0 }; this.budgets.set(day, b); }
    return b;
  }

  private breaker(provider: Provider): MemBreaker {
    let b = this.breakers.get(provider);
    if (!b) { b = { state: 'closed', openedUntil: 0, failures: 0, probeUntil: 0 }; this.breakers.set(provider, b); }
    return b;
  }

  private msToMidnight(now: number): number {
    return DAY_MS - (now % DAY_MS);
  }

  async acquire(p: AcquireParams): Promise<AcquireResult> {
    const now = this.clock();
    const day = utcDay(now);

    for (const [member, expiry] of [...this.leases]) {
      if (expiry > now) continue;
      const [, d, est] = member.split('|');
      const b = this.budget(d);
      b.reserved = Math.max(0, b.reserved - Number(est));
      this.leases.delete(member);
    }

    const br = this.breaker(p.provider);
    let becomeProbe = false;
    if (br.state === 'open') {
      if (now < br.openedUntil) return { ok: false, reason: 'CIRCUIT_OPEN', retryAfterMs: br.openedUntil - now };
      becomeProbe = true;
    } else if (br.state === 'half-open') {
      if (now < br.probeUntil) return { ok: false, reason: 'CIRCUIT_OPEN', retryAfterMs: br.probeUntil - now };
      becomeProbe = true;
    }

    const bucket = this.buckets.get(p.provider) ?? { tokens: p.rpm, ts: now };
    const tokens = Math.min(p.rpm, bucket.tokens + Math.max(0, now - bucket.ts) * p.rpm / 60_000);
    if (tokens < 1) return { ok: false, reason: 'RATE_LIMITED', retryAfterMs: Math.ceil((1 - tokens) * 60_000 / p.rpm) };

    const bud = this.budget(day);
    const keep = p.priority === 'cron' ? (100 - p.reservePct) / 100 : 1;
    if (bud.tokens + bud.reserved + p.estimate > p.tokenBudget * keep || bud.costMicros >= p.costBudgetMicros * keep) {
      return { ok: false, reason: 'BUDGET_EXCEEDED', retryAfterMs: this.msToMidnight(now) };
    }

    this.buckets.set(p.provider, { tokens: tokens - 1, ts: now });
    bud.reserved += p.estimate;
    this.leases.set(`${p.leaseId}|${day}|${p.estimate}`, now + p.leaseTtlMs);
    if (becomeProbe) {
      br.state = 'half-open';
      br.probeHolder = p.leaseId;
      br.probeUntil = now + p.probeTtlMs;
    }
    return { ok: true, day, probe: becomeProbe };
  }

  async record(p: RecordParams): Promise<void> {
    const now = this.clock();
    const bud = this.budget(p.day);
    if (this.leases.delete(`${p.leaseId}|${p.day}|${p.estimate}`)) {
      bud.reserved = Math.max(0, bud.reserved - p.estimate);
    }
    bud.tokens += p.inputTokens + p.outputTokens;
    bud.costMicros += p.costMicros;

    const br = this.breaker(p.provider);
    const open = (ms: number) => {
      br.state = 'open';
      br.openedUntil = now + ms;
      br.failures = 0;
      br.probeHolder = undefined;
      br.probeUntil = 0;
    };
    if (p.outcome === 'ok') {
      if (br.state === 'half-open') {
        if (br.probeHolder === p.leaseId) { br.state = 'closed'; br.failures = 0; br.probeHolder = undefined; br.probeUntil = 0; br.openedUntil = 0; }
      } else if (br.state === 'closed') br.failures = 0;
    } else if (p.outcome === 'quota') {
      open(p.openUntilMidnight ? Math.max(p.openMs, this.msToMidnight(now)) : p.openMs);
    } else if (br.state === 'half-open') {
      if (br.probeHolder === p.leaseId) open(p.openMs);
    } else if (br.state === 'closed') {
      br.failures += 1;
      if (br.failures >= p.failureThreshold) open(p.openMs);
    }
  }

  private effective(provider: Provider, now: number) {
    const br = this.breaker(provider);
    const state: BreakerState = br.state === 'open' && now >= br.openedUntil ? 'half-open' : br.state;
    return { state, openedUntil: br.openedUntil || null };
  }

  async breakerState(provider: Provider): Promise<BreakerState> {
    return this.effective(provider, this.clock()).state;
  }

  async usage(): Promise<UsageSnapshot> {
    const now = this.clock();
    const day = utcDay(now);
    const b = this.budget(day);
    return {
      day,
      tokens: b.tokens,
      costMicros: b.costMicros,
      reserved: b.reserved,
      breakers: { anthropic: this.effective('anthropic', now), gemini: this.effective('gemini', now) },
    };
  }

  async setOnce(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.clock();
    const expiry = this.once.get(key);
    if (expiry !== undefined && expiry > now) return false;
    this.once.set(key, now + ttlSeconds * 1000);
    return true;
  }
}
