/**
 * Small parser for dates written in a market question (#67, #69): "by June 30,
 * 2026", "on 2026-10-01", "Sept 17", "30 June 2026", "end of Q3", "end of
 * September". All results are UTC midnights. A missing year is inferred as the
 * first occurrence on or after (asOf - 7 days).
 */
const MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6,
  August: 7, September: 8, October: 9, November: 10, December: 11,
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Sept: 8, Oct: 9, Nov: 10, Dec: 11,
};
// Capitalised only, so the modal verb "may" is never read as the month.
const MONTH = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const lastDayOfMonth = (y: number, m: number) => utc(y, m + 1, 0);

function inferYear(month: number, day: number, asOf: Date): number {
  const floor = asOf.getTime() - 7 * 86_400_000;
  const year = asOf.getUTCFullYear();
  return utc(year, month, day).getTime() >= floor ? year : year + 1;
}

interface Hit { start: number; end: number; date: Date }

export function extractQuestionDates(question: string, asOf: Date): Date[] {
  const hits: Hit[] = [];
  const claim = (m: RegExpExecArray, date: Date) => {
    const start = m.index;
    const end = m.index + m[0].length;
    if (!Number.isNaN(date.getTime()) && !hits.some((h) => start < h.end && end > h.start)) hits.push({ start, end, date });
  };

  // 2026-10-01
  for (const m of question.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    claim(m as RegExpExecArray, utc(+m[1], +m[2] - 1, +m[3]));
  }
  // 30 June 2026
  for (const m of question.matchAll(new RegExp(`\\b${DAY}\\s+${MONTH}\\.?,?\\s+(\\d{4})\\b`, 'g'))) {
    claim(m as RegExpExecArray, utc(+m[3], MONTHS[m[2]], +m[1]));
  }
  // October 23-25, 2026: a day range reads as its last day
  for (const m of question.matchAll(new RegExp(`\\b${MONTH}\\.?\\s+${DAY}\\s*[-–]\\s*${DAY}(?:,?\\s+(\\d{4}))?\\b`, 'g'))) {
    const month = MONTHS[m[1]];
    const day = +m[3];
    claim(m as RegExpExecArray, utc(m[4] ? +m[4] : inferYear(month, day, asOf), month, day));
  }
  // June 30, 2026 / Sept 17 / June 30th
  for (const m of question.matchAll(new RegExp(`\\b${MONTH}\\.?\\s+${DAY}(?:,?\\s+(\\d{4}))?\\b`, 'g'))) {
    const month = MONTHS[m[1]];
    const day = +m[2];
    claim(m as RegExpExecArray, utc(m[3] ? +m[3] : inferYear(month, day, asOf), month, day));
  }
  // end of Q3 [2026]
  for (const m of question.matchAll(/\bend of Q([1-4])(?:\s+(\d{4}))?\b/gi)) {
    const month = +m[1] * 3 - 1;
    const year = m[2] ? +m[2] : inferYear(month, 28, asOf);
    claim(m as RegExpExecArray, lastDayOfMonth(year, month));
  }
  // end of September [2026]
  for (const m of question.matchAll(new RegExp(`\\bend of ${MONTH}(?:\\s+(\\d{4}))?\\b`, 'g'))) {
    const month = MONTHS[m[1]];
    const year = m[2] ? +m[2] : inferYear(month, 28, asOf);
    claim(m as RegExpExecArray, lastDayOfMonth(year, month));
  }

  return hits.sort((a, b) => a.start - b.start).map((h) => h.date);
}

/** Whole UTC days from `a` to `b`. */
export function dayDiff(a: Date, b: Date): number {
  const day = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  return day(b) - day(a);
}
