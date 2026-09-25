// Making a camp from the Programs screen, without the operator ever meeting a
// "cycle".
//
// camp_sessions.cycle_id and .week_num are both NOT NULL. They exist for the
// instructor scheduling board, which groups camps into a term and lays them out
// week by week. An operator adding a camp beside their weekly classes has no
// board, has never created a cycle, and has no reason to learn what one is - and
// for a registration-only tenant the board is not even reachable. So the cycle is
// derived from the term the camp already belongs to, and created on first use.
//
// One cycle per (org, term code), reused by every camp in that term, widened when
// a camp falls outside its current range.

// The weekdays a camp can run, LOWERCASE, because that is what
// camp_sessions.class_days stores and what the pay cron matches on. Shared so the
// two camp forms cannot drift - programs.day_of_week is Title-Case and the two
// columns genuinely disagree, which is exactly the kind of difference that gets
// "tidied up" into a bug.
export const CAMP_WEEKDAYS = [
  { value: "monday", label: "Mon" },
  { value: "tuesday", label: "Tue" },
  { value: "wednesday", label: "Wed" },
  { value: "thursday", label: "Thu" },
  { value: "friday", label: "Fri" },
];

/**
 * Turn a day on or off, keeping the canonical Mon-Fri order.
 *
 * Written out separately in two forms before this, and the two copies had already
 * diverged: one was fixed to stop the add branch DELETING days it has no button
 * for (a weekend camp storing 'saturday' lost it on the first click, and with it
 * that day's pay and its share of a refund), the other still rebuilt from the
 * weekday list. Both write the same column, read by the same cron.
 */
export function toggleCampDay(days, day) {
  const list = Array.isArray(days) ? days : [];
  if (list.includes(day)) return list.filter((d) => d !== day);
  const order = CAMP_WEEKDAYS.map((d) => d.value);
  const rank = (d) => (order.indexOf(d) === -1 ? order.length : order.indexOf(d));
  return [...list, day].sort((a, b) => rank(a) - rank(b));
}

// Mon-Fri weeks inside a date range. Shared with the schedule board's New Cycle
// modal rather than spelled a second time - a cycle built here and a cycle built
// there must agree about what "week 3" means, or a camp lands in the wrong column.
export function computeWeeks(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  const cursor = new Date(start);
  const dow = cursor.getDay(); // 0=Sun, 1=Mon, ...
  const daysToMon = (1 - dow + 7) % 7;
  cursor.setDate(cursor.getDate() + daysToMon);

  const weeks = [];
  let num = 1;
  while (cursor <= end) {
    const wStart = new Date(cursor);
    const wEnd = new Date(cursor);
    wEnd.setDate(wEnd.getDate() + 4);
    if (wEnd > end) break;
    weeks.push({
      num,
      starts_on: wStart.toISOString().slice(0, 10),
      ends_on: wEnd.toISOString().slice(0, 10),
    });
    num++;
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

// The Monday of a date's week, so a camp starting mid-week still lands in the
// week that contains it.
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// The Friday of a date's week. A CYCLE is measured in whole Mon-Fri weeks even
// when the camp inside it is not: computeWeeks drops any span that does not hold
// a full one, so a Monday-to-Thursday camp - a holiday week, the exact case this
// was built for - produced a cycle with ZERO weeks and a camp that could never
// appear on the board. The camp still runs four days; its class_days say so.
function fridayOf(iso) {
  const d = new Date(`${mondayOf(iso)}T00:00:00`);
  d.setDate(d.getDate() + 4);
  return d.toISOString().slice(0, 10);
}

/**
 * Find or create this term's camp cycle and say which week the camp falls in.
 *
 * Returns { cycleId, weekNum }. Throws on a real database failure - the caller
 * must not write a camp row it cannot place.
 */
export async function ensureCampCycle(supabase, { orgId, termCode, startsOn, endsOn }) {
  if (!orgId || !termCode || !startsOn) throw new Error("Cannot place a camp without an organisation, a term and a start date.");
  const campStart = String(startsOn).slice(0, 10);
  const campEnd = String(endsOn || startsOn).slice(0, 10);

  // "FA26 camps", never "FA26". scheduling_cycles has a UNIQUE index on
  // (organization_id, name), and a term usually ALREADY has an after-school cycle
  // under its plain code - J2S has exactly that - so naming the camp cycle after
  // the bare term would collide and the save would die on the insert. The suffix
  // also reads correctly in the board's term picker, which lists camp cycles and
  // after-school terms side by side and would otherwise show the same label twice.
  const cycleName = `${termCode} camps`;

  const { data: existing, error: findErr } = await supabase
    .from("scheduling_cycles")
    .select("id, starts_on, ends_on, weeks")
    .eq("organization_id", orgId)
    .eq("name", cycleName)
    .eq("cycle_type", "summer_camp")
    .maybeSingle();
  if (findErr) throw findErr;

  // The range the cycle has to cover once this camp is in it. A cycle's weeks are
  // whole Mon-Fri spans, so the range is widened to the camp's Monday at the
  // earliest - otherwise the camp's own week is not a full week and gets dropped.
  const rangeStart = mondayOf(existing?.starts_on && existing.starts_on < campStart ? existing.starts_on : campStart);
  const rangeEnd = fridayOf(existing?.ends_on && existing.ends_on > campEnd ? existing.ends_on : campEnd);
  const weeks = computeWeeks(rangeStart, rangeEnd);

  let cycleId = existing?.id ?? null;
  if (!cycleId) {
    // upsert, not insert. scheduling_cycles is UNIQUE on (organization_id, name),
    // and two admins adding the term's FIRST camp within a few seconds both read
    // no row and both write one - the loser used to get a raw constraint error
    // and lose the form. ignoreDuplicates means the loser simply gets no row back
    // and re-reads below, which is the correct answer: the cycle now exists.
    const { data, error } = await supabase
      .from("scheduling_cycles")
      .upsert({
        organization_id: orgId,
        name: cycleName,
        cycle_type: "summer_camp",
        starts_on: rangeStart,
        ends_on: rangeEnd,
        weeks,
        // 'collecting' is where a brand new cycle starts on the board too, so an
        // org that later turns the board on finds it in the state it expects.
        status: "collecting",
        auto_reminders_enabled: false,
      }, { onConflict: "organization_id,name", ignoreDuplicates: true })
      .select("id")
      .maybeSingle();
    if (error) throw error;
    cycleId = data?.id ?? null;
    if (!cycleId) {
      // Somebody else created it between our read and our write. Re-read rather
      // than fail: the cycle we wanted now exists, which is the outcome we were
      // after. maybeSingle, because a genuinely missing row here means something
      // else is wrong and should surface as the explicit error below.
      const { data: raced, error: reReadErr } = await supabase
        .from("scheduling_cycles")
        .select("id")
        .eq("organization_id", orgId)
        .eq("name", cycleName)
        .maybeSingle();
      if (reReadErr) throw reReadErr;
      if (!raced?.id) throw new Error("Could not set up a term for this camp. Try saving it again.");
      cycleId = raced.id;
    }
  } else if (rangeStart !== existing.starts_on || rangeEnd !== existing.ends_on) {
    // Widen, and renumber the weeks to match. Deliberately not silent about
    // failing: a cycle whose weeks do not cover this camp cannot place it.
    const { error } = await supabase
      .from("scheduling_cycles")
      .update({ starts_on: rangeStart, ends_on: rangeEnd, weeks, updated_at: new Date().toISOString() })
      .eq("id", cycleId);
    if (error) throw error;
  }

  const campMonday = mondayOf(campStart);
  const match = weeks.find((w) => w.starts_on === campMonday);
  // camp_sessions_week_num_check allows 1-20. A term is about fourteen weeks, so
  // exceeding that means the dates are wrong rather than the camp being real;
  // clamping keeps the save working and the board readable.
  const weekNum = Math.min(Math.max(match?.num ?? 1, 1), 20);
  return { cycleId, weekNum };
}

/**
 * morning / afternoon / full_day, derived from the hours rather than asked.
 * camp_sessions.session_type is NOT NULL and drives the board's double-booking
 * check (a morning and an afternoon camp do not clash). Nothing about it is worth
 * a question on a form when the times already answer it.
 */
export function deriveSessionType(startTime, endTime) {
  const toMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const s = toMin(startTime);
  const e = toMin(endTime);
  if (s == null) return "morning";
  if (e != null && e - s > 4 * 60) return "full_day";
  return s < 12 * 60 ? "morning" : "afternoon";
}
