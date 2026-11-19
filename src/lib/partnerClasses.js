// Partner portal "Classes" section (20261119a): the words and ordering, pure.
// The numbers come from public.partner_portal_classes(); this file only says
// them. Where a count comes from is decided in the database (count_source):
//   'enrops'   live, equals the roster (private.registration_on_roster)
//   'provider' typed by the provider (reported_enrollments), with its date
//   'partner'  the partner registers; enrops has no count
// One rule per question here, so the partner page and the provider's own page
// for that partner (both render ClassesTable) can never say different things.

import { formatDate } from "./providerDocumentLogic.js";
import { sortRosterRows } from "./rosterOrder.js";
import { gradeLabel } from "./grades.js";
import { dismissalSummary } from "./dismissal.js";

const DAY_SHORT = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

function shortDay(d) {
  const k = String(d ?? "").trim().toLowerCase();
  return DAY_SHORT[k] ?? (k ? String(d).trim().slice(0, 3) : "");
}

/** "Jan 12" (or "Jan 12, 2027" when it is not this year). Date-only, no timezone drift. */
export function shortDate(iso, thisYear = new Date().getFullYear()) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  if (y !== thisYear) opts.year = "numeric";
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", opts);
}

/** "Tue 4:15 PM, Jan 12 to Mar 9". Each part only when it is known. */
export function scheduleText(c, thisYear) {
  const days = (c.class_days && c.class_days.length ? c.class_days : [c.day_of_week]).map(shortDay).filter(Boolean);
  const when = [days.join(", "), c.start_time].filter(Boolean).join(" ");
  let span = "";
  if (c.first_date && c.last_date && c.first_date !== c.last_date) span = `${shortDate(c.first_date, thisYear)} to ${shortDate(c.last_date, thisYear)}`;
  else if (c.first_date) span = shortDate(c.first_date, thisYear);
  return [when, span].filter(Boolean).join(", ") || "Dates not set yet";
}

/** "5/18", or "5" with no maximum set. null when there is no number to show. */
export function enrolledText(c) {
  if (c.count_source === "partner") return null;
  if (c.enrolled == null) return null;
  return Number(c.max_capacity) > 0 ? `${c.enrolled}/${c.max_capacity}` : String(c.enrolled);
}

/**
 * The line under the count saying where it came from. Every branch is a true
 * sentence in the state that picks it:
 *   partner   -> the partner registers, so there is no enrops count at all
 *   provider  -> typed, with the day it was typed; or not typed yet
 *   enrops    -> live from registrations
 */
export function countSourceText(c, { viewer = "partner", partnerName = "", orgName = "" } = {}) {
  if (c.count_source === "partner") {
    return viewer === "partner" ? "You run registration for this class" : `${partnerName || "The partner"} runs registration for this class`;
  }
  if (c.count_source === "provider") {
    if (c.enrolled == null) return viewer === "partner" ? `${orgName || "The provider"} hasn't entered a count yet` : "You haven't entered a count yet";
    return `Entered by ${viewer === "partner" ? (orgName || "the provider") : "you"}, as of ${formatDate(c.reported_on)}`;
  }
  return "Live from registrations";
}

/** The chip: Cancelled / Not open yet / Full / Open. Full needs a maximum and a live or typed count. */
export function classBadge(c) {
  if (c.status === "cancelled") return { label: "Cancelled", tone: "bad" };
  if (c.status === "draft") return { label: "Not open yet", tone: "neutral" };
  const max = Number(c.max_capacity);
  if (c.count_source !== "partner" && c.enrolled != null && max > 0 && c.enrolled >= max) return { label: "Full", tone: "good" };
  return { label: "Open", tone: "good" };
}

/** Can this row's roster be opened? Only a live enrops class that is open. */
export function rosterAvailable(c) {
  return c.count_source === "enrops" && c.status === "open";
}

/** Sites, then first date, then name: the order a coordinator scans a season in. */
export function sortClasses(rows) {
  return [...(rows ?? [])].sort((a, b) =>
    String(a.site ?? "").localeCompare(String(b.site ?? ""))
    || String(a.first_date ?? "9999").localeCompare(String(b.first_date ?? "9999"))
    || String(a.title ?? "").localeCompare(String(b.title ?? "")),
  );
}

/**
 * Roster rows in the shared roster order (rosterOrder.js, the same one the
 * emailed roster PDF and the instructor portal use), shaped for display.
 */
export function rosterDisplayRows(rows) {
  const shaped = (rows ?? []).map((r) => ({
    id: r.row_key,
    registered_at: r.registered_at,
    student: { first_name: r.first_name, last_name: r.last_name },
    r,
  }));
  return sortRosterRows(shaped).map(({ id, r }) => ({
    key: id,
    name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Unnamed",
    grade: gradeLabel(r.grade) ?? "",
    homeroom: (r.homeroom ?? "").trim() || "Not stated",
    dismissal: dismissalSummary(r) ?? "Not stated",
  }));
}

/**
 * Does this business ask families the dismissal question? The rule the emailed
 * roster uses (_shared/rosterArrivalDismissal.ts orgAsksDismissal): an active
 * dismissal_method field that applies to this kind. `fields` null = the read
 * failed, which shows the column (a "Not stated" column is a cosmetic cost;
 * hiding real answers from a partner is not).
 */
export function asksDismissal(fields, kind) {
  if (fields == null) return true;
  const want = kind === "camp" ? "camp" : "afterschool";
  return fields.some((f) =>
    f?.standard_key === "dismissal_method"
    && f?.is_active !== false
    && (f?.applies_to !== "enrollment_type" || f?.applies_to_value === want));
}
