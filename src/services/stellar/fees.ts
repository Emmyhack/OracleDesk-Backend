import { rpc } from '@stellar/stellar-sdk';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { rpcServer } from './clients';

export type OperationClass = 'market_create' | 'trade' | 'trace_publish' | 'maintenance';

export const OPERATION_CLASSES: readonly OperationClass[] = [
  'market_create',
  'trade',
  'trace_publish',
  'maintenance',
] as const;

export type PercentileKey =
  | 'p10'
  | 'p20'
  | 'p30'
  | 'p40'
  | 'p50'
  | 'p60'
  | 'p70'
  | 'p80'
  | 'p90'
  | 'p95'
  | 'p99'
  | 'min'
  | 'mode'
  | 'max';

export interface FeePolicy {
  percentile: PercentileKey;
  floor: bigint;
  cap: bigint;
  budget: bigint;
}

export const DEFAULT_FEE_POLICIES: Record<OperationClass, FeePolicy> = {
  market_create: {
    percentile: 'p90',
    floor: 100_000n,
    cap: 5_000_000n,
    budget: 50_000_000n,
  },
  trade: {
    percentile: 'p80',
    floor: 10_000n,
    cap: 2_000_000n,
    budget: 25_000_000n,
  },
  trace_publish: {
    percentile: 'p50',
    floor: 10_000n,
    cap: 1_000_000n,
    budget: 15_000_000n,
  },
  maintenance: {
    percentile: 'p50',
    floor: 10_000n,
    cap: 1_000_000n,
    budget: 15_000_000n,
  },
};

export interface FeeOracleSnapshot {
  networkPassphrase: string;
  rpcUrl: string;
  lastFetchedAt: Date | null;
  cachedUntil: Date | null;
  stale: boolean;
  sorobanInclusionFee: Record<string, string> | null;
  policies: Record<OperationClass, {
    percentile: string;
    floor: string;
    cap: string;
    budget: string;
  }>;
}

export interface FeeStatsSource {
  getFeeStats(): Promise<any>;
}

export class FeeOracle {
  private cacheKey: string;
  private policies: Record<OperationClass, FeePolicy>;
  private lastStats: any = null;
  private lastFetchedAt: number | null = null;
  private inFlightPromise: Promise<any> | null = null;
  private feeStatsSource: FeeStatsSource;

  constructor(
    private networkPassphrase: string = config.STELLAR_NETWORK_PASSPHRASE,
    private rpcUrl: string = config.STELLAR_RPC_URL,
    private cacheTtlMs: number = (config as any).FEE_STATS_CACHE_MS ?? 10_000,
    private maxAgeMs: number = (config as any).FEE_STATS_MAX_AGE_MS ?? 60_000,
    customSource?: FeeStatsSource,
  ) {
    this.cacheKey = `${this.networkPassphrase}:${this.rpcUrl}`;
    this.feeStatsSource = customSource ?? rpcServer;
    this.policies = this.loadPolicies();
  }

  public setSource(source: FeeStatsSource) {
    this.feeStatsSource = source;
  }

  public resetCache(): void {
    this.lastStats = null;
    this.lastFetchedAt = null;
    this.inFlightPromise = null;
  }

  public getPolicies(): Record<OperationClass, FeePolicy> {
    return this.policies;
  }

  private loadPolicies(): Record<OperationClass, FeePolicy> {
    const policies: Record<OperationClass, FeePolicy> = {
      market_create: { ...DEFAULT_FEE_POLICIES.market_create },
      trade: { ...DEFAULT_FEE_POLICIES.trade },
      trace_publish: { ...DEFAULT_FEE_POLICIES.trace_publish },
      maintenance: { ...DEFAULT_FEE_POLICIES.maintenance },
    };

    const overrideJson = (config as any).FEE_POLICY_JSON;
    if (overrideJson) {
      try {
        const overrides = typeof overrideJson === 'string' ? JSON.parse(overrideJson) : overrideJson;
        for (const [cls, pol] of Object.entries(overrides)) {
          if (OPERATION_CLASSES.includes(cls as OperationClass) && pol && typeof pol === 'object') {
            const p = pol as any;
            const existing = policies[cls as OperationClass];
            policies[cls as OperationClass] = {
              percentile: p.percentile ?? existing.percentile,
              floor: p.floor !== undefined ? BigInt(p.floor) : existing.floor,
              cap: p.cap !== undefined ? BigInt(p.cap) : existing.cap,
              budget: p.budget !== undefined ? BigInt(p.budget) : existing.budget,
            };
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to parse FEE_POLICY_JSON override');
      }
    }
    return policies;
  }

  public async fetchFeeStats(): Promise<any> {
    const now = Date.now();
    if (this.lastStats && this.lastFetchedAt && now - this.lastFetchedAt < this.cacheTtlMs) {
      return this.lastStats;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const stats = await this.feeStatsSource.getFeeStats();
        this.lastStats = stats;
        this.lastFetchedAt = Date.now();
        return stats;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'getFeeStats RPC call failed');
        if (this.lastStats && this.lastFetchedAt && Date.now() - this.lastFetchedAt < this.maxAgeMs) {
          logger.info('Using last good fee stats within max age window');
          return this.lastStats;
        }
        return null;
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  public async pickInclusionFee(opClass: OperationClass): Promise<bigint> {
    const policy = this.policies[opClass];
    const stats = await this.fetchFeeStats();

    if (!stats || !stats.sorobanInclusionFee) {
      return policy.floor;
    }

    const sFee = stats.sorobanInclusionFee;
    const txCount = sFee.transactionCount !== undefined ? BigInt(sFee.transactionCount) : 0n;
    if (txCount === 0n) {
      return policy.floor;
    }

    const percentileRaw = sFee[policy.percentile];
    if (percentileRaw === undefined || percentileRaw === null || percentileRaw === '') {
      return policy.floor;
    }

    let fee: bigint;
    try {
      fee = BigInt(percentileRaw);
    } catch {
      return policy.floor;
    }

    if (fee < policy.floor) {
      return policy.floor;
    }

    if (fee > policy.cap) {
      logger.warn(
        { opClass, fee: fee.toString(), cap: policy.cap.toString() },
        'Fee percentile value exceeds cap; cap is binding',
      );
      return policy.cap;
    }

    return fee;
  }

  public getSnapshot(): FeeOracleSnapshot {
    const now = Date.now();
    const stale = this.lastFetchedAt ? now - this.lastFetchedAt > this.cacheTtlMs : true;
    return {
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      lastFetchedAt: this.lastFetchedAt ? new Date(this.lastFetchedAt) : null,
      cachedUntil: this.lastFetchedAt ? new Date(this.lastFetchedAt + this.cacheTtlMs) : null,
      stale,
      sorobanInclusionFee: this.lastStats?.sorobanInclusionFee ?? null,
      policies: Object.fromEntries(
        Object.entries(this.policies).map(([k, v]) => [
          k,
          {
            percentile: v.percentile,
            floor: v.floor.toString(),
            cap: v.cap.toString(),
            budget: v.budget.toString(),
          },
        ]),
      ) as any,
    };
  }
}

const oraclesByCacheKey = new Map<string, FeeOracle>();

export function getFeeOracle(
  networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE,
  rpcUrl = config.STELLAR_RPC_URL,
): FeeOracle {
  const key = `${networkPassphrase}:${rpcUrl}`;
  let oracle = oraclesByCacheKey.get(key);
  if (!oracle) {
    oracle = new FeeOracle(networkPassphrase, rpcUrl);
    oraclesByCacheKey.set(key, oracle);
  }
  return oracle;
}
