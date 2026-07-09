// Pure date helpers for the no_school_day automation. Extracted from the cron so
// the tricky bits (junk-date guarding, weekend-bridging closure grouping, the
// term→school_year map) are unit-testable without importing index.ts (which
// starts an HTTP server on import). No I/O here — just date math on ISO strings.

export interface ClosurePeriod {
  startIso: string;
  endIso: string;
  dates: { iso: string; reason: string }[];
}

// Midday-UTC parse dodges DST/local-midnight edge cases.
export function nsdDate(iso: string): Date { return new Date(`${iso}T12:00:00Z`); }
export function nsdYmd(d: Date): string { return d.toISOString().slice(0, 10); }
export function nsdAddDays(iso: string, n: number): string {
  const d = nsdDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return nsdYmd(d);
}

const NSD_WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function nsdWeekdayLower(iso: string): string { return NSD_WEEKDAY_NAMES[nsdDate(iso).getUTCDay()]; }

// Count Mon–Fri days strictly between two ISO dates. 0 ⇒ the two dates are
// "adjacent" for grouping (only a weekend, or nothing, separates them), so a
// Friday closure and the following Monday collapse into one closure period —
// which is what keeps a whole winter break to a single email.
export function nsdWeekdaysStrictlyBetween(aIso: string, bIso: string): number {
  let count = 0;
  let cur = nsdAddDays(aIso, 1);
  while (cur < bIso) {
    const dow = nsdDate(cur).getUTCDay();
    if (dow >= 1 && dow <= 5) count += 1;
    cur = nsdAddDays(cur, 1);
  }
  return count;
}

// Mirror of the SQL term_to_school_year(): FA26 → "2026-2027", WI27/SP27 →
// "2026-2027", SU/unknown → null. Kept in TS so the resolver can match a
// program's term to a district_calendar.school_year without a round-trip.
export function termToSchoolYear(term: string | null | undefined): string | null {
  if (!term || term.length < 4) return null;
  const prefix = term.slice(0, 2).toUpperCase();
  const suffix = term.slice(2);
  // Match the SQL term_to_school_year exactly: its `substring::integer` cast
  // rejects any non-numeric suffix (returns NULL). parseInt would tolerate
  // trailing garbage ("26x" → 26), so guard first — otherwise TS could classify
  // a term the DB won't, and the sessions-vs-reminder invariant would drift.
  if (!/^\d+$/.test(suffix)) return null;
  const yy = parseInt(suffix, 10);
  if (!Number.isFinite(yy)) return null;
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (prefix === "FA") return `20${p2(yy)}-20${p2(yy + 1)}`;
  if (prefix === "WI" || prefix === "SP") return `20${p2(yy - 1)}-20${p2(yy)}`;
  return null;
}

// Validate raw no_school_dates jsonb → sorted, de-junked, future-only list.
// Guards the real "0027-01-12" prod typo (year < 2000), non-ISO strings, and
// past dates (a closure already behind us can't be reminded about). onOrAfterIso
// is normally today.
export function cleanNoSchoolDates(
  raw: unknown,
  onOrAfterIso: string,
): { iso: string; reason: string }[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((e: any) => ({
      iso: typeof e?.date === "string" ? e.date.trim() : "",
      reason: typeof e?.reason === "string" ? e.reason.trim() : "",
    }))
    .filter((e) =>
      /^\d{4}-\d{2}-\d{2}$/.test(e.iso) &&
      e.iso >= "2000-01-01" &&
      !Number.isNaN(nsdDate(e.iso).getTime()) &&
      e.iso >= onOrAfterIso,
    )
    .sort((x, y) => (x.iso < y.iso ? -1 : x.iso > y.iso ? 1 : 0));
}

// Collapse a sorted date list into closure periods, bridging weekends. Two dates
// belong to the same period when no school weekday separates them (so Thu+Fri,
// and Fri+the-following-Mon, group together; but a Monday and a Thursday with
// school Tue/Wed between them split into two periods). Input MUST be sorted
// ascending and de-duplicated (cleanNoSchoolDates does both).
export function toClosurePeriods(
  sorted: { iso: string; reason: string }[],
): ClosurePeriod[] {
  if (sorted.length === 0) return [];
  const periods: ClosurePeriod[] = [];
  let group: { iso: string; reason: string }[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (nsdWeekdaysStrictlyBetween(sorted[i - 1].iso, sorted[i].iso) === 0) {
      group.push(sorted[i]);
    } else {
      periods.push({ startIso: group[0].iso, endIso: group[group.length - 1].iso, dates: group });
      group = [sorted[i]];
    }
  }
  periods.push({ startIso: group[0].iso, endIso: group[group.length - 1].iso, dates: group });
  return periods;
}

// Should a closure period fire on `today`? True while today is within the send
// window [start − daysBefore, end] AND the natural send day is on/after
// enabledDayIso (forward-only — prevents an on-enable back-catalog blast for a
// closure whose window already opened before the automation was toggled on).
// The window stays open through the period end so a delayed cron catches up;
// the caller pairs this with a stable per-closure idempotency key so "in window
// for several days" still yields exactly one send.
export function periodFires(
  startIso: string,
  endIso: string,
  todayIso: string,
  daysBefore: number,
  enabledDayIso: string,
): boolean {
  const sendDay = nsdAddDays(startIso, -daysBefore);
  return sendDay <= todayIso && todayIso <= endIso && sendDay >= enabledDayIso;
}

// Friendly full date, e.g. "Monday, July 13". Matches the cron's formatDate.
export function formatFullDate(iso: string): string {
  return nsdDate(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

// Join affected dates for one program into a readable clause.
export function formatDateList(isos: string[]): string {
  const parts = isos.map(formatFullDate);
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
