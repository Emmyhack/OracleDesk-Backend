/**
 * Pure market-generation policy shared by market.service.ts and the prompt
 * injection guard (llm-guard.service.ts). Kept in a leaf module so the two can
 * import it without a cycle; market.service.ts re-exports it.
 */

// ─── Source credibility weights ───────────────────────────────────────────────
export const SOURCE_WEIGHTS: Record<string, number> = {
  FRED:                 0.9,
  BLS:                  0.9,
  ECB:                  0.9,
  CME_FEDWATCH:         0.9,
  AP_ELECTIONS:         0.9,
  NEWSAPI:              0.7,
  GDELT:                0.6,
  ANALYST:              0.5,
  REDDIT:               0.3,
  TWITTER:              0.3,
  SPORTRADAR:           0.9,
  ESPN:                 0.8,
  BBC_SPORT:            0.8,
  SPORTS_REFERENCE:     0.85,
  ENTERTAINMENT_WEEKLY: 0.6,
  BILLBOARD:            0.75,
  BOX_OFFICE_MOJO:      0.80,
  ROTTEN_TOMATOES:      0.70,
  POLITICAL_WIRE:       0.80,
  REALCLEARPOLITICS:    0.75,
  POLITICO:             0.80,
  AP_POLITICS:          0.90,
};

/**
 * Oracles a proposal may name: every credibility-weighted source plus the two
 * the system prompt also offers.
 */
export const ALLOWED_ORACLES: readonly string[] = Object.freeze([
  ...Object.keys(SOURCE_WEIGHTS),
  'CHAINLINK',
  'OPEC',
]);

// Stop-words to exclude from meaningful token comparison
const STOP_WORDS = new Set([
  'the','a','an','is','are','will','at','or','by','in','on','of','to',
  'and','be','for','its','this','that','it','as','with','from','at',
  'whether','if','has','have','been','was','were','not','no',
]);

export function meaningfulTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%.\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * How many of `tokens` occur in `other` (duplicates counted, as the lexical
 * dedup rule does). Shared by duplicate detection and the trader's
 * signal-relevance filter (#75).
 */
export function tokenOverlap(tokens: string[], other: Set<string>): number {
  return tokens.filter((w) => other.has(w)).length;
}
