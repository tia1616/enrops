// scheduleNormalize — turn a raw parsed spreadsheet row (already column-mapped on
// the client) into a clean `class_schedule` row for insert. Pure functions, no
// Supabase/network — so import-class-schedule uses it AND deno tests cover it.
//
// The client sends rows keyed by our field names (title, day_of_week, start_time,
// …); this module tidies the messy values operators actually paste: "mon" ->
// "Monday", "4pm" -> "4:00 PM", "16:00" -> "4:00 PM". A row with no usable title
// or an unrecognizable day is rejected (reported back as skipped) rather than
// written half-formed — nothing hard-fails the whole upload.
//
// NOTHING about any one tenant is hardcoded here. organization_id is stamped by
// the edge fn, never read from the row.

export interface IncomingScheduleRow {
  title?: unknown;
  day_of_week?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  location_text?: unknown;
  instructor_name?: unknown;
  instructor_email?: unknown;
  age_min?: unknown;
  age_max?: unknown;
  capacity?: unknown;
  notes?: unknown;
}

// Shape written to class_schedule. organization_id + source are added by the
// caller, not here (org-stamp stays in one place).
export interface CleanScheduleRow {
  title: string;
  day_of_week: string;
  start_time: string | null;
  end_time: string | null;
  location_text: string | null;
  instructor_name: string | null;
  instructor_email: string | null;
  age_min: number | null;
  age_max: number | null;
  capacity: number | null;
  notes: string | null;
}

const DAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Map many spellings to a canonical Title-Case day. Handles full names, 3-letter
// abbreviations, trailing dots ("Mon."), and a few common typos. Returns null
// when we can't be sure — the row is then reported as skipped, not guessed.
const DAY_ALIASES: Record<string, string> = {
  sun: "Sunday", sunday: "Sunday", su: "Sunday",
  mon: "Monday", monday: "Monday", mo: "Monday",
  tue: "Tuesday", tues: "Tuesday", tuesday: "Tuesday", tu: "Tuesday",
  wed: "Wednesday", weds: "Wednesday", wednesday: "Wednesday", we: "Wednesday",
  thu: "Thursday", thur: "Thursday", thurs: "Thursday", thursday: "Thursday", th: "Thursday",
  fri: "Friday", friday: "Friday", fr: "Friday",
  sat: "Saturday", saturday: "Saturday", sa: "Saturday",
};

export function normalizeDay(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const raw = String(v).trim().toLowerCase().replace(/\.+$/, "");
  if (!raw) return null;
  if (DAY_ALIASES[raw]) return DAY_ALIASES[raw];
  // Accept an already-canonical value passed straight through.
  const title = raw.charAt(0).toUpperCase() + raw.slice(1);
  if (DAYS.includes(title)) return title;
  return null;
}

// Canonicalize a clock time to 12-hour "H:MM AM/PM" (matches programs.start_time,
// which is stored as text like "2:05 PM"). Accepts "4pm", "4 PM", "4:00pm",
// "16:00", "4:00", "9:30 a.m.". Returns null if it can't be read as a time.
export function normalizeTime(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/\s+/g, "").replace(/\./g, ""); // "9:30 a.m." -> "9:30am"

  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (Number.isNaN(hour) || minute > 59) return null;

  if (ampm) {
    // 12-hour input with an explicit meridiem.
    if (hour < 1 || hour > 12) return null;
    const suffix = ampm === "am" ? "AM" : "PM";
    return `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
  }
  // No meridiem -> treat as 24-hour clock. 0..23 valid.
  if (hour > 23) return null;
  const suffix = hour < 12 ? "AM" : "PM";
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Non-negative integer or null. Ignores stray units ("grade 3", "3 kids").
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

export type NormalizeResult =
  | { ok: true; row: CleanScheduleRow }
  | { ok: false; reason: "missing_title" | "bad_day" };

// Turn one incoming row into a clean row, or reject it with a reason.
// Required: a title and a recognizable day. Everything else is optional.
export function normalizeScheduleRow(r: IncomingScheduleRow): NormalizeResult {
  const title = str(r.title);
  if (!title) return { ok: false, reason: "missing_title" };
  const day = normalizeDay(r.day_of_week);
  if (!day) return { ok: false, reason: "bad_day" };

  let ageMin = intOrNull(r.age_min);
  let ageMax = intOrNull(r.age_max);
  // Keep the pair sane: if both present but reversed, swap.
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) {
    [ageMin, ageMax] = [ageMax, ageMin];
  }

  return {
    ok: true,
    row: {
      title,
      day_of_week: day,
      start_time: normalizeTime(r.start_time),
      end_time: normalizeTime(r.end_time),
      location_text: str(r.location_text),
      instructor_name: str(r.instructor_name),
      instructor_email: str(r.instructor_email)?.toLowerCase() ?? null,
      age_min: ageMin,
      age_max: ageMax,
      capacity: intOrNull(r.capacity),
      notes: str(r.notes),
    },
  };
}
