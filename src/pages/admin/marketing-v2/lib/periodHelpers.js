// Pure helpers used by both the period detector (which fetches from Supabase)
// and the intent registry (which is pure). Living in their own file so the
// intent registry can be unit-tested without a Supabase client.
//
// No supabase imports here.

// Low-enrollment rule. ONE PLACE TO EDIT — Q1 picker, intent registry, and
// any future surface that needs "is this program at risk" all call this.
//
// Rule (refined 2026-06-02 after Jessica caught Portland camps being
// excluded by an overly tight proximity gate):
//   A program/camp is "low" when:
//     1. class_size_min is known (otherwise honest-default false — fix is to
//        populate curricula.class_size_min, not to invent a heuristic), AND
//     2. current_enrollment < class_size_min, AND
//     3. EITHER first_session_date is within 14 days (any below-min is
//        urgent regardless of how few have registered) OR enrollment >= 1
//        (there's a real signal of struggling — at least one parent signed
//        up but the group hasn't reached minimum yet).
//
//   The OR catches the gap the old 42-day gate missed: a camp 60 days out
//   with 3/4 enrolled IS actionable (it's filling slowly), but a camp 60
//   days out with 0 enrolled isn't yet (could be "registration just
//   opened" — wait for signal). The 14-day exception keeps last-call urgency
//   regardless of zero-enrolled state.
export function isLowEnrollment(item) {
  const enrolled = item.enrolled ?? item.current_enrollment ?? 0;
  const min = item.class_size_min;
  if (min == null) return false;
  if (enrolled >= min) return false;
  const startIso = item.first_session_date ?? item.starts_on;
  if (!startIso) return false;
  const today = startOfToday();
  const target = new Date(`${startIso}T00:00:00`);
  const daysUntilStart = Math.ceil((target.getTime() - today.getTime()) / 86400000);
  if (daysUntilStart <= 14) return true;
  if (enrolled >= 1) return true;
  return false;
}

// "Has room to fill" — current enrollment is below class_size_max. Used by
// fill_remaining_seats to pick programs that still have meaningful headroom.
// Returns false when class_size_max is unknown (same honest-default reason).
export function hasRoomToFill(item) {
  const enrolled = item.enrolled ?? item.current_enrollment ?? 0;
  const max = item.class_size_max;
  if (max == null) return false;
  return enrolled < max;
}

// "FA26" + "afterschool" -> "Fall 2026 After-School"
// Friendly full-word format chosen over the internal code (decided with
// Jessica end of FA26 ship session).
export function formatPeriodLabel(term, programType) {
  const seasonMap = { FA: "Fall", SP: "Spring", SU: "Summer", WI: "Winter" };
  const code = term?.slice(0, 2);
  const yy = term?.slice(2);
  const season = seasonMap[code] ?? code ?? term;
  const year = yy ? `20${yy}` : "";
  const typeLabel = programType === "afterschool" ? "After-School" : "Camps";
  return `${season} ${year} ${typeLabel}`.trim().replace(/\s+/g, " ");
}

// Derives an FA26/WI27/SP27/SU26-style term from a calendar date. Used for
// camps (no `term` column). Convention: months map to seasons as:
//   Jun-Aug = SU, Sep-Nov = FA, Dec-Feb = WI, Mar-May = SP.
// A December camp counts as next year's winter; J2S has no winter camps
// today so this is documented but untested at scale.
export function deriveCampTerm(startsOn) {
  if (!startsOn) return "(no term)";
  const d = new Date(`${startsOn}T00:00:00`);
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  if (month >= 6 && month <= 8) return `SU${String(year).slice(-2)}`;
  if (month >= 9 && month <= 11) return `FA${String(year).slice(-2)}`;
  if (month === 12) return `WI${String(year + 1).slice(-2)}`;
  if (month <= 2) return `WI${String(year).slice(-2)}`;
  return `SP${String(year).slice(-2)}`;
}

// Time signal precedence (spec §"Top of Q1"):
//   1. Active early-bird ending within 14 days  → "Early-bird ends <date>"
//   2. First session within 14 days             → "Starts in N days"
//   3. Otherwise                                → "Open registration"
export function computeTimeSignal(facts) {
  if (facts.daysUntilEarlyBird != null && facts.daysUntilEarlyBird <= 14) {
    return `Early-bird ends ${formatLongDate(facts.earliestActiveEarlyBird)}`;
  }
  if (facts.daysUntilFirstSession != null && facts.daysUntilFirstSession <= 14) {
    if (facts.daysUntilFirstSession <= 0) return "Starts today";
    if (facts.daysUntilFirstSession === 1) return "Starts tomorrow";
    return `Starts in ${facts.daysUntilFirstSession} days`;
  }
  return "Open registration";
}

// ---------- Date utilities ----------

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
export function daysFromToday(iso, today = startOfToday()) {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`);
  return Math.ceil((target.getTime() - today.getTime()) / 86400000);
}
export function formatLongDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
