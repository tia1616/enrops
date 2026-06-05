// match-afterschool — instructor matching for recurring after-school programs.
//
// After-school is structurally simpler than camps: each program is one class an
// hour, the same weekday every week for a whole term. So the rules drop almost
// everything camp-specific:
//   - NO weeks (programs recur weekly all term)
//   - NO am/pm/full_day session types
//   - NO curriculum/skill scoring (covered when the provider hires)
//   - NO enrollment tiers (instructors are assigned before enrollment matters)
//   - BGC / Stripe are NOT gates
//
// What remains:
//   HARD  available_days must include the program's weekday
//   HARD  one instructor can hold at most ONE program per weekday (you can't be
//         at two schools after dismissal on the same afternoon = double-booking)
//   HARD  respect max_days (seniority/target load) as a cap
//   SOFT  location preference (highly_preferred > preferred > neutral > not_preferred;
//         unavailable is heavily penalized but still allowed if nothing else fits)
//   SOFT  load balancing toward each instructor's target
//   FLAG  assigning someone to a not-preferred/unavailable school earns a $50
//         hardship bonus (mirrors camps' location_override)
//
// AUTH: caller must be owner/admin of organization_id (verified via their JWT).
// Heavy lifting then runs with the service role. organization_id + term scope
// every query, so one org can never read or write another's data.
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

// Location preference -> base score. Mirrors the camp matcher's intent.
const LOC_SCORE: Record<string, number> = {
  highly_preferred: 30,
  preferred: 20,
  not_preferred: 5,
  unavailable: -50,
};
const NEUTRAL_LOC_SCORE = 10; // instructor expressed no preference for this school
const HARDSHIP_BONUS_CENTS = 5000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function dayCode(dayName: string | null): string | null {
  if (!dayName) return null;
  return DAY_MAP[dayName.trim().toLowerCase()] ?? null;
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

    // ----- Programs for this org + term -----
    const { data: progRaw, error: progErr } = await admin
      .from('programs')
      .select('id, day_of_week, start_time, end_time, program_location_id, status')
      .eq('organization_id', organizationId)
      .eq('term', term)
      .not('status', 'in', '("cancelled","archived")');
    if (progErr) return json({ error: `Load programs: ${progErr.message}` }, 500);
    const programs = (progRaw ?? []).filter((p: any) => dayCode(p.day_of_week) !== null);

    // ----- Locations (for names in output) -----
    const { data: locRaw } = await admin
      .from('program_locations')
      .select('id, name')
      .eq('organization_id', organizationId);
    const locName = new Map<string, string>();
    for (const l of locRaw ?? []) locName.set(l.id, l.name);

    // ----- Instructors -----
    const { data: instRaw, error: instErr } = await admin
      .from('instructors')
      .select('id, first_name, last_name')
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    if (instErr) return json({ error: `Load instructors: ${instErr.message}` }, 500);
    const instructors = instRaw ?? [];

    // ----- Availability for this term -----
    const { data: availRaw, error: availErr } = await admin
      .from('instructor_term_availability')
      .select('instructor_id, available_days, max_days, location_preferences')
      .eq('organization_id', organizationId)
      .eq('term', term);
    if (availErr) return json({ error: `Load availability: ${availErr.message}` }, 500);
    const availByInstr = new Map<string, any>();
    for (const a of availRaw ?? []) availByInstr.set(a.instructor_id, a);

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

    // Pool: only instructors who submitted availability with at least one weekday.
    const missingSurveys: string[] = [];
    const pool: Array<{
      id: string; name: string; days: Set<string>; maxDays: number | null;
      locPrefs: Record<string, string>;
    }> = [];
    for (const inst of instructors) {
      const av = availByInstr.get(inst.id);
      const name = `${inst.first_name} ${inst.last_name}`.trim();
      if (!av || !Array.isArray(av.available_days) || av.available_days.length === 0) {
        missingSurveys.push(name);
        continue;
      }
      pool.push({
        id: inst.id,
        name,
        days: new Set(av.available_days),
        maxDays: av.max_days ?? null,
        locPrefs: av.location_preferences ?? {},
      });
    }

    // Track each instructor's committed weekdays + total load. Seed from confirmed
    // rows so a re-run never double-books or overshoots a target.
    const committedDays = new Map<string, Set<string>>(); // instructor_id -> set of dayCodes
    const loadCount = new Map<string, number>();           // instructor_id -> count
    const lockedProgram = new Map<string, { instructor_id: string }>(); // program_id -> locked
    for (const e of existing) {
      if (e.status !== 'confirmed') continue;
      const p = progById.get(e.program_id);
      const dc = p ? dayCode(p.day_of_week) : null;
      lockedProgram.set(e.program_id, { instructor_id: e.instructor_id });
      if (dc) {
        if (!committedDays.has(e.instructor_id)) committedDays.set(e.instructor_id, new Set());
        committedDays.get(e.instructor_id)!.add(dc);
      }
      loadCount.set(e.instructor_id, (loadCount.get(e.instructor_id) ?? 0) + 1);
    }

    function eligible(inst: typeof pool[number], prog: any): boolean {
      const dc = dayCode(prog.day_of_week);
      if (!dc || !inst.days.has(dc)) return false;
      // One program per weekday (can't be at two schools that afternoon).
      if (committedDays.get(inst.id)?.has(dc)) return false;
      // Respect target load.
      if (inst.maxDays != null && (loadCount.get(inst.id) ?? 0) >= inst.maxDays) return false;
      return true;
    }

    function locScore(inst: typeof pool[number], prog: any): number {
      const pref = prog.program_location_id ? inst.locPrefs[prog.program_location_id] : undefined;
      if (pref == null) return NEUTRAL_LOC_SCORE;
      return LOC_SCORE[pref] ?? NEUTRAL_LOC_SCORE;
    }

    // Most-constrained-first: programs with the fewest eligible instructors get
    // matched before the easy ones, so scarce instructors aren't used up early.
    const openPrograms = programs.filter((p: any) => !lockedProgram.has(p.id));
    const decisions: Array<any> = [];

    // Recompute eligibility counts as we go (greedy). Simple + good enough at the
    // scale of an after-school term (tens of programs, tens of instructors).
    const remaining = [...openPrograms];
    while (remaining.length > 0) {
      // pick the most-constrained remaining program
      let bestIdx = 0;
      let bestElig = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const n = pool.filter((inst) => eligible(inst, remaining[i])).length;
        if (n < bestElig) { bestElig = n; bestIdx = i; }
      }
      const prog = remaining.splice(bestIdx, 1)[0];

      const candidates = pool.filter((inst) => eligible(inst, prog));
      if (candidates.length === 0) {
        decisions.push({
          program_id: prog.id,
          location_name: locName.get(prog.program_location_id) ?? null,
          day_of_week: prog.day_of_week,
          status: 'needs_hire',
        });
        continue;
      }
      candidates.sort((a, b) => {
        const sa = locScore(a, prog), sb = locScore(b, prog);
        if (sb !== sa) return sb - sa;                          // higher pref first
        const la = loadCount.get(a.id) ?? 0, lb = loadCount.get(b.id) ?? 0;
        if (la !== lb) return la - lb;                          // lighter load first
        return a.name.localeCompare(b.name);                   // stable
      });
      const winner = candidates[0];
      const dc = dayCode(prog.day_of_week)!;
      if (!committedDays.has(winner.id)) committedDays.set(winner.id, new Set());
      committedDays.get(winner.id)!.add(dc);
      loadCount.set(winner.id, (loadCount.get(winner.id) ?? 0) + 1);

      const pref = prog.program_location_id ? winner.locPrefs[prog.program_location_id] : undefined;
      const hardship = pref === 'not_preferred' || pref === 'unavailable';
      decisions.push({
        program_id: prog.id,
        location_name: locName.get(prog.program_location_id) ?? null,
        day_of_week: prog.day_of_week,
        status: 'assigned',
        instructor_id: winner.id,
        instructor_name: winner.name,
        score: locScore(winner, prog),
        hardship_bonus: hardship,
      });
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
        distance_bonus_cents: d.hardship_bonus ? HARDSHIP_BONUS_CENTS : 0,
        flags: d.hardship_bonus ? ['location_override'] : [],
      }));
      const { error: insErr } = await admin.from('program_assignments').insert(toInsert);
      if (insErr) return json({ error: `Insert proposed rows: ${insErr.message}` }, 500);
      writeStats.inserted = toInsert.length;
    }

    const assignedCount = assignedDecisions.length;
    const needsHireCount = decisions.filter((d) => d.status === 'needs_hire').length;

    return json({
      organization_id: organizationId,
      term,
      summary: {
        programs_total: programs.length,
        locked_confirmed: lockedProgram.size,
        assigned: assignedCount,
        needs_hire: needsHireCount,
        instructors_in_pool: pool.length,
        missing_surveys: missingSurveys,
      },
      decisions,
      write_stats: writeStats,
    });
  } catch (err) {
    console.error('match-afterschool error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
