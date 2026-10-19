/**
 * Reflector (SEP-40) feed registry (#90).
 *
 * Addresses are never hard-coded: they come from `REFLECTOR_FEEDS_JSON`, and
 * every entry carries a `source` citation so the committed address can be
 * audited. An empty registry disables price mode. Keyed by network passphrase
 * so testnet and mainnet never share an entry.
 */
import { config } from '../config';

export interface ReflectorFeedAssetOther {
  kind: 'other';
  symbol: string;
}
export interface ReflectorFeedAssetStellar {
  kind: 'stellar';
  address: string;
}
export type ReflectorFeedAsset = ReflectorFeedAssetStellar | ReflectorFeedAssetOther;

export interface ReflectorFeed {
  reflector: string;
  asset: ReflectorFeedAsset;
  quote: 'USD';
  maxStaleness: number;
  /** Doc URL or on-chain lookup that justifies the address. */
  source: string;
}

export type ReflectorFeedRegistry = Record<string, Record<string, ReflectorFeed>>;

export function feedsFor(network: string): Record<string, ReflectorFeed> {
  return (config.REFLECTOR_FEEDS_JSON as ReflectorFeedRegistry)[network] ?? {};
}

export function feedFor(network: string, symbol: string): ReflectorFeed | null {
  return feedsFor(network)[symbol.toUpperCase()] ?? null;
}

export function isPriceModeEnabled(network: string): boolean {
  return Object.keys(feedsFor(network)).length > 0;
}
