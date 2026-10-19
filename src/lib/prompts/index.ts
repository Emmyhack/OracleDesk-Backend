/**
 * Prompt registry (#66). Every prompt the backend sends is registered here
 * with an id, a version and a content hash. Old versions stay registered (and
 * importable) so a past trace can be replayed or evaluated against the exact
 * prompt that produced it; a prompt change ships as a new version file and a
 * new entry, never as an edit of an existing one. tests/prompts.test.ts
 * enforces that against tests/fixtures/prompts.snapshot.json.
 */
import type { PromptDef } from './define';
import { forecastV1 } from './forecast.v1';
import { hedgeConditionsV1 } from './hedge-conditions.v1';
import { marketProposalV1 } from './market-proposal.v1';

export type { PromptDef } from './define';
export { definePrompt } from './define';
export type { MarketProposalVars } from './market-proposal.v1';
export type { HedgeConditionsVars } from './hedge-conditions.v1';
export type { ForecastVars } from './forecast.v1';
export { forecastV1, hedgeConditionsV1, marketProposalV1 };

const ALL: ReadonlyArray<PromptDef<any>> = [marketProposalV1, hedgeConditionsV1, forecastV1];

/** Current version per id. Bump when a new version file is added. */
export const CURRENT_VERSION: Readonly<Record<string, number>> = {
  'market-proposal': 1,
  'hedge-conditions': 1,
  forecast: 1,
};

export function listPrompts(): Array<{ id: string; version: number; contentHash: string }> {
  return ALL.map(({ id, version, contentHash }) => ({ id, version, contentHash }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}

/** The current version of `id`, or the named `version` (for replay). */
export function getPrompt(id: string, version?: number): PromptDef<any> {
  const wanted = version ?? CURRENT_VERSION[id];
  const found = ALL.find((p) => p.id === id && p.version === wanted);
  if (!found) throw new Error(`Unknown prompt ${id}${version === undefined ? '' : `@${version}`}`);
  return found;
}
