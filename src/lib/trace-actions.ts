/**
 * reasoning-registry `publish_trace` action strings (#131). The single source
 * of truth for the backend's agents; docs/api.md shows the same values.
 *
 * Note: the contracts repo's TypeScript agents use `buy` for trades, while this
 * backend distinguishes `buy_yes` / `buy_no` (see docs/contract-requests.md).
 */
export const TRACE_ACTIONS = {
  createMarket: 'create_market',
  buyYes: 'buy_yes',
  buyNo: 'buy_no',
  attest: 'attest',
} as const;

export type TraceAction = (typeof TRACE_ACTIONS)[keyof typeof TRACE_ACTIONS];

export const tradeTraceAction = (direction: 'YES' | 'NO'): TraceAction =>
  direction === 'YES' ? TRACE_ACTIONS.buyYes : TRACE_ACTIONS.buyNo;

/**
 * Agent whose control state gates a `publish_trace` call (#79): the market
 * maker publishes `create_market` and `attest`, everything else is a trader decision.
 */
export const agentScopeForTraceAction = (action: string): 'MARKET_MAKER' | 'TRADER' =>
  action === TRACE_ACTIONS.createMarket || action === TRACE_ACTIONS.attest ? 'MARKET_MAKER' : 'TRADER';
