/**
 * Scheduled monetary-policy meeting dates, used to turn "at its September
 * meeting" into the announcement instant (#74).
 *
 * MUST BE UPDATED YEARLY. A silently stale table is the biggest long-term risk
 * of the resolvability validator, so tests/resolvability.test.ts fails when
 * either table has no future entry.
 *
 * Sources (checked 2026-10-18):
 *   FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *         (2027 dates are tentative until confirmed at the preceding meeting)
 *   ECB:  https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html
 *         (the page only lists meetings from 28/10/2026 on; earlier 2026
 *         meetings are past and therefore not needed)
 *
 * Each date is the announcement day (day 2 of the meeting), local to the
 * institution, with the time of the policy decision release.
 */
export interface MeetingDef {
  /** Announcement date, YYYY-MM-DD, in `timeZone`. */
  date: string;
  /** Time of the decision release, HH:mm, in `timeZone`. */
  time: string;
  timeZone: string;
}

const fomc = (date: string): MeetingDef => ({ date, time: '14:00', timeZone: 'America/New_York' });
const ecb = (date: string): MeetingDef => ({ date, time: '14:15', timeZone: 'Europe/Berlin' });

export const FOMC_MEETINGS: readonly MeetingDef[] = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09',
  '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08',
].map(fomc);

export const ECB_MEETINGS: readonly MeetingDef[] = [
  '2026-10-29', '2026-12-17',
  '2027-02-04', '2027-03-18', '2027-04-29', '2027-06-10',
  '2027-07-22', '2027-09-09', '2027-10-28', '2027-12-16',
].map(ecb);

export type MeetingBody = 'FOMC' | 'ECB';

export const MEETINGS: Record<MeetingBody, readonly MeetingDef[]> = {
  FOMC: FOMC_MEETINGS,
  ECB: ECB_MEETINGS,
};
