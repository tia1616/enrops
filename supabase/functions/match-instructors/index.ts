// match-instructors — Supabase edge function #8.
//
// WHAT IT DOES: takes a cycle_id, derives organization_id from scheduling_cycles,
// loads all instructor + camp data scoped to that tenant, classifies instructors,
// runs the three-pass matching algorithm, and (unless dry_run) writes proposed
// rows to camp_assignments.
//
// SPEC: Spec_Match_Instructors_01_Overview.md through 05_Output_and_Tests.md
// (Drive folder 1JBJLzbTb-EEc7fWinMoXqQbMkrwKt08C).
//
// AUTH: service-role. Agent is admin-triggered. Tenant scoping is enforced by
// deriving organization_id from scheduling_cycles and filtering every query.
// (Per feedback_enrops_principles.md: service role only for admin paths;
// document the reason.)
//
// STATUS as of Chunk A: scaffold + DB loaders + classification + constraint /
// scoring contexts wired up. Three passes / output JSON / write logic land in
// Chunk B. The endpoint currently returns a "stage: chunk_a_loaded" payload so
// the data layer can be smoke-tested against live SU26.

// @deno-types="https://esm.sh/v135/@supabase/supabase-js@2.39.0/dist/module/index.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  buildOutputJSON,
  CampSession,
  classifyInstructor,
  ConstraintContext,
  ExistingAssignment,
  Instructor,
  InstructorAvailability,
  InstructorCurriculumPref,
  InstructorLocationPref,
  InstructorQuota,
  InstructorQuotas,
  MatchInstructor,
  PreferenceLevel,
  runMatching,
  SchedulingCycle,
  SessionType,
  SoftScoreContext,
  VENUE_REGION_MAP,
} from './lib.ts';
import { logPlatformEvent, FEATURE, ACTION, OUTCOME } from '../_shared/logPlatformEvent.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

interface RequestBody {
  cycle_id: string;
  include_cancelled?: boolean;
  admin_teaching_this_cycle?: boolean;
  dry_run?: boolean;
  dismissed_instructor_id?: string;
  // v2 (Change D): per-instructor quotas. Keys are instructor UUIDs.
  // Example: { "uuid-of-lance": { min_camps: 5 }, "uuid-of-skyler": { min_full_day: 3 } }
  instructor_quotas?: Record<string, InstructorQuota>;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body: RequestBody = await req.json();
    const {
      cycle_id,
      include_cancelled = false,
      // admin_teaching_this_cycle: v1 informational only. The 3-question admin flow
      // (file 01) gates the survey UPSTREAM — by the time this agent runs, the
      // admin either has an instructors + instructor_availability row (and gets
      // pooled like anyone else) or doesn't. We echo it in the response for audit.
      admin_teaching_this_cycle = false,
      dry_run = false,
      dismissed_instructor_id,
      instructor_quotas,
    } = body;

    if (!cycle_id) return json({ error: 'cycle_id required' }, 400);

    // ----- Cycle + tenant -----
    const { data: cycleRow, error: cycleErr } = await admin
      .from('scheduling_cycles')
      .select('*')
      .eq('id', cycle_id)
      .single();
    if (cycleErr || !cycleRow) return json({ error: `Unknown cycle: ${cycle_id}` }, 400);
    const cycle = cycleRow as SchedulingCycle;
    const orgId = cycle.organization_id;

    // ----- Camp sessions -----
    let campQuery = admin
      .from('camp_sessions')
      .select('*')
      .eq('organization_id', orgId)
      .eq('cycle_id', cycle_id);
    if (!include_cancelled) campQuery = campQuery.eq('status', 'active');
    const { data: campsRaw, error: campsErr } = await campQuery;
    if (campsErr) return json({ error: `Load camp_sessions: ${campsErr.message}` }, 500);
    const camps = (campsRaw ?? []) as CampSession[];

    // Pre-flight: every camp's location_name must be in VENUE_REGION_MAP. Catching
    // this up front beats throwing mid-algorithm and produces a useful error for ops.
    const unmappedVenues = [...new Set(camps.map((c) => c.location_name))].filter(
      (v) => !(v in VENUE_REGION_MAP),
    );
    if (unmappedVenues.length > 0) {
      return json({
        error: 'Unmapped venues in camp_sessions',
        unmapped_venues: unmappedVenues,
        hint: 'Add these to VENUE_REGION_MAP in supabase/functions/match-instructors/lib.ts',
      }, 500);
    }

    // ----- Instructors -----
    const { data: instructorsRaw, error: instErr } = await admin
      .from('instructors')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_active', true);
    if (instErr) return json({ error: `Load instructors: ${instErr.message}` }, 500);
    const instructors = (instructorsRaw ?? []) as Instructor[];
    const instructorIds = instructors.map((i) => i.id);

    // ----- Availability (cycle-scoped) -----
    const { data: availRaw, error: availErr } = await admin
      .from('instructor_availability')
      .select('*')
      .eq('cycle_id', cycle_id)
      .in('instructor_id', instructorIds);
    if (availErr) return json({ error: `Load availability: ${availErr.message}` }, 500);
    const avail = (availRaw ?? []) as InstructorAvailability[];

    // ----- Location prefs (cycle-scoped) -----
    const { data: locPrefsRaw, error: locErr } = await admin
      .from('instructor_location_preferences')
      .select('*')
      .eq('cycle_id', cycle_id)
      .in('instructor_id', instructorIds);
    if (locErr) return json({ error: `Load location prefs: ${locErr.message}` }, 500);
    const locPrefs = (locPrefsRaw ?? []) as InstructorLocationPref[];

    // ----- Curriculum prefs (not cycle-scoped per spec) -----
    const { data: currPrefsRaw, error: currErr } = await admin
      .from('instructor_curriculum_preferences')
      .select('*')
      .in('instructor_id', instructorIds);
    if (currErr) return json({ error: `Load curriculum prefs: ${currErr.message}` }, 500);
    const currPrefs = (currPrefsRaw ?? []) as InstructorCurriculumPref[];

    // ----- Existing assignments (for confirmed-row locking + dismissal flow in Chunk B) -----
    const campIds = camps.map((c) => c.id);
    const { data: existingRaw, error: existErr } = campIds.length
      ? await admin
          .from('camp_assignments')
          .select('id, camp_session_id, instructor_id, status, role')
          .eq('organization_id', orgId)
          .in('camp_session_id', campIds)
      : { data: [], error: null };
    if (existErr) return json({ error: `Load existing assignments: ${existErr.message}` }, 500);
    const existing = (existingRaw ?? []) as ExistingAssignment[];

    // ----- Build instructor pool with classification -----
    const availByInstr = new Map<string, InstructorAvailability>();
    for (const a of avail) availByInstr.set(a.instructor_id, a);

    const missingSurveys: string[] = [];
    const instructorPool: MatchInstructor[] = [];
    for (const inst of instructors) {
      const av = availByInstr.get(inst.id);
      if (!av) {
        missingSurveys.push(`${inst.first_name} ${inst.last_name}`);
        continue;
      }
      // Skip instructors with no available_weeks (e.g., "not available this summer" responses).
      if (!av.available_weeks || av.available_weeks.length === 0) continue;
      let klass;
      try {
        klass = classifyInstructor(av.session_types as SessionType[]);
      } catch (e) {
        return json({ error: `Classify ${inst.first_name}: ${(e as Error).message}` }, 500);
      }
      instructorPool.push({
        id: inst.id,
        first_name: inst.first_name,
        last_name: inst.last_name,
        availability: av,
        klass,
      });
    }

    // ----- Lookup maps for constraint + soft-score contexts -----
    const locPrefByKey = new Map<string, PreferenceLevel>();
    for (const lp of locPrefs) {
      locPrefByKey.set(`${lp.instructor_id}:${lp.location_name}`, lp.preference);
    }
    const currPrefByKey = new Map<string, PreferenceLevel>();
    for (const cp of currPrefs) {
      currPrefByKey.set(`${cp.instructor_id}:${cp.curriculum_category}`, cp.preference);
    }

    const constraintCtx: ConstraintContext = { cycle, locPrefByKey };
    const scoreCtx: SoftScoreContext = { locPrefByKey, currPrefByKey };

    // ----- Determine locked assignments + handle dismissal flow -----
    // Spec rules (file 05):
    //   - Normal run: only `confirmed` rows are locked; `proposed` rows can be overwritten.
    //   - Dismissal run: dismissed instructor's future-dated rows flip to `withdrawn`;
    //     all OTHER current rows (proposed AND confirmed) are locked.
    const lockedAssignments = new Map<string, { instructor_id: string; role: 'lead' | 'developing' }>();
    let dismissalWithdrawnCount = 0;
    const nowIso = new Date().toISOString();
    const campById = new Map(camps.map((c) => [c.id, c]));

    if (dismissed_instructor_id) {
      // Find dismissed-instructor rows on future-dated camps
      const futureWithdrawals = existing.filter((e) => {
        if (e.instructor_id !== dismissed_instructor_id) return false;
        if (e.status === 'withdrawn' || e.status === 'declined') return false;
        const c = campById.get(e.camp_session_id);
        return c ? c.starts_on > nowIso : false;
      });

      // Lock everyone else's current assignments (proposed + confirmed)
      for (const a of existing) {
        if (a.instructor_id === dismissed_instructor_id) continue;
        if (a.status === 'withdrawn' || a.status === 'declined') continue;
        lockedAssignments.set(a.camp_session_id, { instructor_id: a.instructor_id, role: a.role });
      }

      if (!dry_run && futureWithdrawals.length > 0) {
        const { error: wErr } = await admin
          .from('camp_assignments')
          .update({ status: 'withdrawn' })
          .in('id', futureWithdrawals.map((r) => r.id));
        if (wErr) return json({ error: `Withdraw rows: ${wErr.message}` }, 500);
        dismissalWithdrawnCount = futureWithdrawals.length;
      } else {
        dismissalWithdrawnCount = futureWithdrawals.length;
      }
    } else {
      // Normal run: lock only confirmed rows
      for (const a of existing) {
        if (a.status === 'confirmed') {
          lockedAssignments.set(a.camp_session_id, { instructor_id: a.instructor_id, role: a.role });
        }
      }
    }

    // Drop the dismissed instructor from the matching pool entirely
    const matchingPool = dismissed_instructor_id
      ? instructorPool.filter((i) => i.id !== dismissed_instructor_id)
      : instructorPool;

    // ----- Build quotas map (v2 Change D) -----
    const quotas: InstructorQuotas = new Map();
    if (instructor_quotas) {
      for (const [id, q] of Object.entries(instructor_quotas)) {
        quotas.set(id, q);
      }
    }

    // ----- Run matching -----
    const { decisions, counts, fullDayCounts } = runMatching({
      camps,
      pool: matchingPool,
      constraintCtx,
      scoreCtx,
      lockedAssignments,
      quotas,
    });

    // ----- Build output JSON -----
    const output = buildOutputJSON({
      cycle_id,
      cycle_name: cycle.name ?? cycle.cycle_type,
      decisions,
      missing_surveys: missingSurveys,
      pool: matchingPool,
      counts,
      fullDayCounts,
      quotas,
      camps,
      scoreCtx,
    });

    // ----- Writes -----
    // For each `assigned` decision, delete any prior agent-owned 'proposed' row for
    // that camp_session and insert a fresh one. `locked_confirmed` and `needs_hire`
    // produce no writes. `confirmed` rows are never touched by the agent.
    let writeStats = { deleted: 0, inserted: 0, skipped_dry_run: false };
    const writableCampIds = decisions
      .filter((d) => d.status === 'assigned')
      .map((d) => d.camp.id);

    if (dry_run) {
      writeStats.skipped_dry_run = true;
    } else if (writableCampIds.length > 0) {
      const { count: deletedCount, error: delErr } = await admin
        .from('camp_assignments')
        .delete({ count: 'exact' })
        .eq('organization_id', orgId)
        .eq('status', 'proposed')
        .in('camp_session_id', writableCampIds);
      if (delErr) return json({ error: `Delete prior proposed rows: ${delErr.message}` }, 500);
      writeStats.deleted = deletedCount ?? 0;

      const toInsert: Array<{
        organization_id: string;
        camp_session_id: string;
        instructor_id: string;
        role: 'lead' | 'developing';
        status: 'proposed';
        assigned_by: null;
        assigned_at: string;
      }> = [];
      for (const d of decisions) {
        if (d.status !== 'assigned' || !d.proposed_instructor_id) continue;
        toInsert.push({
          organization_id: orgId,
          camp_session_id: d.camp.id,
          instructor_id: d.proposed_instructor_id,
          role: d.role,
          status: 'proposed',
          // assigned_by is uuid (nullable) — null = "agent-generated, no human attribution".
          assigned_by: null,
          assigned_at: nowIso,
        });
        // v2 (Change E): second row for the developing instructor when present.
        if (d.developing_proposal) {
          toInsert.push({
            organization_id: orgId,
            camp_session_id: d.camp.id,
            instructor_id: d.developing_proposal.instructor_id,
            role: 'developing',
            status: 'proposed',
            assigned_by: null,
            assigned_at: nowIso,
          });
        }
      }
      if (toInsert.length > 0) {
        const { error: insErr } = await admin.from('camp_assignments').insert(toInsert);
        if (insErr) return json({ error: `Insert proposed rows: ${insErr.message}` }, 500);
        writeStats.inserted = toInsert.length;
      }
    }

    if (!dry_run) {
      await logPlatformEvent(admin, {
        feature: FEATURE.SCHEDULING, action: ACTION.INSTRUCTORS_MATCHED, outcome: OUTCOME.SUCCESS,
        organizationId: orgId,
        metadata: { cycle_id, kind: 'camp' },
      });
    }
    return json({
      ...output,
      organization_id: orgId,
      input_echo: {
        include_cancelled,
        admin_teaching_this_cycle,
        dry_run,
        dismissed_instructor_id: dismissed_instructor_id ?? null,
      },
      dismissal: dismissed_instructor_id
        ? { withdrawn_count: dismissalWithdrawnCount }
        : null,
      write_stats: writeStats,
    });
  } catch (err) {
    console.error('match-instructors error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
