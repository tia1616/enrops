// run-match-instructors-dry.ts — local dry-run of the match-instructors agent.
//
// WHAT THIS DOES: queries live J2S SU26 data via Supabase service-role creds,
// runs the matching algorithm from supabase/functions/match-instructors/lib.ts,
// and pretty-prints the proposed plan. Writes nothing to camp_assignments.
//
// This bypasses `supabase functions serve` (which needs Docker) by importing the
// pure functions directly and running them in Deno. The HTTP edge function in
// index.ts wraps the same lib functions; the matching behavior is identical.
//
// USAGE (PowerShell):
//   $env:SUPABASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co'
//   $env:SUPABASE_SERVICE_ROLE_KEY = 'eyJ...'  # from Supabase Dashboard → Settings → API
//   deno run --allow-env --allow-net scripts/run-match-instructors-dry.ts
//
// OFFLINE MODE (no DB access needed; useful for review/replay):
//   deno run --allow-read scripts/run-match-instructors-dry.ts --input=path/to/data.json
//
// Optional env:
//   CYCLE_ID — defaults to SU26 cycle '6d523f2d-628e-4e12-abf4-0544af2df2bb'

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
  InstructorQuotas,
  MatchInstructor,
  PreferenceLevel,
  runMatching,
  SchedulingCycle,
  SessionType,
  SoftScoreContext,
  VENUE_REGION_MAP,
} from '../supabase/functions/match-instructors/lib.ts';

// v2 SU26 promised-quotas. Hardcoded for this dry-run because the only ones
// Jessica's committed to are Lance (≥ 5 total) and Skyler (≥ 3 full_day).
// In live edge-function use, the same data flows via the `instructor_quotas`
// request body field.
const SU26_QUOTAS: InstructorQuotas = new Map([
  ['c18fcbf3-5821-42dc-bad2-27904ff69951', { min_camps: 5 }],          // Lance
  ['1e5852e1-b6b5-451d-af45-21b67e083186', { min_full_day: 3 }],       // Skyler
]);

const CYCLE_ID = Deno.env.get('CYCLE_ID') ?? '6d523f2d-628e-4e12-abf4-0544af2df2bb';

// Parse --input=path flag for offline JSON mode.
const inputArg = Deno.args.find((a) => a.startsWith('--input='));
const inputPath = inputArg ? inputArg.slice('--input='.length) : null;

interface Snapshot {
  cycle: SchedulingCycle;
  camps: CampSession[];
  instructors: Instructor[];
  availability: InstructorAvailability[];
  location_prefs: InstructorLocationPref[];
  curriculum_prefs: InstructorCurriculumPref[];
  existing_assignments: ExistingAssignment[];
}

let cycle: SchedulingCycle;
let camps: CampSession[];
let instructors: Instructor[];
let avail: InstructorAvailability[];
let locPrefs: InstructorLocationPref[];
let currPrefs: InstructorCurriculumPref[];
let existing: ExistingAssignment[];

if (inputPath) {
  // Offline: load snapshot
  const raw = await Deno.readTextFile(inputPath);
  const snap = JSON.parse(raw) as Snapshot;
  cycle = snap.cycle;
  camps = snap.camps;
  instructors = snap.instructors;
  avail = snap.availability;
  locPrefs = snap.location_prefs;
  currPrefs = snap.curriculum_prefs;
  existing = snap.existing_assignments ?? [];
  console.log(`Loaded snapshot from ${inputPath}: ${camps.length} camps, ${instructors.length} instructors`);
} else {
  // Live: query Supabase with service-role
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
    console.error('Set them in PowerShell:');
    console.error("  $env:SUPABASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co'");
    console.error("  $env:SUPABASE_SERVICE_ROLE_KEY = 'eyJ...'");
    console.error('Or use offline snapshot mode: --input=path/to/data.json');
    Deno.exit(1);
  }
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.39.0');
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: cycleRow, error: cErr } = await admin
    .from('scheduling_cycles')
    .select('*')
    .eq('id', CYCLE_ID)
    .single();
  if (cErr || !cycleRow) {
    console.error(`Cycle ${CYCLE_ID} not found:`, cErr);
    Deno.exit(1);
  }
  cycle = cycleRow as SchedulingCycle;
  const orgId = cycle.organization_id;

  const { data: campsRaw } = await admin
    .from('camp_sessions')
    .select('*')
    .eq('organization_id', orgId)
    .eq('cycle_id', CYCLE_ID)
    .eq('status', 'active');
  camps = (campsRaw ?? []) as CampSession[];

  const { data: instructorsRaw } = await admin
    .from('instructors')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_active', true);
  instructors = (instructorsRaw ?? []) as Instructor[];
  const instructorIds = instructors.map((i) => i.id);

  const { data: availRaw } = await admin
    .from('instructor_availability')
    .select('*')
    .eq('cycle_id', CYCLE_ID)
    .in('instructor_id', instructorIds);
  avail = (availRaw ?? []) as InstructorAvailability[];

  const { data: locPrefsRaw } = await admin
    .from('instructor_location_preferences')
    .select('*')
    .eq('cycle_id', CYCLE_ID)
    .in('instructor_id', instructorIds);
  locPrefs = (locPrefsRaw ?? []) as InstructorLocationPref[];

  const { data: currPrefsRaw } = await admin
    .from('instructor_curriculum_preferences')
    .select('*')
    .in('instructor_id', instructorIds);
  currPrefs = (currPrefsRaw ?? []) as InstructorCurriculumPref[];

  const { data: existingRaw } = camps.length
    ? await admin
        .from('camp_assignments')
        .select('id, camp_session_id, instructor_id, status, role')
        .eq('organization_id', orgId)
        .in('camp_session_id', camps.map((c) => c.id))
    : { data: [] };
  existing = (existingRaw ?? []) as ExistingAssignment[];
}

const unmapped = [...new Set(camps.map((c) => c.location_name))].filter((v) => !(v in VENUE_REGION_MAP));
if (unmapped.length) {
  console.error('Unmapped venues in camp_sessions:', unmapped);
  console.error('Add them to VENUE_REGION_MAP in lib.ts and re-run.');
  Deno.exit(1);
}

// ----- Build pool + contexts -----

const availByInstr = new Map<string, InstructorAvailability>();
for (const a of avail) availByInstr.set(a.instructor_id, a);

const missingSurveys: string[] = [];
const pool: MatchInstructor[] = [];
for (const inst of instructors) {
  const av = availByInstr.get(inst.id);
  if (!av) {
    missingSurveys.push(`${inst.first_name} ${inst.last_name}`);
    continue;
  }
  if (!av.available_weeks || av.available_weeks.length === 0) continue;
  pool.push({
    id: inst.id,
    first_name: inst.first_name,
    last_name: inst.last_name,
    availability: av,
    klass: classifyInstructor(av.session_types as SessionType[]),
  });
}

const locPrefByKey = new Map<string, PreferenceLevel>();
for (const lp of locPrefs) locPrefByKey.set(`${lp.instructor_id}:${lp.location_name}`, lp.preference);
const currPrefByKey = new Map<string, PreferenceLevel>();
for (const cp of currPrefs) currPrefByKey.set(`${cp.instructor_id}:${cp.curriculum_category}`, cp.preference);

const constraintCtx: ConstraintContext = { cycle, locPrefByKey };
const scoreCtx: SoftScoreContext = { locPrefByKey, currPrefByKey };

const lockedAssignments = new Map<string, { instructor_id: string; role: 'lead' | 'developing' }>();
for (const a of existing) {
  if (a.status === 'confirmed') {
    lockedAssignments.set(a.camp_session_id, { instructor_id: a.instructor_id, role: a.role });
  }
}

// ----- Run -----

const { decisions, counts, fullDayCounts } = runMatching({
  camps, pool, constraintCtx, scoreCtx, lockedAssignments, quotas: SU26_QUOTAS,
});
const output = buildOutputJSON({
  cycle_id: CYCLE_ID,
  cycle_name: cycle.name ?? cycle.cycle_type,
  decisions,
  missing_surveys: missingSurveys,
  pool,
  counts,
  fullDayCounts,
  quotas: SU26_QUOTAS,
  camps,
  scoreCtx,
});

// ----- Pretty-print -----

const nameById = new Map(pool.map((p) => [p.id, p.first_name]));
const bar = (n = 70) => '─'.repeat(n);

console.log('\n' + bar());
console.log(`  match-instructors DRY RUN — ${cycle.name ?? cycle.cycle_type} (cycle ${CYCLE_ID.slice(0, 8)}…)`);
console.log(bar());

console.log('\nSUMMARY');
console.log(`  Total camps:        ${output.summary.total_camps}`);
console.log(`  Assigned (lead):    ${output.summary.assigned}`);
console.log(`  Developing slots:   ${output.summary.developing_assignments}`);
console.log(`  Flagged:            ${output.summary.flagged}`);
console.log(`  Needs hire:         ${output.summary.needs_hire}`);
console.log(`  Missing surveys:    ${output.summary.missing_surveys.length ? output.summary.missing_surveys.join(', ') : '(none)'}`);
console.log(`  Pool size:          ${pool.length} active instructors`);

// v2: admin notifications
if (output.summary.low_load_alerts.length) {
  console.log('\nADMIN NOTIFICATIONS — instructors with zero camps');
  console.log(bar());
  for (const name of output.summary.low_load_alerts) {
    console.log(`  - ${name}  (email them: no camps this cycle)`);
  }
}
if (output.summary.unmet_quotas.length) {
  console.log('\nUNMET PROMISED QUOTAS');
  console.log(bar());
  for (const u of output.summary.unmet_quotas) {
    const targetCamps = u.target_camps !== undefined ? `${u.got}/${u.target_camps} camps` : '';
    const fd = u.target_full_day !== undefined ? `${u.got_full_day ?? 0}/${u.target_full_day} full_day` : '';
    console.log(`  - ${u.name}: ${[targetCamps, fd].filter(Boolean).join(', ')}`);
  }
}

// v2.2 platform-AI suggestions
if (output.summary.recommendations.length) {
  console.log('\nPLATFORM RECOMMENDATIONS');
  console.log(bar());
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortedRecs = [...output.summary.recommendations].sort(
    (a, b) => (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99),
  );
  for (const r of sortedRecs) {
    const tag = r.priority === 'high' ? '[!]' : r.priority === 'medium' ? '[~]' : '[·]';
    console.log(`\n  ${tag} ${r.summary}`);
    console.log(`      ${r.detail}`);
  }
}

// --- By location-week ---
console.log('\nPROPOSED SCHEDULE (grouped by location, then week)');
console.log(bar());

const byLocation = new Map<string, typeof output.camps>();
for (const c of output.camps) {
  if (!byLocation.has(c.location_name)) byLocation.set(c.location_name, []);
  byLocation.get(c.location_name)!.push(c);
}
const sortedLocations = [...byLocation.keys()].sort();
for (const loc of sortedLocations) {
  const rows = byLocation.get(loc)!.sort((a, b) => {
    if (a.week_num !== b.week_num) return a.week_num - b.week_num;
    return a.session_type.localeCompare(b.session_type);
  });
  console.log(`\n  ${loc}  (region: ${VENUE_REGION_MAP[loc]})`);
  for (const r of rows) {
    const wk = `W${r.week_num}`.padEnd(3);
    const st = r.session_type.padEnd(9);
    const days = r.class_days.map((d) => d.slice(0, 3)).join(',').padEnd(15);
    const instr = r.proposed_instructor_name ?? '(NEEDS HIRE)';
    const flagParts: string[] = [];
    if (r.flags.length) flagParts.push(r.flags.join(', '));
    if (r.hardship_bonus_offered !== undefined) flagParts.push(`+$${r.hardship_bonus_offered} bonus`);
    const flagStr = flagParts.length ? ` [${flagParts.join(' | ')}]` : '';
    console.log(`    ${wk} ${st} ${days} → ${instr.padEnd(12)} ${r.curriculum_name}${flagStr}`);
    if (r.developing_proposal) {
      const dp = r.developing_proposal;
      const dpFlags = dp.flags.length ? ` [${dp.flags.join(', ')}]` : '';
      const dpBonus = dp.hardship_bonus_offered !== undefined ? ` +$${dp.hardship_bonus_offered} bonus` : '';
      console.log(`                                   + developing → ${dp.instructor_name}${dpFlags}${dpBonus}`);
    } else if (r.developing_needs_hire) {
      console.log(`                                   + developing → (NEEDS HIRE — high enrollment)`);
    }
  }
}

// --- Continuity combos ---
const combos = output.camps.filter((c) => c.flags.includes('continuity_combo'));
console.log('\nCONTINUITY COMBOS (one instructor across morning + afternoon at one site)');
console.log(bar());
const comboGroups = new Map<string, typeof output.camps>();
for (const c of combos) {
  const key = `${c.location_name}|W${c.week_num}|${c.proposed_instructor_name}`;
  if (!comboGroups.has(key)) comboGroups.set(key, []);
  comboGroups.get(key)!.push(c);
}
if (comboGroups.size === 0) {
  console.log('  (none)');
} else {
  for (const [, group] of comboGroups) {
    const first = group[0];
    console.log(`  ${first.location_name} W${first.week_num} → ${first.proposed_instructor_name} (covers ${group.map((g) => g.session_type).join(' + ')})`);
  }
}

// --- Needs hire ---
const needsHire = output.camps.filter((c) => c.status === 'needs_hire');
console.log('\nNEEDS HIRE — gaps with alternates considered');
console.log(bar());
if (needsHire.length === 0) {
  console.log('  (none — every camp got a proposal)');
} else {
  for (const c of needsHire) {
    console.log(`\n  ${c.location_name} W${c.week_num} ${c.session_type} — ${c.curriculum_name}`);
    console.log(`    class_days: ${c.class_days.join(', ')}`);
    if (c.alternates_considered && c.alternates_considered.length) {
      console.log('    alternates_considered:');
      for (const a of c.alternates_considered) {
        console.log(`      - ${a.name.padEnd(12)} (${a.reason})`);
      }
    }
  }
}

// --- Per-instructor load ---
const loadByInstr = new Map<string, number>();
for (const p of pool) loadByInstr.set(p.id, 0);
for (const d of output.camps) {
  if (d.proposed_instructor_id) {
    loadByInstr.set(d.proposed_instructor_id, (loadByInstr.get(d.proposed_instructor_id) ?? 0) + 1);
  }
}
const loadRows = [...loadByInstr.entries()]
  .map(([id, count]) => ({ name: nameById.get(id) ?? id, count, klass: pool.find((p) => p.id === id)?.klass ?? '?' }))
  .sort((a, b) => b.count - a.count);

console.log('\nPER-INSTRUCTOR LOAD');
console.log(bar());
for (const r of loadRows) {
  const bar2 = '█'.repeat(r.count);
  console.log(`  ${r.name.padEnd(12)} ${String(r.count).padStart(2)} camps  ${bar2.padEnd(12)}  (${r.klass})`);
}

// Always write JSON alongside pretty-print so downstream tooling (and SQL writers)
// can consume the same algorithm output.
const jsonOutPath = inputPath
  ? inputPath.replace(/\.json$/, '-output.json')
  : '.tmp/su26-output.json';
try {
  await Deno.writeTextFile(jsonOutPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote algorithm output JSON: ${jsonOutPath}`);
} catch (e) {
  console.log(`\n(Skipped JSON write — needs --allow-write: ${(e as Error).message})`);
}

console.log('\n' + bar());
console.log('  Dry run complete. No rows written to camp_assignments.');
console.log(bar() + '\n');
