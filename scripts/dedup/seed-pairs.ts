/**
 * Writes tests/fixtures/dedup-pairs.json (#69): labelled question pairs for
 * calibrating the semantic dedup threshold. Hand-written paraphrases plus
 * template families; the JSON is the source of truth afterwards, so edit it
 * directly and treat this script as documentation of how the set was built.
 *
 * Each pair: { a, b, duplicate, family, note, dueA, dueB } where dueX is the
 * day the market would resolve (its expiry), because stage two compares dates.
 *
 *   npx tsx scripts/dedup/seed-pairs.ts
 */
import fs from 'node:fs';
import path from 'node:path';

interface Pair { a: string; b: string; duplicate: boolean; family: string; note: string; dueA: string; dueB: string }
const pairs: Pair[] = [];
const add = (family: string, duplicate: boolean, a: string, b: string, dueA: string, dueB: string, note: string) =>
  pairs.push({ a, b, duplicate, family, note, dueA, dueB });

// ── A. Paraphrases of the same market (duplicate) ────────────────────────────
const paraphrases: Array<[string, string, string]> = [
  ['Will the Fed hold rates at its September meeting?', 'Will the FOMC leave the federal funds target unchanged on Sept 17?', '2026-09-17'],
  ['Will the Federal Reserve cut interest rates at its October 28, 2026 meeting?', 'Will the FOMC lower the federal funds rate on October 28?', '2026-10-28'],
  ['Will the Federal Reserve raise rates at its December meeting?', 'Will the FOMC hike the federal funds target at the December 9 decision?', '2026-12-09'],
  ['Will the Fed keep rates steady in November?', 'Will the Federal Reserve maintain the current federal funds rate at its November meeting?', '2026-11-05'],
  ['Will the ECB cut its deposit facility rate on December 10, 2026?', 'Will the European Central Bank lower the deposit rate at its December 10 meeting?', '2026-12-10'],
  ['Will the ECB hold interest rates unchanged in October?', 'Will the European Central Bank keep its key rates steady at the October meeting?', '2026-10-29'],
  ['Will the Bank of Japan raise its policy rate in October?', 'Will the BOJ hike interest rates at its October meeting?', '2026-10-30'],
  ['Will the Bank of England cut rates at its November meeting?', 'Will the BOE lower the Bank Rate on November 5?', '2026-11-05'],
  ['Will Bitcoin trade above $100,000 before the end of the year?', 'Will BTC exceed 100k by December 31, 2026?', '2026-12-31'],
  ['Will Bitcoin close above $70,000 on October 31, 2026?', 'Will BTC finish October 31 higher than $70,000?', '2026-10-31'],
  ['Will Ethereum trade above $5,000 by November 30?', 'Will ETH exceed 5k before the end of November 2026?', '2026-11-30'],
  ['Will Solana close above $300 on December 1, 2026?', 'Will SOL finish December 1 over $300?', '2026-12-01'],
  ['Will the SEC approve a spot Solana ETF by December 31, 2026?', 'Will the Securities and Exchange Commission approve a Solana spot ETF before year end?', '2026-12-31'],
  ['Will US CPI inflation for September 2026 exceed 3.0% year over year?', 'Will the BLS report September 2026 consumer price inflation above 3.0% annually?', '2026-10-14'],
  ['Will the US unemployment rate for October 2026 be above 4.5%?', 'Will the BLS report October 2026 joblessness exceeding 4.5%?', '2026-11-06'],
  ['Will US real GDP growth for Q3 2026 exceed 2.0% annualized?', 'Will the advance estimate of third quarter 2026 US GDP growth top 2.0% annualized?', '2026-10-29'],
  ['Will the US Senate pass the sanctions bill by October 9, 2026?', 'Will the Senate approve the sanctions legislation before October 9?', '2026-10-09'],
  ['Will Congress pass a stopgap funding bill before October 1, 2026?', 'Will Congress enact a continuing resolution by September 30, 2026?', '2026-09-30'],
  ['Will a federal government shutdown begin on October 1, 2026?', 'Will the US government shut down on October 1?', '2026-10-01'],
  ['Will Republicans win a majority in the US Senate in the November 3, 2026 elections?', 'Will the GOP control the Senate after the November 2026 midterms?', '2026-11-04'],
  ['Will Democrats win the House of Representatives in November 2026?', 'Will the Democratic Party take control of the House in the 2026 midterm elections?', '2026-11-04'],
  ['Will California voters approve the housing bond on November 3, 2026?', 'Will the California housing bond measure pass on Election Day 2026?', '2026-11-03'],
  ['Will the Lakers win Game 1 of the NBA Finals?', 'Will Los Angeles beat Boston in the opening game of the NBA Finals?', '2026-06-04'],
  ['Will the Chiefs win the Super Bowl?', 'Will Kansas City clinch the Super Bowl title?', '2027-02-14'],
  ['Will Manchester City win the Premier League this season?', 'Will City be crowned English champions in 2026-27?', '2027-05-24'],
  ['Will the film gross over $130 million domestically in its opening weekend?', 'Will the movie open above $130 million at the US box office?', '2026-10-26'],
  ['Will the new single reach number one on the Billboard Hot 100?', 'Will the latest song top the Billboard Hot 100 chart?', '2026-11-07'],
  ['Will OPEC announce a production cut at its October meeting?', 'Will OPEC agree to reduce crude output at the October ministerial?', '2026-10-05'],
  ['Will Brent crude close above $90 a barrel on November 30?', 'Will Brent oil finish November 30 over $90 per barrel?', '2026-11-30'],
  ['Will gold trade above $3,500 an ounce by December 31?', 'Will the price of gold exceed $3,500 per ounce before year end?', '2026-12-31'],
  ['Will Russia and Ukraine sign a ceasefire agreement by November 30, 2026?', 'Will Moscow and Kyiv agree to a formal ceasefire before the end of November?', '2026-11-30'],
  ['Will the EU ratify the Mercosur trade agreement by December 31?', 'Will the European Union approve the Mercosur trade deal before year end?', '2026-12-31'],
  ['Will China announce new tariffs on US goods by October 31?', 'Will Beijing impose additional tariffs on American imports before the end of October?', '2026-10-31'],
  ['Will the Senate confirm the Treasury nominee by October 2?', 'Will senators approve the Treasury nominee before October 2?', '2026-10-02'],
  ['Will the S&P 500 close above 6,500 on December 31, 2026?', 'Will the S&P 500 finish the year over 6500?', '2026-12-31'],
  ['Will the 10-year Treasury yield close above 4.5% on October 30?', 'Will the 10 year yield finish October 30 higher than 4.5%?', '2026-10-30'],
  ['Will Tesla deliver more than 500,000 vehicles in Q4 2026?', 'Will Tesla report fourth quarter 2026 deliveries above 500k?', '2027-01-03'],
  ['Will Apple announce a foldable iPhone at its September event?', 'Will Apple unveil a foldable iPhone in September?', '2026-09-15'],
  ['Will Nvidia report quarterly revenue above $50 billion in November?', 'Will Nvidia post November quarterly revenue exceeding $50B?', '2026-11-25'],
  ['Will India overtake Japan as the world\'s fourth largest economy in the next IMF release?', 'Will the IMF rank India ahead of Japan by GDP in its next outlook?', '2026-10-14'],
  ['Will the IOC choose a host city for the 2036 Games on September 25, 2026?', 'Will the International Olympic Committee select the 2036 host on September 25?', '2026-09-25'],
  ['Will Hurricane season produce a Category 5 landfall in the US before November 30?', 'Will a Category 5 hurricane make US landfall before the end of November?', '2026-11-30'],
  ['Will the WHO declare a new public health emergency by December 31, 2026?', 'Will the World Health Organization announce another global health emergency before year end?', '2026-12-31'],
  ['Will the UK unemployment rate exceed 5% in the October release?', 'Will UK joblessness top 5% in the October figures?', '2026-10-15'],
];
for (const [a, b, due] of paraphrases) add('paraphrase', true, a, b, due, due, 'same event worded differently');

// ── E. Near-verbatim and format variants (duplicate) ─────────────────────────
const verbatim: Array<[string, string, string]> = [
  ['Will the Federal Reserve cut rates at its October 28, 2026 meeting?', 'Will the Federal Reserve cut rates at its 2026-10-28 meeting?', '2026-10-28'],
  ['Will Bitcoin close above $70,000 on October 31, 2026?', 'Will Bitcoin close above $70000 on 31 October 2026?', '2026-10-31'],
  ['Will the ECB hold rates on December 10, 2026?', 'Will the ECB hold rates on Dec 10, 2026?', '2026-12-10'],
  ['Will US CPI exceed 3.0% in September 2026?', 'Will US CPI exceed 3.0% in September 2026??', '2026-10-14'],
  ['Will the Lakers win the 2026 NBA championship?', 'Will the Lakers win the 2026 NBA championship', '2026-06-20'],
  ['Will the Senate pass the sanctions bill by October 9, 2026?', 'will the senate pass the sanctions bill by october 9, 2026?', '2026-10-09'],
  ['Will Ethereum close above $5,000 on November 30, 2026?', 'Will Ethereum close above $5k on November 30, 2026?', '2026-11-30'],
  ['Will the unemployment rate be above 4.5% in October 2026?', 'Will the unemployment rate be above 4.5% in October, 2026?', '2026-11-06'],
  ['Will the Fed hold rates at the September 17, 2026 meeting?', 'Will the Fed hold rates at the September 17th, 2026 meeting?', '2026-09-17'],
  ['Will OPEC cut production on October 5, 2026?', 'Will OPEC cut production on October 5 2026?', '2026-10-05'],
  ['Will gold close above $3,500 on December 31, 2026?', 'Will gold close above $3500 on Dec. 31, 2026?', '2026-12-31'],
  ['Will Solana trade above $300 by year end?', 'Will Solana trade above $300 by year-end?', '2026-12-31'],
  ['Will the BOJ raise rates at its October 30 meeting?', 'Will the BOJ raise rates at its October 30th meeting?', '2026-10-30'],
  ['Will the S&P 500 close above 6,500 on December 31, 2026?', 'Will the S&P 500 close above 6500 on December 31, 2026?', '2026-12-31'],
  ['Will China impose new tariffs on US goods by October 31, 2026?', 'Will China impose new tariffs on U.S. goods by October 31, 2026?', '2026-10-31'],
  ['Will the film open above $130 million on October 23-25, 2026?', 'Will the film open above $130 million on October 23–25, 2026?', '2026-10-26'],
];
for (const [a, b, due] of verbatim) add('verbatim', true, a, b, due, due, 'formatting differences only');

// ── B. Same event, different resolution date (not a duplicate) ───────────────
const dated: Array<[string, string, string, string]> = [
  ['Will the Fed cut rates at its September 17, 2026 meeting?', 'Will the Fed cut rates at its October 28, 2026 meeting?', '2026-09-17', '2026-10-28'],
  ['Will the Fed cut rates at its October 28, 2026 meeting?', 'Will the Fed cut rates at its December 9, 2026 meeting?', '2026-10-28', '2026-12-09'],
  ['Will the ECB hold rates at its October 29 meeting?', 'Will the ECB hold rates at its December 10 meeting?', '2026-10-29', '2026-12-10'],
  ['Will Bitcoin close above $100,000 on October 31, 2026?', 'Will Bitcoin close above $100,000 on December 31, 2026?', '2026-10-31', '2026-12-31'],
  ['Will Ethereum trade above $5,000 by October 31, 2026?', 'Will Ethereum trade above $5,000 by January 31, 2027?', '2026-10-31', '2027-01-31'],
  ['Will US CPI for September 2026 exceed 3.0%?', 'Will US CPI for October 2026 exceed 3.0%?', '2026-10-14', '2026-11-12'],
  ['Will the US unemployment rate for September 2026 be above 4.5%?', 'Will the US unemployment rate for October 2026 be above 4.5%?', '2026-10-02', '2026-11-06'],
  ['Will US GDP growth for Q2 2026 exceed 2.0%?', 'Will US GDP growth for Q3 2026 exceed 2.0%?', '2026-07-30', '2026-10-29'],
  ['Will the Senate pass the sanctions bill by October 9, 2026?', 'Will the Senate pass the sanctions bill by December 18, 2026?', '2026-10-09', '2026-12-18'],
  ['Will a government shutdown begin on October 1, 2026?', 'Will a government shutdown begin on December 18, 2026?', '2026-10-01', '2026-12-18'],
  ['Will OPEC announce a production cut at its October 5 meeting?', 'Will OPEC announce a production cut at its December 3 meeting?', '2026-10-05', '2026-12-03'],
  ['Will Brent crude close above $90 on October 30, 2026?', 'Will Brent crude close above $90 on December 30, 2026?', '2026-10-30', '2026-12-30'],
  ['Will gold trade above $3,500 by November 30, 2026?', 'Will gold trade above $3,500 by March 31, 2027?', '2026-11-30', '2027-03-31'],
  ['Will Russia and Ukraine sign a ceasefire by October 31, 2026?', 'Will Russia and Ukraine sign a ceasefire by January 31, 2027?', '2026-10-31', '2027-01-31'],
  ['Will the Lakers win Game 1 of the NBA Finals on June 4?', 'Will the Lakers win Game 2 of the NBA Finals on June 7?', '2026-06-04', '2026-06-07'],
  ['Will the film open above $130 million on October 23-25, 2026?', 'Will the film\'s second weekend gross above $130 million on October 30-November 1, 2026?', '2026-10-26', '2026-11-02'],
  ['Will the new single reach number one on the Billboard Hot 100 dated November 7?', 'Will the new single reach number one on the Billboard Hot 100 dated December 5?', '2026-11-07', '2026-12-05'],
  ['Will the S&P 500 close above 6,500 on October 30, 2026?', 'Will the S&P 500 close above 6,500 on December 31, 2026?', '2026-10-30', '2026-12-31'],
  ['Will the 10-year yield close above 4.5% on October 30?', 'Will the 10-year yield close above 4.5% on December 31?', '2026-10-30', '2026-12-31'],
  ['Will Tesla deliver over 500,000 vehicles in Q3 2026?', 'Will Tesla deliver over 500,000 vehicles in Q4 2026?', '2026-10-02', '2027-01-03'],
  ['Will the BOJ raise rates at its October 30 meeting?', 'Will the BOJ raise rates at its December 18 meeting?', '2026-10-30', '2026-12-18'],
  ['Will the BOE cut rates on November 5?', 'Will the BOE cut rates on December 17?', '2026-11-05', '2026-12-17'],
  ['Will the UK unemployment rate exceed 5% in the October release?', 'Will the UK unemployment rate exceed 5% in the December release?', '2026-10-15', '2026-12-16'],
  ['Will India GDP growth exceed 7% in the September quarter?', 'Will India GDP growth exceed 7% in the December quarter?', '2026-11-28', '2027-02-27'],
  ['Will the WHO declare a new health emergency by November 30, 2026?', 'Will the WHO declare a new health emergency by March 31, 2027?', '2026-11-30', '2027-03-31'],
  ['Will Solana close above $300 on November 1, 2026?', 'Will Solana close above $300 on December 1, 2026?', '2026-11-01', '2026-12-01'],
  ['Will the Fed raise rates at its September 17 meeting?', 'Will the Fed raise rates at its December 9 meeting?', '2026-09-17', '2026-12-09'],
  ['Will Apple announce a foldable iPhone in September?', 'Will Apple announce a foldable iPhone in March?', '2026-09-15', '2027-03-10'],
];
for (const [a, b, da, db] of dated) add('different-date', false, a, b, da, db, 'same subject, different resolution date');

// ── C. Same template, different asset or entity (not a duplicate) ────────────
const entityPairs: Array<[string, string, string]> = [
  ['Will Bitcoin close above $100,000 on December 31, 2026?', 'Will Ethereum close above $100,000 on December 31, 2026?', '2026-12-31'],
  ['Will Solana trade above $300 by November 30?', 'Will Dogecoin trade above $300 by November 30?', '2026-11-30'],
  ['Will the Fed cut rates on October 28?', 'Will the ECB cut rates on October 28?', '2026-10-28'],
  ['Will the ECB hold rates on December 10?', 'Will the Bank of Japan hold rates on December 10?', '2026-12-10'],
  ['Will the Lakers win the NBA championship?', 'Will the Celtics win the NBA championship?', '2026-06-20'],
  ['Will the Chiefs win the Super Bowl?', 'Will the Eagles win the Super Bowl?', '2027-02-14'],
  ['Will Manchester City win the Premier League?', 'Will Arsenal win the Premier League?', '2027-05-24'],
  ['Will Republicans win the Senate in November?', 'Will Republicans win the House in November?', '2026-11-04'],
  ['Will the Senate pass the sanctions bill by October 9?', 'Will the Senate pass the immigration bill by October 9?', '2026-10-09'],
  ['Will Russia sign a ceasefire by November 30?', 'Will Israel sign a ceasefire by November 30?', '2026-11-30'],
  ['Will China impose new tariffs by October 31?', 'Will India impose new tariffs by October 31?', '2026-10-31'],
  ['Will Brent crude close above $90 on November 30?', 'Will gold close above $90 on November 30?', '2026-11-30'],
  ['Will US CPI exceed 3.0% in September?', 'Will UK CPI exceed 3.0% in September?', '2026-10-14'],
  ['Will US unemployment exceed 4.5% in October?', 'Will UK unemployment exceed 4.5% in October?', '2026-11-06'],
  ['Will Tesla deliver more than 500,000 vehicles in Q4?', 'Will Ford deliver more than 500,000 vehicles in Q4?', '2027-01-03'],
  ['Will Apple announce a foldable phone in September?', 'Will Samsung announce a foldable phone in September?', '2026-09-15'],
  ['Will Nvidia report revenue above $50 billion?', 'Will Intel report revenue above $50 billion?', '2026-11-25'],
  ['Will the film gross over $130 million opening weekend?', 'Will the sequel gross over $130 million opening weekend?', '2026-10-26'],
  ['Will California approve the housing bond?', 'Will Oregon approve the housing bond?', '2026-11-03'],
  ['Will the WHO declare a health emergency by December 31?', 'Will the UN declare a famine emergency by December 31?', '2026-12-31'],
  ['Will the SEC approve a Solana ETF by year end?', 'Will the SEC approve an XRP ETF by year end?', '2026-12-31'],
  ['Will Japan raise rates in October?', 'Will Canada raise rates in October?', '2026-10-30'],
  ['Will the Premier League leaders win on Saturday?', 'Will the La Liga leaders win on Saturday?', '2026-10-17'],
  ['Will Iran sign the nuclear agreement by November 15?', 'Will Israel sign the normalisation agreement by November 15?', '2026-11-15'],
];
for (const [a, b, due] of entityPairs) add('different-entity', false, a, b, due, due, 'same template, different subject');

// ── D. Boilerplate collisions (not a duplicate) ──────────────────────────────
const boiler = (subject: string, level: string) => `Will ${subject} close above ${level} by June 30, 2026?`;
const boilerPairs: Array<[string, string, string, string]> = [
  ['Apple', '$250', 'Tesla', '$250'],
  ['Microsoft', '$500', 'Nvidia', '$500'],
  ['Amazon', '$220', 'Alphabet', '$220'],
  ['the Nikkei 225', '45,000', 'the FTSE 100', '45,000'],
  ['the DAX', '20,000', 'the CAC 40', '20,000'],
  ['Brent crude', '$90', 'natural gas', '$90'],
  ['the euro', '1.20', 'the pound', '1.20'],
  ['Netflix', '$1,000', 'Disney', '$1,000'],
  ['Coinbase', '$300', 'Robinhood', '$300'],
  ['Walmart', '$100', 'Costco', '$100'],
  ['copper', '$5', 'silver', '$5'],
  ['Shopify', '$150', 'Spotify', '$150'],
  ['Ford', '$15', 'Toyota', '$15'],
  ['Boeing', '$250', 'Airbus', '$250'],
  ['Visa', '$400', 'Mastercard', '$400'],
  ['Intel', '$40', 'AMD', '$40'],
  ['Uber', '$100', 'Lyft', '$100'],
  ['Pfizer', '$40', 'Moderna', '$40'],
  ['JPMorgan', '$300', 'Goldman Sachs', '$300'],
  ['the Hang Seng', '25,000', 'the Kospi', '25,000'],
];
for (const [s1, l1, s2, l2] of boilerPairs) add('boilerplate', false, boiler(s1, l1), boiler(s2, l2), '2026-06-30', '2026-06-30', 'shared template and date, unrelated subjects');

// ── F. Same subject and date, different threshold (not a duplicate) ──────────
const thresholds: Array<[string, string, string]> = [
  ['Will Bitcoin close above $70,000 on October 31, 2026?', 'Will Bitcoin close above $90,000 on October 31, 2026?', '2026-10-31'],
  ['Will Ethereum trade above $4,000 by November 30?', 'Will Ethereum trade above $6,000 by November 30?', '2026-11-30'],
  ['Will US CPI exceed 3.0% in September 2026?', 'Will US CPI exceed 4.0% in September 2026?', '2026-10-14'],
  ['Will the unemployment rate be above 4.3% in October 2026?', 'Will the unemployment rate be above 5.0% in October 2026?', '2026-11-06'],
  ['Will gold trade above $3,500 by December 31?', 'Will gold trade above $4,500 by December 31?', '2026-12-31'],
  ['Will Brent crude close above $90 on November 30?', 'Will Brent crude close above $120 on November 30?', '2026-11-30'],
  ['Will the S&P 500 close above 6,500 on December 31?', 'Will the S&P 500 close above 7,500 on December 31?', '2026-12-31'],
  ['Will the film gross over $130 million in its opening weekend?', 'Will the film gross over $200 million in its opening weekend?', '2026-10-26'],
  ['Will Solana close above $300 on December 1?', 'Will Solana close above $500 on December 1?', '2026-12-01'],
  ['Will US GDP growth for Q3 exceed 2.0% annualized?', 'Will US GDP growth for Q3 exceed 4.0% annualized?', '2026-10-29'],
  ['Will the 10-year yield close above 4.5% on October 30?', 'Will the 10-year yield close above 5.5% on October 30?', '2026-10-30'],
  ['Will Tesla deliver more than 500,000 vehicles in Q4?', 'Will Tesla deliver more than 700,000 vehicles in Q4?', '2027-01-03'],
];
for (const [a, b, due] of thresholds) add('different-threshold', false, a, b, due, due, 'same subject and date, different strike');

// ── G. Unrelated (not a duplicate) ───────────────────────────────────────────
const unrelated: Array<[string, string, string, string]> = [
  ['Will the Fed cut rates at its October meeting?', 'Will the Lakers win the NBA championship?', '2026-10-28', '2026-06-20'],
  ['Will Bitcoin close above $100,000 this year?', 'Will the WHO declare a health emergency by December?', '2026-12-31', '2026-12-31'],
  ['Will the Senate confirm the Treasury nominee?', 'Will Ethereum trade above $5,000?', '2026-10-02', '2026-11-30'],
  ['Will OPEC cut production in October?', 'Will the new single top the Billboard Hot 100?', '2026-10-05', '2026-11-07'],
  ['Will the ECB cut its deposit rate in December?', 'Will Manchester City win the Premier League?', '2026-12-10', '2027-05-24'],
  ['Will Russia sign a ceasefire by November 30?', 'Will Tesla deliver 500,000 vehicles in Q4?', '2026-11-30', '2027-01-03'],
  ['Will California approve the housing bond?', 'Will gold trade above $3,500 an ounce?', '2026-11-03', '2026-12-31'],
  ['Will US CPI exceed 3% in September?', 'Will the IOC pick a 2036 host city?', '2026-10-14', '2026-09-25'],
  ['Will Apple unveil a foldable iPhone?', 'Will the Chiefs win the Super Bowl?', '2026-09-15', '2027-02-14'],
  ['Will China impose new tariffs?', 'Will the film open above $130 million?', '2026-10-31', '2026-10-26'],
  ['Will the unemployment rate exceed 4.5%?', 'Will a Category 5 hurricane make US landfall?', '2026-11-06', '2026-11-30'],
  ['Will Nvidia report revenue above $50 billion?', 'Will the BOJ raise its policy rate?', '2026-11-25', '2026-10-30'],
  ['Will the S&P 500 close above 6,500?', 'Will Democrats win the House?', '2026-12-31', '2026-11-04'],
  ['Will India overtake Japan in GDP?', 'Will Solana close above $300?', '2026-10-14', '2026-12-01'],
];
for (const [a, b, da, db] of unrelated) add('unrelated', false, a, b, da, db, 'nothing in common');

const out = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'dedup-pairs.json');
fs.writeFileSync(out, `${JSON.stringify(pairs, null, 2)}\n`);
console.log(`wrote ${pairs.length} pairs (${pairs.filter((p) => p.duplicate).length} duplicates) to ${path.relative(process.cwd(), out)}`);
