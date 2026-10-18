/**
 * Rule-based entity extraction for the second dedup stage (#69). "Same subject"
 * means the two questions share at least one entity; the gazetteer maps
 * surface forms (FOMC, Federal Reserve, the Fed) to one canonical id so a
 * paraphrase still matches. Proper nouns not in the gazetteer (teams, people,
 * places) are picked up as capitalised words.
 */
import { SOURCE_WEIGHTS } from './market-policy';

/** canonical id → surface forms (lowercase). Multi-word forms are matched as phrases. */
const GAZETTEER: Record<string, string[]> = {
  // central banks and monetary policy
  FED: ['fed', 'fomc', 'federal reserve', 'federal funds', 'powell', 'fed funds'],
  ECB: ['ecb', 'european central bank', 'lagarde', 'deposit facility'],
  BOJ: ['boj', 'bank of japan'],
  BOE: ['boe', 'bank of england'],
  // assets
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ether', 'ethereum'],
  SOL: ['sol', 'solana'],
  XRP: ['xrp', 'ripple'],
  DOGE: ['doge', 'dogecoin'],
  GOLD: ['gold', 'xau'],
  OIL: ['oil', 'crude', 'brent', 'wti'],
  SPX: ['s&p', 's&p 500', 'sp500', 'spx'],
  NASDAQ: ['nasdaq'],
  // indicators
  CPI: ['cpi', 'inflation', 'consumer price'],
  HICP: ['hicp'],
  JOBS: ['unemployment', 'jobless', 'joblessness', 'payrolls', 'nonfarm', 'nfp', 'jobs report'],
  GDP: ['gdp', 'gross domestic product'],
  YIELD: ['treasury yield', '10-year yield', '10 year yield', 'yield curve'],
  // places and blocs
  US: ['us', 'u.s.', 'usa', 'united states', 'america', 'american'],
  EU: ['eu', 'european union', 'euro area', 'eurozone'],
  UK: ['uk', 'britain', 'united kingdom', 'british'],
  CHINA: ['china', 'chinese', 'beijing'],
  RUSSIA: ['russia', 'russian', 'moscow', 'kremlin'],
  UKRAINE: ['ukraine', 'ukrainian', 'kyiv', 'kiev'],
  ISRAEL: ['israel', 'israeli'],
  IRAN: ['iran', 'iranian', 'tehran'],
  INDIA: ['india', 'indian'],
  JAPAN: ['japan', 'japanese'],
  // institutions
  SEC: ['sec', 'securities and exchange commission'],
  OPEC: ['opec'],
  IOC: ['ioc', 'international olympic committee'],
  SENATE: ['senate', 'senators'],
  HOUSE: ['house of representatives', 'house'],
  // sports leagues
  NBA: ['nba'],
  NFL: ['nfl'],
  FIFA: ['fifa', 'world cup'],
  // topics
  SHUTDOWN: ['shutdown', 'shut down', 'government funding'],
  HEALTH_EMERGENCY: ['health emergency', 'public health emergency', 'world health organization'],
  FILM: ['film', 'movie', 'box office', 'opening weekend'],
  HURRICANE: ['hurricane', 'category 5'],
  CEASEFIRE: ['ceasefire', 'cease fire', 'truce'],
  TARIFFS: ['tariff', 'tariffs'],
};

/** Forms matched only with this exact capitalisation ("WHO" the agency, not "who"). */
const CASE_SENSITIVE: Record<string, string[]> = {
  HEALTH_EMERGENCY: ['WHO'],
};

// Sources that name a market ("ECB", "FRED", "BILLBOARD") join the entry of the
// same id when there is one instead of replacing it.
for (const k of Object.keys(SOURCE_WEIGHTS)) {
  const form = k.toLowerCase().replace(/_/g, ' ');
  GAZETTEER[k] = [...new Set([...(GAZETTEER[k] ?? []), form])];
}

/** Capitalised words that start many questions or are not subjects. */
const NOT_ENTITIES = new Set([
  'Game', 'League', 'Bowl', 'Will', 'Is', 'Are', 'Does', 'Do', 'Did', 'Has', 'Have', 'Can', 'Could', 'Would', 'Should',
  'The', 'A', 'An', 'By', 'On', 'In', 'At', 'Before', 'After', 'Above', 'Below', 'Over', 'Under',
  'YES', 'NO', 'USD', 'USDC', 'Q1', 'Q2', 'Q3', 'Q4',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One alternation per canonical id, longest forms first, whole-word.
const bounded = (forms: string[], flags: string) =>
  new RegExp(`(?<![\\w])(?:${[...forms].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\w])`, flags);
const MATCHERS: Array<[string, RegExp]> = [
  ...Object.entries(GAZETTEER).map(([id, forms]): [string, RegExp] => [id, bounded(forms, 'ig')]),
  ...Object.entries(CASE_SENSITIVE).map(([id, forms]): [string, RegExp] => [id, bounded(forms, 'g')]),
];

/**
 * Canonical entity ids found in `question`. Deterministic and order-independent.
 * Text covered by a gazetteer form is not scanned again for proper nouns, so
 * "Federal Reserve" yields FED and not also NAME:federal / NAME:reserve.
 */
export function extractEntities(question: string): Set<string> {
  const out = new Set<string>();
  let rest = question;
  for (const [id, re] of MATCHERS) {
    re.lastIndex = 0;
    if (re.test(question)) {
      out.add(id);
      re.lastIndex = 0;
      rest = rest.replace(re, ' ');
    }
  }
  // Proper nouns: capitalised words, not the first word, not a month/auxiliary.
  const words = rest.split(/[^A-Za-z0-9&.']+/).filter(Boolean);
  words.forEach((w, i) => {
    if (i > 0 && /^[A-Z][A-Za-z']{2,}$/.test(w) && !NOT_ENTITIES.has(w)) out.add(`NAME:${w.toLowerCase()}`);
  });
  return out;
}

export function sharedEntities(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => b.has(x)).sort();
}

/** Entities only one of the two questions mentions. */
export function uniqueEntities(a: Set<string>, b: Set<string>): [string[], string[]] {
  return [[...a].filter((x) => !b.has(x)).sort(), [...b].filter((x) => !a.has(x)).sort()];
}
