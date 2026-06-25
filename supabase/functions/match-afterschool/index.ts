// match-afterschool (v2) — instructor matching for recurring after-school programs.
//
// Aligned with the real provider availability survey:
//   HARD  instructor available the program's weekday, and their selected time
//         buckets cover [class_start - ARRIVAL_BUFFER, class_end] (arrive 15 min
//         early, stay to the end)
//   HARD  one program per weekday (can't be at two schools after dismissal)
//   HARD  respect the days/week cap (max_days)
//   HARD  only `open` programs are auto-matched (drafts excluded)
//   HARD  never auto-assign an instructor to an area they marked `unavailable`
//   SOFT  CURRICULUM continuity (programs.curriculum_id, fallback curriculum text):
//         keep each instructor on as few distinct curricula as possible so they
//         carry 1-2 material sets for the term, not 4-5. This is the DOMINANT soft
//         factor — an instructor who already teaches a curriculum wins any class of
//         that same curriculum they're eligible for, ahead of area preference. The
//         one exception is an area they marked `unavailable`: continuity will not
//         drag them there.
//   SOFT  CURRICULUM FAMILY (curricula.category: lego / coding / robotics): instructors
//         pick the families they enjoy on the survey. A class is nudged toward someone
//         who enjoys its family. Everyone CAN teach everything, so this never excludes.
//   SOFT  AREA preference (program_locations.area): 'preferred' is a small nudge used
//         only to break ties once curriculum + schedule are decided. 'available' (or
//         no preference) is assigned freely — no penalty, no bonus.
//
// Assignment is greedy and curriculum-driven: each round we EXTEND a curriculum
// someone already teaches before SEEDING a new one (so classes of one curriculum
// consolidate onto as few instructors as possible), taking the most-constrained
// class within that set. The winner for a class is chosen by: already-teaches-this
// curriculum -> can-cover-the-most-other-classes-of-it -> enjoys-this-family ->
// area preference -> fewest curricula so far -> confirmed-before-tentative -> fairness.
//
// AUTH: caller must be owner/admin of organization_id. Heavy lifting runs with
// the service role; organization_id + term scope every query.
//
// Input:  { organization_id: string, term: string, dry_run?: boolean }
// Writes: proposed rows to program_assignments (role 'lead', status 'proposed').
//         Confirmed rows are never touched.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DAY_MAP: Record<string, string> = {
  monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri',
};

// Instructors arrive this many minutes before class start (and stay to the end).
const ARRIVAL_BUFFER_MIN = 15;

// AREA preference is now just a gentle TIEBREAKER once curriculum + schedule are set.
// Survey scale: 'preferred' (a nudge) / 'available' (assign freely, no penalty) /
// 'unavailable' (never auto-assigned). Legacy values are mapped for back-compat:
// 'highly_preferred' -> preferred; 'neutral' / 'not_preferred' -> available.
const PREFERRED_AREA_SCORE = 10; // 'preferred' (or legacy 'highly_preferred')
const NEUTRAL_AREA_SCORE = 0;    // 'available', no preference, or legacy 'not_preferred'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function dayCode(dayName: string | null): string | null {
  if (!dayName) return null;
  return DAY_MAP[dayName.trim().toLowerCase()] ?? null;
}

// Parse "2:05 PM" / "9:00 AM" (12-hour text) -> minutes since midnight, or null.
// programs.start_time/end_time are stored as 12h text, not a `time` value.
function parse12h(t: string | null): number | null {
  if (!t) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(t);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm = m[3].toLowerCase() === 'pm';
  if (h === 12) h = 0;
  if (pm) h += 12;
  return h * 60 + min;
}

// Parse "13:00" (24-hour HH:MM, from the availability form) -> minutes, or null.
function parseHHMM(t: string | null): number | null {
  if (!t) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Stable key identifying a curriculum: prefer the structured id, fall back to the
// (normalized) free-text name so older programs without a linked curriculum still
// group together. Returns null when neither is set.
function currKey(prog: any): string | null {
  if (prog.curriculum_id) return `id:${prog.curriculum_id}`;
  if (prog.curriculum && String(prog.curriculum).trim()) return `name:${String(prog.curriculum).trim().toLowerCase()}`;
  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    const organizationId: string | undefined = body.organization_id;
    const term: string | undefined = body.term;
    const dryRun: boolean = body.dry_run ?? false;

    if (!organizationId) return json({ error: 'organization_id required' }, 400);
    if (!term) return json({ error: 'term required' }, 400);

    // ----- Auth: caller must be owner/admin of this org -----
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);
    const { data: memberRow } = await admin
      .from('org_members')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    // ----- Programs (open only — drafts are excluded from auto-match) -----
    const { data: progRaw, error: progErr } = await admin
      .from('programs')
      .select('id, day_of_week, start_time, end_time, program_location_id, status, curriculum_id, curriculum')
      .eq('organization_id', organizationId)
      .eq('term', term)
      .eq('status', 'open');
    if (progErr) return json({ error: `Load programs: ${progErr.message}` }, 500);
    const programs = (progRaw ?? []).filter((p: any) => dayCode(p.day_of_week) !== null);

    // ----- Locations: name + area (the unit preferences are ranked by) -----
    const { data: locRaw } = await admin
      .from('program_locations')
      .select('id, name, area')
      .eq('organization_id', organizationId);
    const locName = new Map<string, string>();
    const locArea = new Map<string, string | null>();
    for (const l of locRaw ?? []) { locName.set(l.id, l.name); locArea.set(l.id, l.area ?? null); }

    // ----- Instructors -----
    const { data: instRaw, error: instErr } = await admin
      .from('instructors')
      .select('id, first_name, last_name')
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    if (instErr) return json({ error: `Load instructors: ${instErr.message}` }, 500);
    const instructors = instRaw ?? [];

    // ----- Availability (term-scoped) -----
    const { data: availRaw, error: availErr } = await admin
      .from('instructor_term_availability')
      .select('instructor_id, weekday_availability, max_days, needs_confirmation, preferred_categories')
      .eq('organization_id', organizationId)
      .eq('term', term);
    if (availErr) return json({ error: `Load availability: ${availErr.message}` }, 500);
    const availByInstr = new Map<string, any>();
    for (const a of availRaw ?? []) availByInstr.set(a.instructor_id, a);

    // ----- Curriculum categories (LEGO / coding / robotics) for the family guide -----
    const { data: currRaw } = await admin
      .from('curricula')
      .select('id, category')
      .eq('organization_id', organizationId);
    const currCategory = new Map<string, string>();
    for (const c of currRaw ?? []) { if (c.category) currCategory.set(c.id, String(c.category).toLowerCase()); }

    // ----- Area preferences -----
    const { data: areaPrefRaw, error: areaErr } = await admin
      .from('instructor_term_area_preferences')
      .select('instructor_id, area, preference')
      .eq('organization_id', organizationId)
      .eq('term', term);
    if (areaErr) return json({ error: `Load area prefs: ${areaErr.message}` }, 500);
    const areaPrefByInstr = new Map<string, Record<string, string>>();
    for (const r of areaPrefRaw ?? []) {
      if (!areaPrefByInstr.has(r.instructor_id)) areaPrefByInstr.set(r.instructor_id, {});
      areaPrefByInstr.get(r.instructor_id)![r.area] = r.preference;
    }

    // ----- Existing assignments (lock confirmed) -----
    const programIds = programs.map((p: any) => p.id);
    const { data: existingRaw, error: existErr } = programIds.length
      ? await admin
          .from('program_assignments')
          .select('id, program_id, instructor_id, status')
          .eq('organization_id', organizationId)
          .in('program_id', programIds)
      : { data: [], error: null };
    if (existErr) return json({ error: `Load existing assignments: ${existErr.message}` }, 500);
    const existing = existingRaw ?? [];
    const progById = new Map(programs.map((p: any) => [p.id, p]));

    // ----- Build the pool (instructors who submitted at least one weekday bucket) -----
    interface PoolInstr {
      id: string; name: string;
      days: Record<string, { from?: string; until?: string }>;
      maxDays: number | null;
      needsConfirmation: boolean;
      areaPrefs: Record<string, string>;
      preferredCategories: Set<string>;  // LEGO / coding / robotics families they enjoy
    }
    const missingSurveys: string[] = [];
    const pool: PoolInstr[] = [];
    for (const inst of instructors) {
      const av = availByInstr.get(inst.id);
      const name = `${inst.first_name} ${inst.last_name}`.trim();
      const wd = (av?.weekday_availability ?? {}) as Record<string, { from?: string; until?: string }>;
      const hasAny = av && Object.values(wd).some((w) => w && w.from);
      if (!hasAny) { missingSurveys.push(name); continue; }
      const cats = Array.isArray(av.preferred_categories) ? av.preferred_categories : [];
      pool.push({
        id: inst.id, name,
        days: wd,
        maxDays: av.max_days ?? null,
        needsConfirmation: !!av.needs_confirmation,
        areaPrefs: areaPrefByInstr.get(inst.id) ?? {},
        preferredCategories: new Set(cats.map((c: any) => String(c).toLowerCase())),
      });
    }

    // Running state seeded from confirmed rows so a re-run never double-books.
    // assignedCurricula tracks which curricula each instructor already holds (incl.
    // confirmed ones) so continuity carries across re-runs.
    const committedDays = new Map<string, Set<string>>();
    const loadCount = new Map<string, number>();
    const assignedCurricula = new Map<string, Set<string>>();
    const lockedProgram = new Map<string, { instructor_id: string }>();
    for (const e of existing) {
      if (e.status !== 'confirmed') continue;
      const p = progById.get(e.program_id);
      const dc = p ? dayCode(p.day_of_week) : null;
      lockedProgram.set(e.program_id, { instructor_id: e.instructor_id });
      if (dc) {
        if (!committedDays.has(e.instructor_id)) committedDays.set(e.instructor_id, new Set());
        committedDays.get(e.instructor_id)!.add(dc);
      }
      const ck = p ? currKey(p) : null;
      if (ck) {
        if (!assignedCurricula.has(e.instructor_id)) assignedCurricula.set(e.instructor_id, new Set());
        assignedCurricula.get(e.instructor_id)!.add(ck);
      }
      loadCount.set(e.instructor_id, (loadCount.get(e.instructor_id) ?? 0) + 1);
    }

    function areaFor(prog: any): string | null {
      return prog.program_location_id ? locArea.get(prog.program_location_id) ?? null : null;
    }
    function areaPrefFor(inst: PoolInstr, prog: any): string | null {
      const area = areaFor(prog);
      if (!area) return null;
      return inst.areaPrefs[area] ?? null;
    }
    // A program that can't be time-matched at all: missing/garbled start or end.
    function hasUsableTime(prog: any): boolean {
      return parse12h(prog.start_time) != null && parse12h(prog.end_time) != null;
    }

    // Everything except the area check: time/day fit, not double-booked, under cap.
    function eligibleCore(inst: PoolInstr, prog: any): boolean {
      const dc = dayCode(prog.day_of_week);
      if (!dc) return false;
      const avail = inst.days[dc];
      if (!avail || !avail.from) return false;
      const from = parseHHMM(avail.from);
      const until = avail.until ? parseHHMM(avail.until) : null;
      const start = parse12h(prog.start_time);
      const end = parse12h(prog.end_time);
      if (start == null || end == null || from == null) return false;
      if (start - ARRIVAL_BUFFER_MIN < from) return false;   // can't arrive in time
      if (until != null && end > until) return false;         // class runs past when they must leave
      if (committedDays.get(inst.id)?.has(dc)) return false;
      if (inst.maxDays != null && (loadCount.get(inst.id) ?? 0) >= inst.maxDays) return false;
      return true;
    }
    // Auto-match eligibility also excludes areas the instructor marked 'unavailable'.
    function eligible(inst: PoolInstr, prog: any): boolean {
      return eligibleCore(inst, prog) && areaPrefFor(inst, prog) !== 'unavailable';
    }

    function areaScore(inst: PoolInstr, prog: any): number {
      const pref = areaPrefFor(inst, prog);
      return (pref === 'preferred' || pref === 'highly_preferred') ? PREFERRED_AREA_SCORE : NEUTRAL_AREA_SCORE;
    }

    // Does this instructor already hold the program's curriculum (from a confirmed
    // row or earlier in this run)?
    function holdsCurriculum(inst: PoolInstr, prog: any): boolean {
      const ck = currKey(prog);
      return !!ck && (assignedCurricula.get(inst.id)?.has(ck) ?? false);
    }

    // How many OTHER still-open classes of the SAME curriculum could this instructor
    // also take, given current commitments? Used only to choose a versatile seed when
    // starting a brand-new curriculum chain (rough heuristic; same-weekday classes
    // they could never stack are excluded).
    function curriculumReach(inst: PoolInstr, prog: any): number {
      const ck = currKey(prog);
      if (!ck) return 0;
      const pdc = dayCode(prog.day_of_week);
      let n = 0;
      for (const q of openPrograms) {
        if (q.id === prog.id) continue;
        if (assignedProgramIds.has(q.id) || lockedProgram.has(q.id) || !hasUsableTime(q)) continue;
        if (currKey(q) !== ck) continue;
        if (dayCode(q.day_of_week) === pdc) continue;
        if (eligible(inst, q)) n++;
      }
      return n;
    }

    // Curriculum family (lego / coding / robotics) for this program, or null if unset.
    function categoryFor(prog: any): string | null {
      return prog.curriculum_id ? (currCategory.get(prog.curriculum_id) ?? null) : null;
    }
    // Soft guide: does the instructor enjoy this program's family? (Everyone CAN teach
    // everything — this only nudges toward what they picked on their survey.)
    function prefersCategory(inst: PoolInstr, prog: any): boolean {
      const cat = categoryFor(prog);
      return !!cat && inst.preferredCategories.has(cat);
    }

    const decisions: Array<any> = [];
    const assignedProgramIds = new Set<string>();

    // Is there an eligible instructor who ALREADY teaches this program's curriculum
    // (and didn't mark its area unavailable)? If so this class can EXTEND a chain.
    function someHolderEligible(prog: any): boolean {
      // eligible() already excludes 'unavailable' areas.
      return pool.some((inst) => eligible(inst, prog) && holdsCurriculum(inst, prog));
    }

    // Assign one program to its best candidate. Winner order:
    //   1. already teaches this curriculum (continuity) — unless area = unavailable
    //   2. can cover the most OTHER classes of this curriculum (start a long chain)
    //   3. enjoys this curriculum family (LEGO / coding / robotics) — soft guide
    //   4. area preference
    //   5. fewest distinct curricula so far (don't pile a new set onto someone)
    //   6. confirmed-before-tentative, then fewer classes, then name
    function assignWinner(prog: any) {
      const candidates = pool.filter((inst) => eligible(inst, prog));
      if (candidates.length === 0) return;
      const reachOf = new Map<string, number>();
      for (const c of candidates) reachOf.set(c.id, curriculumReach(c, prog));
      candidates.sort((a, b) => {
        // candidates are all eligible(), so 'unavailable' areas are already excluded.
        const aSticky = holdsCurriculum(a, prog);
        const bSticky = holdsCurriculum(b, prog);
        if (aSticky !== bSticky) return aSticky ? -1 : 1;
        const ra = reachOf.get(a.id)!, rb = reachOf.get(b.id)!;
        if (rb !== ra) return rb - ra;
        const aCat = prefersCategory(a, prog), bCat = prefersCategory(b, prog);
        if (aCat !== bCat) return aCat ? -1 : 1;
        const sa = areaScore(a, prog), sb = areaScore(b, prog);
        if (sb !== sa) return sb - sa;
        const ca = assignedCurricula.get(a.id)?.size ?? 0, cb = assignedCurricula.get(b.id)?.size ?? 0;
        if (ca !== cb) return ca - cb;
        if (a.needsConfirmation !== b.needsConfirmation) return a.needsConfirmation ? 1 : -1;
        const la = loadCount.get(a.id) ?? 0, lb = loadCount.get(b.id) ?? 0;
        if (la !== lb) return la - lb;
        return a.name.localeCompare(b.name);
      });
      const winner = candidates[0];
      const dc = dayCode(prog.day_of_week)!;
      if (!committedDays.has(winner.id)) committedDays.set(winner.id, new Set());
      committedDays.get(winner.id)!.add(dc);
      loadCount.set(winner.id, (loadCount.get(winner.id) ?? 0) + 1);
      const ck = currKey(prog);
      if (ck) {
        if (!assignedCurricula.has(winner.id)) assignedCurricula.set(winner.id, new Set());
        assignedCurricula.get(winner.id)!.add(ck);
      }
      assignedProgramIds.add(prog.id);

      decisions.push({
        program_id: prog.id,
        location_name: locName.get(prog.program_location_id) ?? null,
        area: areaFor(prog),
        curriculum_name: prog.curriculum ?? null,
        day_of_week: prog.day_of_week,
        status: 'assigned',
        instructor_id: winner.id,
        instructor_name: winner.name,
        area_preference: areaPrefFor(winner, prog),
        hardship_bonus_cents: 0,
        flags: [],
      });
    }

    const openPrograms = programs.filter((p: any) => !lockedProgram.has(p.id));

    // Greedy, curriculum-continuity first. Each round we prefer to EXTEND a curriculum
    // someone already teaches (so chains consolidate onto one instructor) before
    // SEEDING a brand-new one; within that set we take the most-constrained class
    // (fewest eligible instructors) so scarce instructors aren't wasted.
    while (true) {
      const remaining = openPrograms.filter((p: any) =>
        !assignedProgramIds.has(p.id) && !lockedProgram.has(p.id) && hasUsableTime(p) &&
        pool.some((inst) => eligible(inst, p)));
      if (remaining.length === 0) break;
      const chain = remaining.filter(someHolderEligible);
      const pickFrom = chain.length > 0 ? chain : remaining;
      let best = pickFrom[0], bestElig = Infinity;
      for (const p of pickFrom) {
        const n = pool.filter((inst) => eligible(inst, p)).length;
        if (n < bestElig) { bestElig = n; best = p; }
      }
      assignWinner(best);
    }

    // Unassigned -> needs_hire, or flagged as a data problem if the time is missing.
    for (const prog of openPrograms) {
      if (assignedProgramIds.has(prog.id)) continue;
      const base = {
        program_id: prog.id,
        location_name: locName.get(prog.program_location_id) ?? null,
        area: areaFor(prog),
        day_of_week: prog.day_of_week,
      };
      if (!hasUsableTime(prog)) {
        decisions.push({ ...base, status: 'needs_hire', reason: 'This class has no start/end time set — add its time before matching.' });
        continue;
      }
      // Anyone who could take this class but kept it off-limits by marking the area
      // 'unavailable'? Surface them so the admin can place by hand if they want.
      const blockedByArea = pool.filter((inst) => eligibleCore(inst, prog) && areaPrefFor(inst, prog) === 'unavailable');
      let reason: string;
      if (blockedByArea.length > 0) {
        const names = blockedByArea.map((i) => i.name).join(', ');
        reason = `${names} could take this class but marked this area as unavailable. Assign by hand if you'd like.`;
      } else {
        const dc = dayCode(prog.day_of_week);
        const s = parse12h(prog.start_time)!, e = parse12h(prog.end_time)!;
        const anyDayTime = pool.some((inst) => {
          const a = inst.days[dc ?? ''];
          if (!a || !a.from) return false;
          const from = parseHHMM(a.from), until = a.until ? parseHHMM(a.until) : null;
          return from != null && (s - ARRIVAL_BUFFER_MIN) >= from && (until == null || e <= until);
        });
        reason = anyDayTime
          ? 'Everyone who fits this day and time is already booked elsewhere.'
          : 'No instructor is available for this weekday and time window.';
      }
      decisions.push({ ...base, status: 'needs_hire', reason });
    }

    // ----- Writes -----
    let writeStats = { deleted: 0, inserted: 0, skipped_dry_run: false };
    const assignedDecisions = decisions.filter((d) => d.status === 'assigned');
    if (dryRun) {
      writeStats.skipped_dry_run = true;
    } else if (assignedDecisions.length > 0) {
      const writableIds = assignedDecisions.map((d) => d.program_id);
      const { count: deletedCount, error: delErr } = await admin
        .from('program_assignments')
        .delete({ count: 'exact' })
        .eq('organization_id', organizationId)
        .eq('status', 'proposed')
        .in('program_id', writableIds);
      if (delErr) return json({ error: `Delete prior proposed rows: ${delErr.message}` }, 500);
      writeStats.deleted = deletedCount ?? 0;

      const nowIso = new Date().toISOString();
      const toInsert = assignedDecisions.map((d) => ({
        organization_id: organizationId,
        program_id: d.program_id,
        instructor_id: d.instructor_id,
        role: 'lead',
        status: 'proposed',
        assigned_by: null,
        assigned_at: nowIso,
        distance_bonus_cents: d.hardship_bonus_cents,
        flags: d.flags,
      }));
      const { error: insErr } = await admin.from('program_assignments').insert(toInsert);
      if (insErr) return json({ error: `Insert proposed rows: ${insErr.message}` }, 500);
      writeStats.inserted = toInsert.length;
    }

    // Materials metric: distinct curricula (= class sets) per instructor across all
    // assignments, including locked/confirmed ones.
    const setsByInstr = new Map<string, Set<string>>();
    for (const d of assignedDecisions) {
      const ck = d.curriculum_name ? `name:${String(d.curriculum_name).trim().toLowerCase()}` : null;
      if (!ck) continue;
      if (!setsByInstr.has(d.instructor_id)) setsByInstr.set(d.instructor_id, new Set());
      setsByInstr.get(d.instructor_id)!.add(ck);
    }
    let totalSets = 0, maxSets = 0;
    for (const s of setsByInstr.values()) { totalSets += s.size; if (s.size > maxSets) maxSets = s.size; }

    return json({
      organization_id: organizationId,
      term,
      summary: {
        programs_total: programs.length,
        locked_confirmed: lockedProgram.size,
        assigned: assignedDecisions.length,
        needs_hire: decisions.filter((d) => d.status === 'needs_hire').length,
        instructors_in_pool: pool.length,
        missing_surveys: missingSurveys,
        curriculum_sets: { total: totalSets, max_per_instructor: maxSets, instructors_assigned: setsByInstr.size },
      },
      decisions,
      write_stats: writeStats,
    });
  } catch (err) {
    console.error('match-afterschool error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
