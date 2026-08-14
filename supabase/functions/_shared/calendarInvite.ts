// calendarInvite — tenant-neutral calendar-invite builder for registration
// confirmations.
//
// Turns a program's REAL, closure-aware session dates (from
// derive_program_session_dates) plus its stored class time into:
//   1. an iCalendar (.ics) document with one VEVENT per session — imports into
//      Google Calendar, Apple Calendar, and Outlook, and is what we attach to
//      the confirmation email and offer as a download on the success page.
//   2. a Google Calendar "add event" template link for the FIRST session (a
//      Google template URL can only carry a single event; the .ics carries the
//      full, closure-accurate series).
//
// No tenant literals live here: org/program/location names all come from the
// caller's DB rows. Times are emitted as FLOATING local time (no TZID / no Z),
// which is exactly right for a physical class held in the venue's local time —
// the family attends in that same local time wherever they are.

export interface CalendarEvent {
  programName: string;
  studentName?: string | null;
  orgName: string;
  locationName?: string | null;
  locationAddress?: string | null;
  // ISO 'YYYY-MM-DD' dates, closure-aware (derive_program_session_dates output).
  sessionDates: string[];
  // Free-form stored time. Observed formats in the wild: "3:30 PM", "15:30:00",
  // "15:30", "2:30". parseTime() handles all; unparseable -> all-day events.
  // This is the class's USUAL time and the fallback for any date not overridden.
  startTime?: string | null;
  endTime?: string | null;
  // PER-DATE overrides, keyed by the same 'YYYY-MM-DD' used in sessionDates.
  //
  // Exists because a class can meet at a different time on a specific date: an
  // OCCASIONAL early-release day, where school lets out early and the class
  // starts early with it. Those dates used to be skipped entirely, so one
  // startTime for the whole series was true by construction. It is not any more,
  // and an invite is the worst place to be wrong about it -- the parent's
  // reminder fires at the usual time on precisely the day pickup moved.
  sessionTimes?: Record<string, { start?: string | null; end?: string | null }>;
  // Optional extra description text (e.g. arrival note). Plain text.
  description?: string | null;
}

/**
 * Parse a stored class-time string into 24h {h, m}, or null if we cannot parse
 * it confidently. Handles "3:30 PM", "3 PM", "15:30", "15:30:00", "2:30".
 * A bare "H:MM" with no am/pm is read as 24h (the stored value verbatim).
 */
export function parseTime(raw?: string | null): { h: number; m: number } | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (Number.isNaN(h) || Number.isNaN(min) || min > 59) return null;
  if (ap === 'pm') { if (h < 12) h += 12; }
  else if (ap === 'am') { if (h === 12) h = 0; }
  if (h > 23) return null;
  return { h, m: min };
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, and newlines. */
function escICS(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold a content line to <=75 octets with CRLF + single-space continuation. */
function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    // Continuation lines start with a space, so cap them one octet shorter.
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' -> 'YYYYMMDD'. Returns null if not a plausible date. */
function compactDate(iso: string): string | null {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}

/** Add one day to a compact 'YYYYMMDD' (for exclusive all-day DTEND). */
function nextCompactDay(compact: string): string {
  const y = parseInt(compact.slice(0, 4), 10);
  const mo = parseInt(compact.slice(4, 6), 10);
  const d = parseInt(compact.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}

/** UTC DTSTAMP 'YYYYMMDDTHHMMSSZ' from an ISO instant. */
function utcStamp(nowIso: string): string {
  // nowIso like '2026-07-24T20:11:05.123Z'
  return nowIso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/(\d{8}T\d{6})Z?$/, '$1Z');
}

function summaryFor(ev: CalendarEvent): string {
  const name = ev.programName?.trim() || 'Program';
  const student = ev.studentName?.trim();
  return student ? `${name} (${student})` : name;
}

function locationFor(ev: CalendarEvent): string {
  return [ev.locationName?.trim(), ev.locationAddress?.trim()].filter(Boolean).join(', ');
}

/**
 * The parsed start/end for ONE session date: the per-date override when this
 * date has one, otherwise the class's usual time.
 *
 * An override with an unparseable or absent END is deliberately left null rather
 * than borrowing the class's normal end time. Borrowing would run an
 * early-release class past the early dismissal — the exact error this exists to
 * prevent — whereas null lets the caller apply its documented +1h default from
 * the earlier start, which at worst ends slightly late relative to a shorter
 * session and never contradicts the start.
 */
export function timesForDate(
  ev: CalendarEvent,
  iso: string,
): { start: { h: number; m: number } | null; end: { h: number; m: number } | null } {
  const override = ev.sessionTimes?.[iso];
  if (override && String(override.start ?? '').trim()) {
    return { start: parseTime(override.start), end: parseTime(override.end) };
  }
  return { start: parseTime(ev.startTime), end: parseTime(ev.endTime) };
}

function descriptionFor(ev: CalendarEvent): string {
  const org = (ev.orgName?.trim() || 'your provider').replace(/\.+$/, ''); // avoid "Co.." double period
  const parts = [`${ev.programName?.trim() || 'Program'} with ${org}.`];
  if (ev.description?.trim()) parts.push(ev.description.trim());
  return parts.join(' ');
}

/**
 * Build a full VCALENDAR string (CRLF line endings) with one VEVENT per session.
 * `uidSeed` should be stable per checkout (e.g. the Stripe session id) so a
 * re-import updates rather than duplicates; each event's UID is derived from it.
 * `nowIso` is an ISO instant for DTSTAMP (caller passes new Date().toISOString()).
 * Returns '' when there is nothing to schedule (no events / no dates).
 */
export function buildIcs(
  events: CalendarEvent[],
  opts: { uidSeed: string; nowIso: string },
): string {
  const stamp = utcStamp(opts.nowIso);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//enrops//registration//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  let count = 0;
  events.forEach((ev, ei) => {
    const summary = summaryFor(ev);
    const location = locationFor(ev);
    const description = descriptionFor(ev);

    (ev.sessionDates || []).forEach((iso, di) => {
      const day = compactDate(iso);
      if (!day) return;
      // Resolved PER DATE, not once per event. An early-release date carries its
      // own pair; every other date falls back to the class's usual time.
      const { start, end } = timesForDate(ev, iso);
      count += 1;
      const uid = `enrops-${opts.uidSeed}-${ei}-${di}@enrops.com`;
      lines.push('BEGIN:VEVENT');
      lines.push(foldLine(`UID:${uid}`));
      lines.push(`DTSTAMP:${stamp}`);
      if (start) {
        // End defaults to +1h when only a start time is known. A class never
        // crosses midnight, so DTEND stays on the same day.
        const endHM = end ?? { h: (start.h + 1) % 24, m: start.m };
        lines.push(`DTSTART:${day}T${pad(start.h)}${pad(start.m)}00`);
        lines.push(`DTEND:${day}T${pad(endHM.h)}${pad(endHM.m)}00`);
      } else {
        // Unknown/garbled time -> all-day event so the day still lands on the
        // family's calendar. DTEND is exclusive (next day) per RFC 5545.
        lines.push(`DTSTART;VALUE=DATE:${day}`);
        lines.push(`DTEND;VALUE=DATE:${nextCompactDay(day)}`);
      }
      lines.push(foldLine(`SUMMARY:${escICS(summary)}`));
      if (location) lines.push(foldLine(`LOCATION:${escICS(location)}`));
      lines.push(foldLine(`DESCRIPTION:${escICS(description)}`));
      lines.push('END:VEVENT');
    });
  });

  if (count === 0) return '';
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Google Calendar "add event" template URL for the FIRST session of an event.
 * (Google template URLs carry a single event; the .ics covers the full series.)
 * Returns null when there is no usable first date.
 */
export function googleCalendarUrl(ev: CalendarEvent): string | null {
  const firstIso = (ev.sessionDates || []).find((d) => compactDate(d));
  const first = firstIso ? compactDate(firstIso) : null;
  if (!first || !firstIso) return null;
  // The first session can itself be an early-release one, so its time is
  // resolved the same way every other date's is.
  const { start, end } = timesForDate(ev, firstIso);
  let dates: string;
  if (start) {
    const endHM = end ?? { h: (start.h + 1) % 24, m: start.m };
    dates = `${first}T${pad(start.h)}${pad(start.m)}00/${first}T${pad(endHM.h)}${pad(endHM.m)}00`;
  } else {
    dates = `${first}/${nextCompactDay(first)}`;
  }
  // Build by hand so the `dates` range keeps its literal "/" (URLSearchParams
  // would percent-encode it). Every value is still individually URL-encoded.
  const enc = (s: string) => encodeURIComponent(s);
  const parts = [
    'action=TEMPLATE',
    `text=${enc(summaryFor(ev))}`,
    `dates=${dates}`,
    `details=${enc(descriptionFor(ev))}`,
  ];
  const location = locationFor(ev);
  if (location) parts.push(`location=${enc(location)}`);

  // Add the WHOLE series, not just week 1. Google's template URL carries a
  // single event, but it accepts an RFC-5545 recurrence rule (`recur`), which
  // materialises as every occurrence — so a family taps once and gets all 8
  // classes instead of one Thursday and a puzzle.
  //
  // ONLY when the real dates are a clean weekly cadence. Our dates are
  // closure-aware, so a term with a no-school week has GAPS that FREQ=WEEKLY
  // would silently paper over — it would put a class on a day the child
  // shouldn't attend, which is worse than one correct event. In that case we
  // fall back to the single first session; the .ics attachment always carries
  // the exact, gap-accurate series for every calendar app.
  //
  // AND only when every session runs at the SAME time. A recurrence rule carries
  // one start/end for all occurrences, so a series containing an early-release
  // date would put that date at the usual time — the identical failure to the
  // gap case above, and on the one day it matters most. Mixed times fall back to
  // the single first session; the .ics attachment still carries every date at
  // its own time.
  const rule = uniformTimes(ev) ? weeklyRecurrenceRule(ev.sessionDates || []) : null;
  if (rule) parts.push(`recur=${enc(rule)}`);

  return `https://calendar.google.com/calendar/render?${parts.join('&')}`;
}

/**
 * True when every session date resolves to the same start and end. False as soon
 * as one date carries a different time (an early-release session), which is what
 * disqualifies a series from being expressed as a single recurrence rule.
 */
export function uniformTimes(ev: CalendarEvent): boolean {
  const dates = (ev.sessionDates || []).filter((d) => compactDate(d));
  if (dates.length < 2) return true;
  const key = (iso: string) => {
    const { start, end } = timesForDate(ev, iso);
    return `${start ? `${start.h}:${start.m}` : '-'}|${end ? `${end.h}:${end.m}` : '-'}`;
  };
  const first = key(dates[0]);
  return dates.every((d) => key(d) === first);
}

/**
 * RRULE for a session list that is EXACTLY weekly (every date 7 days after the
 * previous one). Returns null for a single session or any irregular spacing —
 * caller then links only the first session.
 */
export function weeklyRecurrenceRule(sessionDates: string[]): string | null {
  const days = (sessionDates || [])
    .map((iso) => (typeof iso === 'string' ? iso.slice(0, 10) : ''))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (days.length < 2) return null;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  for (let i = 1; i < days.length; i += 1) {
    const prev = Date.parse(`${days[i - 1]}T00:00:00Z`);
    const cur = Date.parse(`${days[i]}T00:00:00Z`);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) return null;
    if (cur - prev !== WEEK_MS) return null; // a closure or an irregular term
  }
  return `RRULE:FREQ=WEEKLY;COUNT=${days.length}`;
}

/** Shape of a registration row (as selected by the confirmation paths) we can
 * turn into a calendar event. Only the fields we read are typed. */
export interface RegLike {
  programs?: {
    id?: string | null;
    curriculum?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    program_locations?: { name?: string | null; address?: string | null } | null;
  } | null;
  students?: { first_name?: string | null; last_name?: string | null } | null;
}

/** One meeting: its date and the time IT runs at (not the class's usual time). */
export interface SessionSlot {
  date: string;
  startTime?: string | null;
  endTime?: string | null;
}

/**
 * Map registration rows to CalendarEvent[], deriving each program's real,
 * closure-aware sessions via the caller-supplied `deriveSessions` callback (a
 * thin wrapper over the derive_program_session_schedule RPC — kept out of this
 * module so it stays free of a Supabase dependency). Programs with no id or no
 * derivable sessions are skipped (nothing to put on a calendar).
 *
 * THE CALLBACK RETURNS SLOTS, NOT BARE DATES, and that is deliberate rather than
 * an optional extra. A program can now meet at a different time on an
 * early-release date, and a per-date time that a caller may or may not supply is
 * a fail-open: the caller that forgets produces an invite that is confidently
 * wrong, with nothing to signal it. Making it part of the shape means a caller
 * cannot omit it without the compiler saying so.
 */
export async function calendarEventsFromRegistrations(
  regs: RegLike[],
  orgName: string,
  deriveSessions: (programId: string) => Promise<SessionSlot[]>,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  for (const r of regs || []) {
    const p = r.programs;
    if (!p?.id) continue;
    let slots: SessionSlot[] = [];
    try { slots = (await deriveSessions(p.id)) || []; } catch { slots = []; }
    slots = slots.filter((s) => s && typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date));
    if (slots.length === 0) continue;
    const student = [r.students?.first_name, r.students?.last_name].filter(Boolean).join(' ').trim() || null;
    // Only dates that genuinely differ from the class's usual time become
    // overrides, so an ordinary series carries no map at all and behaves exactly
    // as it did before this existed.
    const sessionTimes: Record<string, { start?: string | null; end?: string | null }> = {};
    for (const s of slots) {
      const differs =
        (s.startTime ?? null) !== (p.start_time ?? null) ||
        (s.endTime ?? null) !== (p.end_time ?? null);
      if (differs && String(s.startTime ?? '').trim()) {
        sessionTimes[s.date] = { start: s.startTime ?? null, end: s.endTime ?? null };
      }
    }
    events.push({
      programName: p.curriculum || 'Program',
      studentName: student,
      orgName,
      locationName: p.program_locations?.name ?? null,
      locationAddress: p.program_locations?.address ?? null,
      sessionDates: slots.map((s) => s.date),
      startTime: p.start_time ?? null,
      endTime: p.end_time ?? null,
      ...(Object.keys(sessionTimes).length > 0 ? { sessionTimes } : {}),
    });
  }
  return events;
}

/** UTF-8 base64 of a string (chunked; safe for Resend attachment `content`). */
export function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
