// match-afterschool (v2) — instructor matching for recurring after-school programs.
//
// Aligned with the real provider availability survey:
//   HARD  instructor available the program's weekday, and their selected time
//         buckets cover [class_start - ARRIVAL_BUFFER, class_end] (arrive 15 min
//         early, stay to the end)
//   HARD  one program per weekday (can't be at two schools after dismissal)
//   HARD  respect the days/week cap (max_days)
//   HARD  only `open` programs are auto-matched (drafts excluded)
//   SOFT  AREA preference (program_locations.area): highly_preferred > preferred >
//         neutral > not_preferred > unavailable. not_preferred / unavailable are
//         still assignable as a LAST RESORT and earn a hardship bonus ($30 / $50).
//
// Curriculum is intentionally NOT a factor in v1 (programs.curriculum has no
// category to match on without hardcoding).
//
// Assignment is TWO-PHASE so a stated preference is never silently lost:
//   Phase 1 seats instructors at areas they highly-prefer / prefer first.
//   Phase 2 fills everything still open from remaining capacity.
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

// AREA preference -> base score.
const AREA_SCORE: Record<string, number> = {
  highly_preferred: 30,
  preferred: 20,
  not_preferred: 5,
  unavailable: -50,
};
const NEUTRAL_AREA_SCORE = 10; // no preference expressed for this area

const HARDSHIP_NOT_PREFERRED_CENTS = 3000; // $30
const HARDSHIP_UNAVAILABLE_CENTS = 5000;   // $50

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
      .select('id, day_of_week, start_time, end_time, program_location_id, status')
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
      .select('instructor_id, weekday_availability, max_days, needs_confirmation')
      .eq('organization_id', organizationId)
      .eq('term', term);
    if (availErr) return json({ error: `Load availability: ${availErr.message}` }, 500);
    const availByInstr = new Map<string, any>();
    for (const a of availRaw ?? []) availByInstr.set(a.instructor_id, a);

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
    }
    const missingSurveys: string[] = [];
    const pool: PoolInstr[] = [];
    for (const inst of instructors) {
      const av = availByInstr.get(inst.id);
      const name = `${inst.first_name} ${inst.last_name}`.trim();
      const wd = (av?.weekday_availability ?? {}) as Record<string, { from?: string; until?: string }>;
      const hasAny = av && Object.values(wd).some((w) => w && w.from);
      if (!hasAny) { missingSurveys.push(name); continue; }
      pool.push({
        id: inst.id, name,
        days: wd,
        maxDays: av.max_days ?? null,
        needsConfirmation: !!av.needs_confirmation,
        areaPrefs: areaPrefByInstr.get(inst.id) ?? {},
      });
    }

    // Running state seeded from confirmed rows so a re-run never double-books.
    const committedDays = new Map<string, Set<string>>();
    const loadCount = new Map<string, number>();
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

    function eligible(inst: PoolInstr, prog: any): boolean {
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

    function score(inst: PoolInstr, prog: any): number {
      const pref = areaPrefFor(inst, prog);
      if (pref == null) return NEUTRAL_AREA_SCORE;
      return AREA_SCORE[pref] ?? NEUTRAL_AREA_SCORE;
    }

    const decisions: Array<any> = [];
    const assignedProgramIds = new Set<string>();

    // Greedy pass over a program set, restricting candidates with `candidateFilter`.
    // Most-constrained-first (fewest candidates) so scarce instructors aren't wasted.
    function runPass(progs: any[], candidateFilter: (inst: PoolInstr, prog: any) => boolean) {
      const remaining = progs.filter((p) => !assignedProgramIds.has(p.id) && !lockedProgram.has(p.id) && hasUsableTime(p));
      while (remaining.length > 0) {
        let bestIdx = 0, bestElig = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const n = pool.filter((inst) => eligible(inst, remaining[i]) && candidateFilter(inst, remaining[i])).length;
          if (n < bestElig) { bestElig = n; bestIdx = i; }
        }
        const prog = remaining.splice(bestIdx, 1)[0];
        const candidates = pool.filter((inst) => eligible(inst, prog) && candidateFilter(inst, prog));
        if (candidates.length === 0) continue;

        candidates.sort((a, b) => {
          const sa = score(a, prog), sb = score(b, prog);
          if (sb !== sa) return sb - sa;
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
        assignedProgramIds.add(prog.id);

        const pref = areaPrefFor(winner, prog);
        const flags: string[] = [];
        let bonus = 0;
        if (pref === 'not_preferred') { flags.push('location_low_pref'); bonus = HARDSHIP_NOT_PREFERRED_CENTS; }
        else if (pref === 'unavailable') { flags.push('location_override'); bonus = HARDSHIP_UNAVAILABLE_CENTS; }
        decisions.push({
          program_id: prog.id,
          location_name: locName.get(prog.program_location_id) ?? null,
          area: areaFor(prog),
          day_of_week: prog.day_of_week,
          status: 'assigned',
          instructor_id: winner.id,
          instructor_name: winner.name,
          area_preference: pref,
          hardship_bonus_cents: bonus,
          flags,
        });
      }
    }

    const openPrograms = programs.filter((p: any) => !lockedProgram.has(p.id));

    // Phase 1: seat instructors at areas they highly-prefer / prefer.
    runPass(openPrograms, (inst, prog) => {
      const pref = areaPrefFor(inst, prog);
      return pref === 'highly_preferred' || pref === 'preferred';
    });
    // Phase 2: fill everything still open from remaining capacity.
    runPass(openPrograms, () => true);

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
      const dc = dayCode(prog.day_of_week);
      const s = parse12h(prog.start_time)!, e = parse12h(prog.end_time)!;
      const anyDayTime = pool.some((inst) => {
        const a = inst.days[dc ?? ''];
        if (!a || !a.from) return false;
        const from = parseHHMM(a.from), until = a.until ? parseHHMM(a.until) : null;
        return from != null && (s - ARRIVAL_BUFFER_MIN) >= from && (until == null || e <= until);
      });
      decisions.push({
        ...base,
        status: 'needs_hire',
        reason: anyDayTime
          ? 'Everyone who fits this day and time is already booked elsewhere.'
          : 'No instructor is available for this weekday and time window.',
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
        distance_bonus_cents: d.hardship_bonus_cents,
        flags: d.flags,
      }));
      const { error: insErr } = await admin.from('program_assignments').insert(toInsert);
      if (insErr) return json({ error: `Insert proposed rows: ${insErr.message}` }, 500);
      writeStats.inserted = toInsert.length;
    }

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
      },
      decisions,
      write_stats: writeStats,
    });
  } catch (err) {
    console.error('match-afterschool error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
