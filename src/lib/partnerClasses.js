// Partner portal "Classes" section (20261119a; finished classes and the
// end-of-term summary 20261125t): the words and ordering, pure.
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

/** The chip: Cancelled / Not open yet / Finished / Full / Open. Full needs a maximum and a live or typed count. */
export function classBadge(c) {
  if (c.status === "cancelled") return { label: "Cancelled", tone: "bad" };
  if (c.status === "draft") return { label: "Not open yet", tone: "neutral" };
  // Past its last date (20261125t): listed 60 more days so it can be invoiced.
  if (c.status === "finished") return { label: "Finished", tone: "neutral" };
  const max = Number(c.max_capacity);
  if (c.count_source !== "partner" && c.enrolled != null && max > 0 && c.enrolled >= max) return { label: "Full", tone: "good" };
  return { label: "Open", tone: "good" };
}

/** Is this class running or just finished (not cancelled, not a draft)? */
function isLive(c) {
  return c.status === "open" || c.status === "finished";
}

/** Can this row's roster be opened? A live enrops class, running or finished. */
export function rosterAvailable(c) {
  return c.count_source === "enrops" && isLive(c);
}

/** Can this row's sessions (and, for enrops classes, what families paid) be opened? */
export function summaryAvailable(c) {
  return isLive(c);
}

/** The row's one button: "Roster & sessions", "Sessions", or null. */
export function detailsButtonText(c, isOpen) {
  if (!summaryAvailable(c)) return null;
  if (isOpen) return rosterAvailable(c) ? "Hide roster & sessions" : "Hide sessions";
  return rosterAvailable(c) ? "Roster & sessions" : "Sessions";
}

const SESSION_WORD = { held: "Held", cancelled: "Cancelled", upcoming: "Upcoming", not_confirmed: "Not confirmed yet" };

/** "Held" / "Cancelled" / "Upcoming" / "Not confirmed yet". */
export function sessionStatusText(status) {
  return SESSION_WORD[status] ?? "Not confirmed yet";
}

/**
 * "7 of 8 sessions held · 1 not confirmed yet · 1 cancelled". The count is of
 * sessions that were on the schedule (cancelled ones are named separately).
 * Every part is a true statement of the list it summarizes.
 */
export function sessionsHeadline(sessions) {
  const list = sessions ?? [];
  if (!list.length) return "No session dates set";
  const n = (s) => list.filter((x) => x.status === s).length;
  const scheduled = list.length - n("cancelled");
  const parts = [`${n("held")} of ${scheduled} ${scheduled === 1 ? "session" : "sessions"} held`];
  if (n("not_confirmed")) parts.push(`${n("not_confirmed")} not confirmed yet`);
  if (n("upcoming")) parts.push(`${n("upcoming")} upcoming`);
  if (n("cancelled")) parts.push(`${n("cancelled")} cancelled`);
  return parts.join(" · ");
}

/** "$1,686.00" from cents. */
export function dollars(cents) {
  return (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * "Families paid $1,686.00, after discounts and refunds (6 of the 6 children
 * on the roster paid)." The roster count is said beside it because some
 * children on a roster paid nothing (free, refunded, added without a charge),
 * and "for 1 child" next to "5/14" read as a mistake (Jessica 2026-11-25).
 * `enrolled` = the class's roster count; omitted, no comparison is made.
 * null when there is no money line (families did not register through enrops).
 */
export function paidText(money, enrolled = null) {
  if (!money) return null;
  const n = Number(money.children || 0);
  const total = Number(enrolled);
  const ofRoster = Number.isInteger(total) && total > 0
    ? ` (${n} of the ${total} ${total === 1 ? "child" : "children"} on the roster paid)`
    : n > 0 ? ` (${n} ${n === 1 ? "child" : "children"})` : "";
  if (n === 0) return `No payments yet${ofRoster}.`;
  return `Families paid ${dollars(money.paid_cents)}, after discounts and refunds${ofRoster}.`;
}

/**
 * One child's "Paid" cell (Jessica 2026-11-25: "put per person what they
 * paid"). `entry` = one of summary.money.by_child; null = no money shown.
 */
export function childPaidText(entry) {
  if (!entry) return "";
  switch (entry.status) {
    case "paid": return dollars(entry.paid_cents);
    case "paying": return `${dollars(entry.paid_cents)} so far (paying in instalments)`;
    case "free": return "Free";
    case "refunded": return "Refunded";
    case "processing": return "Bank payment pending";
    default: return "Not paid";
  }
}

/** row_key -> by_child entry, for the roster's Paid column. null when there is no money to show. */
export function paidByChild(money) {
  if (!money || !Array.isArray(money.by_child)) return null;
  return new Map(money.by_child.map((e) => [e.row_key, e]));
}

/** One CSV cell, quoted when needed, and never read as a formula by Excel or Sheets. */
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The downloadable summary for one class: what a partner attaches to an
 * invoice. Class, sessions with their status, what families paid (when
 * known), then the roster. `rows` are rosterDisplayRows (or null when the
 * roster is not shown for this class).
 */
export function classSummaryCsv(c, summary, rows, { providerName = "", termLabel = "" } = {}) {
  const out = [];
  const line = (...cells) => out.push(cells.map(csvCell).join(","));
  line("Class", c.title || "Untitled class");
  line("Site", c.site || "");
  if (termLabel) line("Term", termLabel);
  if (providerName) line("Provider", providerName);
  line("Schedule", scheduleText(c));
  out.push("");
  const sessions = summary?.sessions ?? [];
  line("Sessions", sessionsHeadline(sessions));
  line("Date", "Status");
  for (const s of sessions) line(s.date, sessionStatusText(s.status));
  const paid = paidText(summary?.money);
  if (paid) {
    out.push("");
    line("Families paid", dollars(summary.money.paid_cents));
    line("Children paid for", Number(summary.money.children || 0));
    if (Number.isInteger(Number(c.enrolled)) && c.enrolled != null) line("Children on the roster", Number(c.enrolled));
  }
  if (rows) {
    out.push("");
    const homeroom = showsHomeroom(rows);
    // Paid per child only when the money line is shown at all.
    const byChild = paid ? paidByChild(summary.money) : null;
    line("Student", "Grade", ...(homeroom ? ["Homeroom"] : []), ...(byChild ? ["Paid"] : []));
    for (const r of rows) {
      line(r.name, r.grade, ...(homeroom ? [r.homeroom ?? ""] : []),
        ...(byChild ? [childPaidText(byChild.get(r.key))] : []));
    }
  }
  return out.join("\r\n");
}

/** "Super Mario Game Makers - Fall 2026.csv", safe for a file name. */
export function summaryFileName(c, termLabel) {
  const base = [c.title || "Class", termLabel].filter(Boolean).join(" - ");
  return `${base.replace(/[\\/:*?"<>|]+/g, "").trim() || "Class"} summary.csv`;
}

/**
 * The term code a dated camp falls in, by its first date's month: Dec-Feb
 * Winter (December counts toward the next year, as a provider's "Winter
 * 2026/27" does), Mar-May Spring, Jun-Aug Summer, Sep-Nov Fall. Classes carry
 * their own programs.term and never come here. null with no date.
 */
export function termCodeForDate(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(iso ?? ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month === 12) return `WI${String((year + 1) % 100).padStart(2, "0")}`;
  const yy = String(year % 100).padStart(2, "0");
  if (month <= 2) return `WI${yy}`;
  if (month <= 5) return `SP${yy}`;
  if (month <= 8) return `SU${yy}`;
  return `FA${yy}`;
}

/** A class's term: its own, else (a camp) the season of its first date. */
export function termOfClass(c) {
  return c?.term || termCodeForDate(c?.first_date) || null;
}

/**
 * Classes in term groups, earliest term first (Kacy Cullen, 2026-11-19):
 * [{ key, label, classes }]. `labelFor(code)` turns "WI27" into "Winter
 * 2027" (terms.js formatTermLabel, passed in so this file stays free of the
 * Supabase client). A class with no term and no date goes in a last group,
 * "Dates not set yet". Within a group, sortClasses order.
 */
export function groupClassesByTerm(rows, labelFor = (t) => t) {
  const groups = new Map();
  for (const c of rows ?? []) {
    const key = termOfClass(c) ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const firstDate = (cs) => cs.map((c) => c.first_date).filter(Boolean).sort()[0] ?? "9999";
  return [...groups.entries()]
    .map(([key, cs]) => ({ key, label: key ? labelFor(key) : "Dates not set yet", classes: sortClasses(cs), start: firstDate(cs) }))
    .sort((a, b) => (a.key === "") - (b.key === "") || a.start.localeCompare(b.start) || a.key.localeCompare(b.key))
    .map(({ key, label, classes }) => ({ key, label, classes }));
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
    // null when the database sends none: it sends homeroom only for a school's
    // class (20261119c), so parks and camps never get the column.
    homeroom: (r.homeroom ?? "").trim() || null,
    dismissal: dismissalSummary(r) ?? "Not stated",
  }));
}

/** Show the Homeroom column? Only when some child on this roster has one. */
export function showsHomeroom(rows) {
  return (rows ?? []).some((r) => !!r.homeroom);
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
