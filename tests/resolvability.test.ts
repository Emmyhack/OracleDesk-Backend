import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/env';
import {
  RESOLUTION_SOURCES,
  assessResolvability,
  endOfLocalDay,
  extractQuestion,
  isBinaryQuestion,
  oracleCandidates,
} from '../src/services/resolvability.service';
import { ECB_MEETINGS, FOMC_MEETINGS } from '../src/services/resolvability.calendar';

setupTestEnv();

const corpus = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'resolvability', 'questions.json'), 'utf8'),
) as Array<{
  name: string;
  question: string;
  category: string;
  oracle: string;
  expiry: string;
  now: string;
  expected: {
    ok: boolean;
    reasons: string[];
    repairedExpiry?: string;
    resolution?: { sourceId?: string; comparator?: string; thresholdValue?: number };
  };
}>;

test('the corpus has at least 40 questions', () => {
  assert.ok(corpus.length >= 40, `only ${corpus.length}`);
});

for (const c of corpus) {
  test(`corpus: ${c.name}`, () => {
    const report = assessResolvability(
      {
        market_question: c.question,
        category: c.category as any,
        resolution_oracle: c.oracle,
        expiry_timestamp: Math.floor(Date.parse(c.expiry) / 1000),
      },
      { now: new Date(c.now), disputeWindowSecs: 86_400 },
    );
    assert.deepEqual([...report.reasons].sort(), [...c.expected.reasons].sort(), `reasons: ${JSON.stringify(report)}`);
    assert.equal(report.ok, c.expected.ok);
    assert.equal(report.repairedExpiry?.toISOString(), c.expected.repairedExpiry);
    if (c.expected.resolution) {
      assert.ok(report.resolution, 'resolution block expected');
      const want = c.expected.resolution;
      if (want.sourceId) assert.equal(report.resolution.sourceId, want.sourceId);
      if (want.comparator) assert.equal(report.resolution.comparator, want.comparator);
      if (want.thresholdValue !== undefined) assert.equal(report.resolution.threshold?.value, want.thresholdValue);
    }
    if (c.expected.ok) assert.ok(report.resolution?.instructions.length);
    else assert.equal(report.resolution, undefined);
  });
}

test('a repaired expiry always lies inside [deadline + lag, deadline + lag + 6h]', () => {
  for (const c of corpus.filter((x) => x.expected.repairedExpiry)) {
    const report = assessResolvability(
      { market_question: c.question, category: c.category as any, resolution_oracle: c.oracle, expiry_timestamp: Math.floor(Date.parse(c.expiry) / 1000) },
      { now: new Date(c.now), disputeWindowSecs: 86_400 },
    );
    const { earliestClose, latestClose } = report.window!;
    assert.ok(report.repairedExpiry!.getTime() >= earliestClose.getTime());
    assert.ok(report.repairedExpiry!.getTime() <= latestClose.getTime());
    assert.equal(latestClose.getTime() - earliestClose.getTime(), 6 * 3600 * 1000);
  }
});

test('crypto + CHAINLINK is flagged as a price-spec candidate and stays resolvable', () => {
  const report = assessResolvability(
    { market_question: 'Will Bitcoin close above $100,000 on October 5?', category: 'CRYPTO' as any, resolution_oracle: 'CHAINLINK', expiry_timestamp: Math.floor(Date.parse('2026-10-06T01:00:00Z') / 1000) },
    { now: new Date('2026-09-20T12:00:00Z'), disputeWindowSecs: 86_400 },
  );
  assert.equal(report.ok, true);
  assert.equal(report.priceSpecCandidate, true);
});

test('a bare date resolves to its next occurrence', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  assert.equal(extractQuestion('Will X happen on October 5?', now).deadlines[0].at.toISOString(), '2026-10-05T23:59:59.000Z');
  assert.equal(extractQuestion('Will X happen on March 3?', now).deadlines[0].at.toISOString(), '2027-03-03T23:59:59.000Z');
  // Today still counts until its end of day.
  assert.equal(extractQuestion('Will X happen on Sep 20?', now).deadlines[0].at.toISOString(), '2026-09-20T23:59:59.000Z');
  assert.equal(extractQuestion('Will X happen on Sep 19?', now).deadlines[0].at.toISOString(), '2027-09-19T23:59:59.000Z');
});

test('date forms: Month D, YYYY / D Month YYYY / ISO / Mon D', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const at = (q: string) => extractQuestion(q, now).deadlines.map((d) => d.at.toISOString());
  assert.deepEqual(at('Will X happen by June 30, 2026?'), ['2026-06-30T23:59:59.000Z']);
  assert.deepEqual(at('Will X happen by 30 June 2026?'), ['2026-06-30T23:59:59.000Z']);
  assert.deepEqual(at('Will X happen by 2026-06-30?'), ['2026-06-30T23:59:59.000Z']);
  assert.deepEqual(at('Will X happen by Jun 30?'), ['2026-06-30T23:59:59.000Z']);
  assert.deepEqual(at('Will X happen by Feb 30, 2026?'), []);
});

test('end of day follows the source time zone across DST transitions', () => {
  // US spring forward 2026-03-08 and fall back 2026-11-01.
  assert.equal(endOfLocalDay(2026, 2, 8, 'America/New_York')!.toISOString(), '2026-03-09T03:59:59.000Z');
  assert.equal(endOfLocalDay(2026, 2, 7, 'America/New_York')!.toISOString(), '2026-03-08T04:59:59.000Z');
  assert.equal(endOfLocalDay(2026, 10, 1, 'America/New_York')!.toISOString(), '2026-11-02T04:59:59.000Z');
  assert.equal(endOfLocalDay(2026, 9, 31, 'America/New_York')!.toISOString(), '2026-11-01T03:59:59.000Z');
  // The local day on the transition is 25 hours, not 24.
  const a = endOfLocalDay(2026, 10, 1, 'America/New_York')!.getTime();
  const b = endOfLocalDay(2026, 9, 31, 'America/New_York')!.getTime();
  assert.equal((a - b) / 3_600_000, 25);
  assert.equal(endOfLocalDay(2026, 5, 30, 'UTC')!.toISOString(), '2026-06-30T23:59:59.000Z');
});

test('comparator and threshold extraction ignores dates and years', () => {
  const x = extractQuestion('Will CPI exceed 3.5% for September 2026?', new Date('2026-09-20T00:00:00Z'));
  assert.equal(x.comparator, '>');
  assert.deepEqual(x.threshold, { value: 3.5, unit: '%', text: '3.5%' });
  assert.equal(x.periodRef?.kind, 'month');
  const y = extractQuestion('Will Bitcoin fall below $90,000 by December 31, 2026?', new Date('2026-09-20T00:00:00Z'));
  assert.equal(y.comparator, '<');
  assert.equal(y.threshold?.value, 90_000);
  assert.equal(y.threshold?.unit, 'USD');
});

test('binary check allows "or more" style comparators but not either-or', () => {
  assert.equal(isBinaryQuestion('Will CPI be 3% or higher by June 30, 2026?'), true);
  assert.equal(isBinaryQuestion('Will X or Y win?'), false);
  assert.equal(isBinaryQuestion('How many seats will they win?'), false);
});

test('oracle strings map to allowlisted sources', () => {
  assert.deepEqual(oracleCandidates('BLS | fred'), ['BLS', 'FRED']);
  assert.deepEqual(oracleCandidates('Reuters'), []);
  assert.deepEqual(Object.keys(RESOLUTION_SOURCES).sort(), [
    'AP_ELECTIONS', 'AP_POLITICS', 'BILLBOARD', 'BLS', 'CHAINLINK', 'ECB', 'ESPN', 'FRED', 'OPEC',
  ]);
});

test('meeting calendar is not stale: a future FOMC and ECB date exist (update resolvability.calendar.ts yearly)', () => {
  const future = (defs: readonly { date: string }[]) => defs.some((d) => Date.parse(`${d.date}T23:59:59Z`) > Date.now());
  assert.ok(future(FOMC_MEETINGS), 'FOMC table has no future meeting; update src/services/resolvability.calendar.ts');
  assert.ok(future(ECB_MEETINGS), 'ECB table has no future meeting; update src/services/resolvability.calendar.ts');
});
