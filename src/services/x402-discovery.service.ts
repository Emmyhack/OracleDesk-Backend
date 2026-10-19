/**
 * Live x402 trace price discovery client (#63).
 *
 * Discovers live payment requirements for trace unlocks directly from the
 * authoritative x402 service rather than using hard-coded price constants.
 *
 * Validates:
 * - Scheme: exact
 * - Network: matches configured Stellar network (passphrase / CAIP-2)
 * - Asset: matches CONTRACTS.usdc
 * - Amount: non-negative integer base-unit string
 * - Recipient: valid Stellar account / contract address
 *
 * Implements cache with configurable TTL and single-flight stampede protection.
 */
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { config } from '../config';
import { CONTRACTS } from '../config/contracts';
import { formatUsdc } from '../lib/amounts';
import { logger } from '../lib/logger';

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  asset?: string;
  payTo: string;
  amount: string;
  maxAmountRequired?: string;
  resource?: unknown;
  extra?: Record<string, unknown>;
}

export interface ValidatedPaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  payTo: string;
  amountRaw: string;
  amountUsdc: string;
  resource?: string;
  discoveredAt: Date;
  expiresAt: Date;
}

export interface DiscoveredTracePrice {
  amountRaw: string;
  amountUsdc: string;
  status: 'discovered' | 'unknown';
  requirements: ValidatedPaymentRequirements | null;
  error?: string;
}

interface CacheEntry {
  requirements: ValidatedPaymentRequirements;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<ValidatedPaymentRequirements | null>>();

let fetchImpl: typeof fetch = globalThis.fetch;

/** Test seam to inject custom fetch implementation */
export function setX402FetchImpl(customFetch: typeof fetch): () => void {
  const prev = fetchImpl;
  fetchImpl = customFetch;
  return () => {
    fetchImpl = prev;
  };
}

/** Test seam to clear the discovery cache */
export function clearX402PriceCache(): void {
  cache.clear();
  inFlightRequests.clear();
}

/** Maps configured network passphrase to expected CAIP-2 identifier */
export function expectedCaipNetwork(passphrase = config.STELLAR_NETWORK_PASSPHRASE): string {
  if (passphrase === Networks.TESTNET) return 'stellar:testnet';
  if (passphrase === Networks.PUBLIC) return 'stellar:pubnet';
  return config.X402_NETWORK || 'stellar:testnet';
}

/** Validates whether a network string matches the deployment configuration */
export function isNetworkValid(network: string): boolean {
  if (!network) return false;
  const expected = expectedCaipNetwork();
  return (
    network === expected ||
    network === config.X402_NETWORK ||
    network === config.STELLAR_NETWORK_PASSPHRASE ||
    (network === 'stellar:testnet' && config.STELLAR_NETWORK_PASSPHRASE === Networks.TESTNET) ||
    (network === 'stellar:pubnet' && config.STELLAR_NETWORK_PASSPHRASE === Networks.PUBLIC)
  );
}

/** Validates whether an asset identifier matches the configured USDC contract */
export function isAssetValid(asset?: string): boolean {
  // If omitted by x402 service, default trace currency is deployment USDC
  if (!asset) return true;
  const configuredUsdc = CONTRACTS.usdc?.toLowerCase();
  const raw = asset.toLowerCase();
  return (
    raw === configuredUsdc ||
    raw === 'usdc' ||
    raw.startsWith('usdc:') ||
    raw.includes(configuredUsdc ?? '')
  );
}

/** Validates raw PaymentRequirement structure against deployment rules */
export function validatePaymentRequirement(
  req: unknown,
  resourceUri?: string,
): ValidatedPaymentRequirements {
  if (!req || typeof req !== 'object') {
    throw new Error('Payment requirements payload is not an object');
  }

  const r = req as Record<string, unknown>;

  // 1. Scheme check
  if (r.scheme !== 'exact') {
    throw new Error(`Unsupported payment scheme '${r.scheme}'; expected 'exact'`);
  }

  // 2. Network check
  const network = typeof r.network === 'string' ? r.network : '';
  if (!isNetworkValid(network)) {
    throw new Error(`Payment network '${network}' does not match deployment network`);
  }

  // 3. Asset check
  const asset = typeof r.asset === 'string' ? r.asset : (CONTRACTS.usdc || 'USDC');
  if (!isAssetValid(asset)) {
    throw new Error(`Payment asset '${asset}' does not match expected USDC '${CONTRACTS.usdc}'`);
  }

  // 4. Amount check: must be a valid non-negative integer base units string
  const rawAmount = r.amount ?? r.maxAmountRequired;
  if (rawAmount === undefined || rawAmount === null || typeof rawAmount !== 'string') {
    throw new Error('Payment requirement missing amount string');
  }
  if (!/^\d+$/.test(rawAmount)) {
    throw new Error(`Malformed payment amount '${rawAmount}'; must be integer digits`);
  }
  const amountBigInt = BigInt(rawAmount);
  if (amountBigInt <= 0n) {
    throw new Error(`Invalid payment amount '${rawAmount}'; must be greater than zero`);
  }

  // 5. Recipient / payTo check
  const payTo = typeof r.payTo === 'string' ? r.payTo : '';
  if (!payTo || (!StrKey.isValidEd25519PublicKey(payTo) && !StrKey.isValidContract(payTo))) {
    throw new Error(`Invalid payment recipient '${payTo}'; must be a valid Stellar account or contract`);
  }

  const now = new Date();
  const ttlMs = config.X402_PRICE_CACHE_TTL_MS || 60_000;

  return {
    scheme: 'exact',
    network,
    asset,
    payTo,
    amountRaw: rawAmount,
    amountUsdc: formatUsdc(amountBigInt),
    resource: typeof r.resource === 'string' ? r.resource : resourceUri,
    discoveredAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };
}

/**
 * Extracts PaymentRequirement from a 402 response (header or JSON body).
 */
export async function extractRequirementsFromResponse(
  res: Response,
  targetUrl: string,
): Promise<ValidatedPaymentRequirements> {
  if (res.status !== 402) {
    throw new Error(`Expected 402 Payment Required response from x402 service, got HTTP ${res.status}`);
  }

  let requiredObj: any = null;
  const header = res.headers.get('payment-required');

  if (header) {
    try {
      requiredObj = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch (err) {
      throw new Error(`Malformed base64 payment-required header: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    try {
      requiredObj = await res.json();
    } catch (err) {
      throw new Error(`Failed to parse 402 response JSON body: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!requiredObj || typeof requiredObj !== 'object') {
    throw new Error('Parsed 402 response is not a valid object');
  }

  const accepts = Array.isArray(requiredObj.accepts)
    ? requiredObj.accepts
    : Array.isArray(requiredObj.paymentRequirements)
      ? requiredObj.paymentRequirements
      : requiredObj.accept ? [requiredObj.accept] : [];

  if (accepts.length === 0) {
    throw new Error('x402 challenge response contains no accepted payment requirements');
  }

  // Validate the first matching requirement
  return validatePaymentRequirement(accepts[0], targetUrl);
}

/**
 * Discovers live payment requirements from the authoritative x402 service.
 * Supports caching with TTL and stampede protection.
 */
export async function discoverLiveRequirements(
  resourcePath = '/traces/preview',
  opts: { forceRefresh?: boolean } = {},
): Promise<ValidatedPaymentRequirements | null> {
  const serviceUrl = config.X402_SERVICE_URL?.trim();
  if (!serviceUrl) {
    logger.debug('X402_SERVICE_URL not configured; trace price discovery unavailable');
    return null;
  }

  const normalizedPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
  const targetUrl = `${serviceUrl.replace(/\/$/, '')}${normalizedPath}`;
  const cacheKey = targetUrl;
  const now = Date.now();

  // 1. Check cache
  if (!opts.forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.requirements;
    }
  }

  // 2. Stampede protection: coalesce on in-flight promise
  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    const timeoutMs = config.X402_DISCOVERY_TIMEOUT_MS || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Try HEAD first; if unsupported (e.g. 405), fall back to GET
      let res: Response;
      try {
        res = await fetchImpl(targetUrl, {
          method: 'HEAD',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (res.status === 405) {
          res = await fetchImpl(targetUrl, {
            method: 'GET',
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          });
        }
      } catch (headErr) {
        // If HEAD failed with network error/abort, try GET if not aborted
        if (controller.signal.aborted) throw headErr;
        res = await fetchImpl(targetUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      }

      const validated = await extractRequirementsFromResponse(res, targetUrl);

      // Cache validated result
      cache.set(cacheKey, {
        requirements: validated,
        expiresAt: validated.expiresAt.getTime(),
      });

      return validated;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ targetUrl, err: errMsg }, 'x402 trace price discovery failed');
      return null;
    } finally {
      clearTimeout(timer);
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * High-level function to discover trace price for previews.
 * Reports price as unknown if discovery fails or cannot be validated.
 */
export async function discoverTracePrice(
  traceIdentifier?: string | bigint | null,
): Promise<DiscoveredTracePrice> {
  const resourcePath = traceIdentifier ? `/traces/${traceIdentifier}` : '/traces/preview';
  const reqs = await discoverLiveRequirements(resourcePath);

  if (!reqs) {
    return {
      amountRaw: '',
      amountUsdc: '',
      status: 'unknown',
      requirements: null,
      error: 'PRICE_DISCOVERY_FAILED',
    };
  }

  return {
    amountRaw: reqs.amountRaw,
    amountUsdc: reqs.amountUsdc,
    status: 'discovered',
    requirements: reqs,
  };
}
