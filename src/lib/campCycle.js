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

  const { data: existing, error: findErr } = await supabase
    .from("scheduling_cycles")
    .select("id, starts_on, ends_on, weeks")
    .eq("organization_id", orgId)
    .eq("name", termCode)
    .eq("cycle_type", "summer_camp")
    .maybeSingle();
  if (findErr) throw findErr;

  // The range the cycle has to cover once this camp is in it. A cycle's weeks are
  // whole Mon-Fri spans, so the range is widened to the camp's Monday at the
  // earliest - otherwise the camp's own week is not a full week and gets dropped.
  const rangeStart = mondayOf(existing?.starts_on && existing.starts_on < campStart ? existing.starts_on : campStart);
  const rangeEnd = existing?.ends_on && existing.ends_on > campEnd ? existing.ends_on : campEnd;
  const weeks = computeWeeks(rangeStart, rangeEnd);

  let cycleId = existing?.id ?? null;
  if (!cycleId) {
    const { data, error } = await supabase
      .from("scheduling_cycles")
      .insert({
        organization_id: orgId,
        name: termCode,
        cycle_type: "summer_camp",
        starts_on: rangeStart,
        ends_on: rangeEnd,
        weeks,
        // 'collecting' is where a brand new cycle starts on the board too, so an
        // org that later turns the board on finds it in the state it expects.
        status: "collecting",
        auto_reminders_enabled: false,
      })
      .select("id")
      .single();
    if (error) throw error;
    cycleId = data.id;
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
