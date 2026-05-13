// Golden test cases for match-instructors (spec file 05).
//
// All inputs are mocked — these tests never hit Supabase. They exercise the pure
// functions in `../lib.ts` directly. Run with:
//   deno test supabase/functions/match-instructors/tests/golden_cases.test.ts --allow-none
//
// Coverage map → spec file 05 §"Golden test cases":
//   1. AM+PM combo wins; continuity_combo on both halves
//   2. Pass 1 full_day assignment picks highest soft score
//   3. Pass 2 prefers full_day_capable when scoring favors
//   4. Pass 3 — full_day_capable as last resort (fallback_assignment)
//   5. needs_confirmation deprioritization
//   6. Lacamas Lodge full surfacing (multi-week)
//   7. Double-booking with class_days
//   8. Curriculum mismatch flag
//   9. Single eligible instructor
//  10. No eligible instructor (needs_hire + alternates_considered)
//  11. Mid-term dismissal (locked + re-match)

import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';

import {
  bookingConflict,
  bookInstructor,
  buildOutputJSON,
  CampSession,
  checkHardConstraints,
  classifyInstructor,
  ConstraintContext,
  HARDSHIP_BONUS_AMOUNT,
  InstructorAvailability,
  InstructorQuotas,
  isDoubleBooked,
  MatchInstructor,
  PreferenceLevel,
  RolePreference,
  RunningCalendar,
  runMatching,
  SchedulingCycle,
  SessionType,
  SoftScoreContext,
  VENUE_REGION_MAP,
} from '../lib.ts';

// ========== Helpers ==========

function makeCycle(overrides: Partial<SchedulingCycle> = {}): SchedulingCycle {
  return {
    id: 'cycle-1',
    organization_id: 'org-1',
    cycle_type: 'SU26',
    starts_on: '2026-06-15',
    ends_on: '2026-08-14',
    weeks: [],
    status: 'scheduling',
    dev_instructor_threshold: 12,
    ...overrides,
  };
}

function makeCamp(opts: {
  id: string;
  location_name: string;
  week_num: number;
  session_type: SessionType;
  curriculum_category?: string;
  curriculum_name?: string;
  class_days?: string[];
  current_enrollment?: number;
}): CampSession {
  return {
    id: opts.id,
    organization_id: 'org-1',
    cycle_id: 'cycle-1',
    location_id: `loc-${opts.location_name}`,
    location_name: opts.location_name,
    week_num: opts.week_num,
    session_type: opts.session_type,
    curriculum_category: opts.curriculum_category ?? 'lego',
    curriculum_name: opts.curriculum_name ?? 'Default Curriculum',
    starts_on: '2026-06-15',
    ends_on: '2026-06-19',
    class_days: opts.class_days ?? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    current_enrollment: opts.current_enrollment ?? 0,
    status: 'active',
  };
}

function makeInstructor(opts: {
  id: string;
  first_name: string;
  session_types: SessionType[];
  available_weeks: number[];
  role_preference?: RolePreference;
  needs_confirmation?: boolean;
}): MatchInstructor {
  const availability: InstructorAvailability = {
    instructor_id: opts.id,
    cycle_id: 'cycle-1',
    session_types: opts.session_types,
    available_weeks: opts.available_weeks,
    unavailable_dates: null,
    role_preference: opts.role_preference ?? 'lead_or_developing',
    developing_min_enrollment: null,
    needs_confirmation: opts.needs_confirmation ?? false,
    notes: null,
  };
  return {
    id: opts.id,
    first_name: opts.first_name,
    last_name: '',
    availability,
    klass: classifyInstructor(opts.session_types),
  };
}

function makeContexts(opts: {
  cycle?: SchedulingCycle;
  locPrefs?: Array<{ instructor_id: string; region: string; preference: PreferenceLevel }>;
  currPrefs?: Array<{ instructor_id: string; curriculum_category: string; preference: PreferenceLevel }>;
}): { constraintCtx: ConstraintContext; scoreCtx: SoftScoreContext } {
  const cycle = opts.cycle ?? makeCycle();
  const locPrefByKey = new Map<string, PreferenceLevel>();
  for (const lp of opts.locPrefs ?? []) {
    locPrefByKey.set(`${lp.instructor_id}:${lp.region}`, lp.preference);
  }
  const currPrefByKey = new Map<string, PreferenceLevel>();
  for (const cp of opts.currPrefs ?? []) {
    currPrefByKey.set(`${cp.instructor_id}:${cp.curriculum_category}`, cp.preference);
  }
  return {
    constraintCtx: { cycle, locPrefByKey },
    scoreCtx: { locPrefByKey, currPrefByKey },
  };
}

// Helper: find a decision for a specific camp_session_id.
function decFor(decisions: ReturnType<typeof runMatching>['decisions'], campId: string) {
  const d = decisions.find((x) => x.camp.id === campId);
  if (!d) throw new Error(`No decision for camp ${campId}`);
  return d;
}

// ========== Test 1: AM+PM combo wins; continuity_combo on both halves ==========

Deno.test('1: AM+PM combo wins over isolated half-day picks (continuity_combo on both)', () => {
  const cycle = makeCycle();
  const am = makeCamp({
    id: 'corbett-w1-am',
    location_name: 'Corbett Elementary',
    week_num: 1,
    session_type: 'morning',
    curriculum_category: 'robotics',
    curriculum_name: 'Next Level Robotics: Carnival Games',
    class_days: ['monday', 'tuesday', 'wednesday', 'thursday'],
  });
  const pm = makeCamp({
    id: 'corbett-w1-pm',
    location_name: 'Corbett Elementary',
    week_num: 1,
    session_type: 'afternoon',
    curriculum_category: 'lego',
    curriculum_name: 'LEGO Superheroes',
    class_days: ['monday', 'tuesday', 'wednesday', 'thursday'],
  });

  // Rose is half_day_combo: can cover both halves.
  const rose = makeInstructor({
    id: 'rose',
    first_name: 'Rose',
    session_types: ['morning', 'afternoon'],
    available_weeks: [1],
  });

  // Pooneh is half_day_single (morning only) — can't cover combo but would
  // score higher on the morning half alone (highly_preferred location).
  const pooneh = makeInstructor({
    id: 'pooneh',
    first_name: 'Pooneh',
    session_types: ['morning'],
    available_weeks: [1],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'rose', region: 'Corbett', preference: 'preferred' },
      { instructor_id: 'pooneh', region: 'Corbett', preference: 'highly_preferred' },
    ],
  });

  const { decisions } = runMatching({
    camps: [am, pm],
    pool: [rose, pooneh],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  const amDec = decFor(decisions, 'corbett-w1-am');
  const pmDec = decFor(decisions, 'corbett-w1-pm');

  assertEquals(amDec.proposed_instructor_id, 'rose');
  assertEquals(pmDec.proposed_instructor_id, 'rose');
  assert(amDec.flags.includes('continuity_combo'), 'morning half should have continuity_combo');
  assert(pmDec.flags.includes('continuity_combo'), 'afternoon half should have continuity_combo');
});

// ========== Test 2: Pass 1 full_day assignment picks highest soft score ==========

Deno.test('2: Pass 1 full_day assignment picks highest-scored eligible instructor', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'catlin-w4-fd',
    location_name: 'Catlin Gabel Summer Camp',
    week_num: 4,
    session_type: 'full_day',
    curriculum_category: 'robotics',
  });

  const tiffany = makeInstructor({
    id: 'tiffany',
    first_name: 'Tiffany',
    session_types: ['morning', 'afternoon', 'full_day'],
    available_weeks: [4],
  });
  const skyler = makeInstructor({
    id: 'skyler',
    first_name: 'Skyler',
    session_types: ['full_day'],
    available_weeks: [4],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'tiffany', region: 'Portland', preference: 'highly_preferred' }, // +30
      { instructor_id: 'skyler', region: 'Portland', preference: 'preferred' }, // +20
    ],
    currPrefs: [
      { instructor_id: 'tiffany', curriculum_category: 'robotics', preference: 'highly_preferred' }, // +15
      { instructor_id: 'skyler', curriculum_category: 'robotics', preference: 'preferred' }, // +10
    ],
  });

  const { decisions } = runMatching({
    camps: [camp],
    pool: [tiffany, skyler],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  assertEquals(decFor(decisions, 'catlin-w4-fd').proposed_instructor_id, 'tiffany');
});

// ========== Test 3: Pass 2 — full_day_capable wins combo when scores favor ==========

Deno.test('3: Pass 2 full_day_capable wins combo when location score favors', () => {
  const cycle = makeCycle();
  const am = makeCamp({
    id: 'hv-w2-am',
    location_name: 'Happy Valley Annex',
    week_num: 2,
    session_type: 'morning',
  });
  const pm = makeCamp({
    id: 'hv-w2-pm',
    location_name: 'Happy Valley Annex',
    week_num: 2,
    session_type: 'afternoon',
  });

  const tiffany = makeInstructor({
    id: 'tiffany',
    first_name: 'Tiffany',
    session_types: ['morning', 'afternoon', 'full_day'],
    available_weeks: [2],
  });
  const rose = makeInstructor({
    id: 'rose',
    first_name: 'Rose',
    session_types: ['morning', 'afternoon'],
    available_weeks: [2],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'tiffany', region: 'Happy Valley', preference: 'highly_preferred' },
      { instructor_id: 'rose', region: 'Happy Valley', preference: 'not_preferred' },
    ],
  });

  const { decisions } = runMatching({
    camps: [am, pm],
    pool: [tiffany, rose],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  assertEquals(decFor(decisions, 'hv-w2-am').proposed_instructor_id, 'tiffany');
  assertEquals(decFor(decisions, 'hv-w2-pm').proposed_instructor_id, 'tiffany');
});

// ========== Test 4: Pass 3 — full_day_capable as last resort (fallback_assignment) ==========

Deno.test('4: Pass 3 Tier 3 fires only when Tier 1 + Tier 2 empty (fallback_assignment flag)', () => {
  const cycle = makeCycle();
  // Single isolated half-day camp. No combo at this location.
  const camp = makeCamp({
    id: 'lacamas-w6-pm',
    location_name: 'Lacamas Lodge',
    week_num: 6,
    session_type: 'afternoon',
    class_days: ['monday', 'wednesday'],
  });

  // Tier 1 (half_day_single) — Kristin's W6 NOT available
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'],
    available_weeks: [1, 2, 5],
  });
  // Tier 2 (half_day_combo) — Aiden's W6 NOT available
  const aiden = makeInstructor({
    id: 'aiden',
    first_name: 'Aiden',
    session_types: ['morning', 'afternoon'],
    available_weeks: [1, 2, 3, 4, 5, 7, 8, 9],
  });
  // Tier 3 (full_day_capable) — Tiffany's W6 IS available
  const tiffany = makeInstructor({
    id: 'tiffany',
    first_name: 'Tiffany',
    session_types: ['morning', 'afternoon', 'full_day'],
    available_weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'kristin', region: 'Camas', preference: 'highly_preferred' },
      { instructor_id: 'aiden', region: 'Camas', preference: 'preferred' },
      { instructor_id: 'tiffany', region: 'Camas', preference: 'not_preferred' },
    ],
  });

  const { decisions } = runMatching({
    camps: [camp],
    pool: [kristin, aiden, tiffany],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  const d = decFor(decisions, 'lacamas-w6-pm');
  assertEquals(d.proposed_instructor_id, 'tiffany');
  assert(d.flags.includes('fallback_assignment'), 'Tier 3 assignment must flag fallback_assignment');
});

// ========== Test 5: needs_confirmation deprioritization ==========

Deno.test('5: needs_confirmation=true sorts to end regardless of soft score', () => {
  const cycle = makeCycle();
  // Single morning camp (Pass 3 single).
  const camp = makeCamp({
    id: 'beav-w1-am',
    location_name: 'Bricks and Mini Figs Beaverton',
    week_num: 1,
    session_type: 'morning',
  });

  // Both half_day_combo (Tier 2 in Pass 3); both pass hard constraints.
  // Aiden has needs_confirmation=true and HIGHER location score.
  // Spec rule: Rose (needs_confirmation=false) wins regardless of score.
  const aiden = makeInstructor({
    id: 'aiden',
    first_name: 'Aiden',
    session_types: ['morning', 'afternoon'],
    available_weeks: [1],
    needs_confirmation: true,
  });
  const rose = makeInstructor({
    id: 'rose',
    first_name: 'Rose',
    session_types: ['morning', 'afternoon'],
    available_weeks: [1],
    needs_confirmation: false,
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'aiden', region: 'Beaverton', preference: 'highly_preferred' }, // +30
      { instructor_id: 'rose', region: 'Beaverton', preference: 'not_preferred' }, // +5
    ],
  });

  const { decisions } = runMatching({
    camps: [camp],
    pool: [aiden, rose],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  assertEquals(decFor(decisions, 'beav-w1-am').proposed_instructor_id, 'rose');
});

// ========== Test 6: Lacamas Lodge full surfacing across W4–W7 ==========

Deno.test('6: Lacamas Lodge W4–W7 afternoons surface tier-appropriate matches + needs_hire where empty', () => {
  const cycle = makeCycle();
  const lacamas = (week: number) =>
    makeCamp({
      id: `lacamas-w${week}-pm`,
      location_name: 'Lacamas Lodge',
      week_num: week,
      session_type: 'afternoon',
      class_days: ['monday', 'wednesday'],
    });
  const camps = [lacamas(4), lacamas(5), lacamas(6), lacamas(7)];

  // Tier 1 (half_day_single afternoon) — Kristin: W4 only
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'],
    available_weeks: [4],
  });
  // Tier 2 (half_day_combo) — Aiden: W5 only
  const aiden = makeInstructor({
    id: 'aiden',
    first_name: 'Aiden',
    session_types: ['morning', 'afternoon'],
    available_weeks: [5],
  });
  // Tier 3 (full_day_capable) — Tiffany: W6 only
  const tiffany = makeInstructor({
    id: 'tiffany',
    first_name: 'Tiffany',
    session_types: ['morning', 'afternoon', 'full_day'],
    available_weeks: [6],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'kristin', region: 'Camas', preference: 'highly_preferred' },
      { instructor_id: 'aiden', region: 'Camas', preference: 'preferred' },
      { instructor_id: 'tiffany', region: 'Camas', preference: 'preferred' },
    ],
  });

  const { decisions } = runMatching({
    camps,
    pool: [kristin, aiden, tiffany],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  // W4: Kristin (Tier 1)
  assertEquals(decFor(decisions, 'lacamas-w4-pm').proposed_instructor_id, 'kristin');
  // W5: Aiden (Tier 2)
  assertEquals(decFor(decisions, 'lacamas-w5-pm').proposed_instructor_id, 'aiden');
  // W6: Tiffany (Tier 3) with fallback_assignment
  const w6 = decFor(decisions, 'lacamas-w6-pm');
  assertEquals(w6.proposed_instructor_id, 'tiffany');
  assert(w6.flags.includes('fallback_assignment'));
  // W7: no one — needs_hire with no_eligible_instructor + alternates_considered
  const w7 = decFor(decisions, 'lacamas-w7-pm');
  assertEquals(w7.status, 'needs_hire');
  assertEquals(w7.proposed_instructor_id, null);
  assert(w7.flags.includes('no_eligible_instructor'));
  assert(Array.isArray(w7.alternates_considered));
  assert((w7.alternates_considered ?? []).length > 0, 'alternates_considered should be populated');
});

// ========== Test 7: Double-booking with class_days ==========

Deno.test('7a: isDoubleBooked — Mon+Wed afternoon does NOT block Tue/Thu/Fri afternoon same week', () => {
  const cal: RunningCalendar = new Map();
  bookInstructor(cal, 'aiden', 4, ['monday', 'wednesday'], 'afternoon', 'loc-a');
  // Tue/Thu/Fri afternoon — no day overlap → not blocked
  assertEquals(isDoubleBooked(cal, 'aiden', 4, ['tuesday', 'thursday', 'friday'], 'afternoon', 'loc-a'), false);
});

Deno.test('7b: isDoubleBooked — Mon+Wed afternoon BLOCKS a Monday full_day same week', () => {
  const cal: RunningCalendar = new Map();
  bookInstructor(cal, 'aiden', 4, ['monday', 'wednesday'], 'afternoon', 'loc-a');
  // Monday full_day at SAME location — day overlap + window conflict
  assertEquals(isDoubleBooked(cal, 'aiden', 4, ['monday', 'tuesday'], 'full_day', 'loc-a'), true);
});

Deno.test('7c: isDoubleBooked — Mon+Wed afternoon does NOT block Tue/Thu/Fri morning', () => {
  const cal: RunningCalendar = new Map();
  bookInstructor(cal, 'aiden', 4, ['monday', 'wednesday'], 'afternoon', 'loc-a');
  // Tue/Thu/Fri morning — no day overlap
  assertEquals(isDoubleBooked(cal, 'aiden', 4, ['tuesday', 'thursday', 'friday'], 'morning', 'loc-a'), false);
});

Deno.test('7d: isDoubleBooked — morning + afternoon SAME days, SAME location do NOT block (combo case)', () => {
  const cal: RunningCalendar = new Map();
  bookInstructor(cal, 'rose', 1, ['monday', 'tuesday', 'wednesday', 'thursday'], 'morning', 'loc-corbett');
  // Same days, afternoon, SAME location — combo, no conflict
  assertEquals(isDoubleBooked(cal, 'rose', 1, ['monday', 'tuesday', 'wednesday', 'thursday'], 'afternoon', 'loc-corbett'), false);
});

// v2.3: same-day one-location enforcement
Deno.test('7e: cross-location SAME-DAY is rejected (Loc A morning + Loc B afternoon)', () => {
  const cal: RunningCalendar = new Map();
  bookInstructor(cal, 'skyler', 7, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], 'morning', 'loc-overlook');
  // Same days, afternoon, DIFFERENT location — physically impossible (cross-town commute)
  assertEquals(
    bookingConflict(cal, 'skyler', 7, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], 'afternoon', 'loc-forestgrove'),
    'cross_location_conflict',
  );
});

Deno.test('7f: cross-location DIFFERENT-DAY is allowed (Loc A Mon + Loc B Tue)', () => {
  const cal: RunningCalendar = new Map();
  bookInstructor(cal, 'aiden', 4, ['monday', 'wednesday'], 'afternoon', 'loc-lacamas');
  // Tue/Thu/Fri at a different location — no day overlap → OK
  assertEquals(
    bookingConflict(cal, 'aiden', 4, ['tuesday', 'thursday', 'friday'], 'afternoon', 'loc-firstenburg'),
    null,
  );
});

// ========== Test 8: Curriculum mismatch flag ==========

Deno.test('8: Curriculum not_preferred adds curriculum_mismatch flag', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'fg-w2-pm',
    location_name: 'Forest Grove Parks and Rec',
    week_num: 2,
    session_type: 'afternoon',
    curriculum_category: 'coding',
  });
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'],
    available_weeks: [2],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'kristin', region: 'Forest Grove', preference: 'preferred' }],
    currPrefs: [{ instructor_id: 'kristin', curriculum_category: 'coding', preference: 'not_preferred' }],
  });

  const { decisions } = runMatching({
    camps: [camp],
    pool: [kristin],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  const d = decFor(decisions, 'fg-w2-pm');
  assertEquals(d.proposed_instructor_id, 'kristin');
  assert(d.flags.includes('curriculum_mismatch'), 'not_preferred curriculum must flag mismatch');
});

// ========== Test 9: Single eligible instructor ==========

Deno.test('9: Single eligible instructor gets assigned without ranking', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'wl-w3-am',
    location_name: 'West Linn Parks and Rec',
    week_num: 3,
    session_type: 'morning',
  });
  // Two instructors but only one passes (other is wrong session_type)
  const pooneh = makeInstructor({
    id: 'pooneh',
    first_name: 'Pooneh',
    session_types: ['morning'],
    available_weeks: [3],
  });
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'], // can't take morning
    available_weeks: [3],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'pooneh', region: 'West Linn', preference: 'preferred' }],
  });

  const { decisions } = runMatching({
    camps: [camp],
    pool: [pooneh, kristin],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  assertEquals(decFor(decisions, 'wl-w3-am').proposed_instructor_id, 'pooneh');
});

// ========== Test 10: No eligible instructor ==========

Deno.test('10: No eligible instructor → needs_hire + alternates_considered populated', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'lacamas-w99-pm',
    location_name: 'Lacamas Lodge',
    week_num: 99, // no instructor has W99 available
    session_type: 'afternoon',
    class_days: ['monday', 'wednesday'],
  });
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'],
    available_weeks: [1, 2, 5],
  });
  const tiffany = makeInstructor({
    id: 'tiffany',
    first_name: 'Tiffany',
    session_types: ['morning', 'afternoon', 'full_day'],
    available_weeks: [1, 2, 3],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'kristin', region: 'Camas', preference: 'highly_preferred' },
      { instructor_id: 'tiffany', region: 'Camas', preference: 'preferred' },
    ],
  });

  const { decisions } = runMatching({
    camps: [camp],
    pool: [kristin, tiffany],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });

  const d = decFor(decisions, 'lacamas-w99-pm');
  assertEquals(d.status, 'needs_hire');
  assertEquals(d.proposed_instructor_id, null);
  assert(d.flags.includes('no_eligible_instructor'));
  assert((d.alternates_considered ?? []).length >= 2);
  // Both should have been filtered for week_unavailable
  const reasons = (d.alternates_considered ?? []).map((a) => a.reason);
  assert(reasons.every((r) => r === 'week_unavailable'));
});

// ========== Test 11: Mid-term dismissal — locked + re-match ==========
//
// Note: the index.ts dismissal pre-step (flipping DB rows to 'withdrawn',
// excluding the dismissed instructor from the pool, building lockedAssignments
// from existing rows) is integration-layer logic. Here we test the lib-level
// behavior: given lockedAssignments + a pool missing the dismissed instructor,
// other camps stay locked and the dismissed camp gets re-matched.

Deno.test('11: Dismissal — locked camps stay locked, dismissed camp re-matched', () => {
  const cycle = makeCycle();
  // Two future-dated camps.
  const dismissedCamp = makeCamp({
    id: 'camp-dismissed',
    location_name: 'Bricks and Mini Figs Beaverton',
    week_num: 1,
    session_type: 'morning',
  });
  const lockedCamp = makeCamp({
    id: 'camp-locked',
    location_name: 'Hillsboro Tyson Rec Center',
    week_num: 1,
    session_type: 'morning',
  });

  // Pool AFTER excluding the dismissed instructor.
  const aiden = makeInstructor({
    id: 'aiden',
    first_name: 'Aiden',
    session_types: ['morning', 'afternoon'],
    available_weeks: [1],
  });
  const pooneh = makeInstructor({
    id: 'pooneh',
    first_name: 'Pooneh',
    session_types: ['morning'],
    available_weeks: [1],
  });

  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'aiden', region: 'Beaverton', preference: 'highly_preferred' },
      { instructor_id: 'pooneh', region: 'Hillsboro', preference: 'highly_preferred' },
    ],
  });

  // Pooneh already locked to the Hillsboro camp (existing 'proposed' or 'confirmed').
  const locked = new Map([
    ['camp-locked', { instructor_id: 'pooneh', role: 'lead' as const }],
  ]);

  const { decisions } = runMatching({
    camps: [dismissedCamp, lockedCamp],
    pool: [aiden, pooneh],
    constraintCtx,
    scoreCtx,
    lockedAssignments: locked,
  });

  const lockedDec = decFor(decisions, 'camp-locked');
  assertEquals(lockedDec.status, 'locked_confirmed');
  assertEquals(lockedDec.proposed_instructor_id, 'pooneh');

  // Pooneh is now booked for Hillsboro morning W1 → can't also take Beaverton morning W1.
  // Aiden is the only candidate left and should win.
  const reDec = decFor(decisions, 'camp-dismissed');
  assertEquals(reDec.status, 'assigned');
  assertEquals(reDec.proposed_instructor_id, 'aiden');
});

// ========== Bonus integrity check: VENUE_REGION_MAP covers all 15 SU26 venues ==========

Deno.test('Bonus: VENUE_REGION_MAP covers all known SU26 venues', () => {
  const expected = [
    'Bricks and Mini Figs Beaverton',
    'Camas Community Ed',
    'Camas Parks and Rec',
    'Catlin Gabel Summer Camp',
    'Community of Faith Church',
    'Corbett Elementary',
    'First Congregational UCC',
    'Firstenburg Community Center',
    'Forest Grove Parks and Rec',
    'Happy Valley Annex',
    'Hillsboro Tyson Rec Center',
    'Lacamas Lodge',
    "St. Paul's Episcopal Church",
    'The Historic Overlook House',
    'West Linn Parks and Rec',
  ];
  for (const venue of expected) {
    assert(venue in VENUE_REGION_MAP, `Missing venue mapping: ${venue}`);
  }
});

// ========== Bonus: output JSON shape ==========

Deno.test('Bonus: buildOutputJSON emits spec-shaped payload', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'fg-w2-pm',
    location_name: 'Forest Grove Parks and Rec',
    week_num: 2,
    session_type: 'afternoon',
  });
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'],
    available_weeks: [2],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'kristin', region: 'Forest Grove', preference: 'preferred' }],
  });
  const pool = [kristin];
  const { decisions, counts, fullDayCounts } = runMatching({
    camps: [camp],
    pool,
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const out = buildOutputJSON({
    cycle_id: 'cycle-1',
    cycle_name: 'SU26',
    decisions,
    missing_surveys: [],
    pool,
    counts,
    fullDayCounts,
  });
  assertEquals(out.cycle_id, 'cycle-1');
  assertEquals(out.cycle_name, 'SU26');
  assertEquals(out.summary.total_camps, 1);
  assertEquals(out.summary.assigned, 1);
  assertEquals(out.summary.needs_hire, 0);
  assertEquals(out.summary.low_load_alerts.length, 0);   // Kristin got the camp
  assertEquals(out.camps.length, 1);
  assertEquals(out.camps[0].proposed_instructor_name, 'Kristin');
  assertNotEquals(out.camps[0].flags, undefined);
});

// ========== v2 Test B: half-day instructor covers a full_day camp (synthetic) ==========

Deno.test('v2-B: full_day camp falls back to half_day_combo with synthetic_full_day_combo flag', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'full-day-fallback',
    location_name: 'Catlin Gabel Summer Camp',
    week_num: 4,
    session_type: 'full_day',
  });
  // Only a half_day_combo instructor in pool — no full_day-eligible candidate.
  const rose = makeInstructor({
    id: 'rose',
    first_name: 'Rose',
    session_types: ['morning', 'afternoon'],
    available_weeks: [4],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'rose', region: 'Portland', preference: 'preferred' }],
  });
  const { decisions } = runMatching({
    camps: [camp],
    pool: [rose],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const d = decFor(decisions, 'full-day-fallback');
  assertEquals(d.status, 'assigned');
  assertEquals(d.proposed_instructor_id, 'rose');
  assert(d.flags.includes('synthetic_full_day_combo'));
});

// ========== v2 Test B (T4): full_day_only takes half-day with session_type_override ==========

Deno.test('v2-B (T4): full_day_only fills half-day camp as last resort with session_type_override', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'half-day-needs-cover',
    location_name: 'Forest Grove Parks and Rec',
    week_num: 2,
    session_type: 'afternoon',
  });
  // Only a full_day_only instructor in pool — no half-day-eligible candidate.
  const skyler = makeInstructor({
    id: 'skyler',
    first_name: 'Skyler',
    session_types: ['full_day'],
    available_weeks: [2],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'skyler', region: 'Forest Grove', preference: 'highly_preferred' }],
  });
  const { decisions } = runMatching({
    camps: [camp],
    pool: [skyler],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const d = decFor(decisions, 'half-day-needs-cover');
  assertEquals(d.status, 'assigned');
  assertEquals(d.proposed_instructor_id, 'skyler');
  assert(d.flags.includes('session_type_override'));
  assert(d.flags.includes('fallback_assignment'));
});

// ========== v2 Test C: location_override + hardship_bonus_offered ==========

Deno.test('v2-C: unavailable location is soft override with location_override + $50 hardship bonus', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'camas-pm',
    location_name: 'Camas Parks and Rec',
    week_num: 8,
    session_type: 'morning',
  });
  // Pooneh marked Camas unavailable but she's the only eligible instructor.
  const pooneh = makeInstructor({
    id: 'pooneh',
    first_name: 'Pooneh',
    session_types: ['morning'],
    available_weeks: [8],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'pooneh', region: 'Camas', preference: 'unavailable' }],
  });
  const { decisions } = runMatching({
    camps: [camp],
    pool: [pooneh],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const d = decFor(decisions, 'camas-pm');
  assertEquals(d.status, 'assigned');
  assertEquals(d.proposed_instructor_id, 'pooneh');
  assert(d.flags.includes('location_override'));
  assertEquals(d.hardship_bonus_offered, HARDSHIP_BONUS_AMOUNT);
});

// ========== v2 Test C: location_low_pref flag for not_preferred ==========

Deno.test('v2-C: not_preferred location attaches location_low_pref flag', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'lp-test',
    location_name: 'Hillsboro Tyson Rec Center',
    week_num: 1,
    session_type: 'morning',
  });
  const ricky = makeInstructor({
    id: 'ricky',
    first_name: 'Ricky',
    session_types: ['morning'],
    available_weeks: [1],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'ricky', region: 'Hillsboro', preference: 'not_preferred' }],
  });
  const { decisions } = runMatching({
    camps: [camp],
    pool: [ricky],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const d = decFor(decisions, 'lp-test');
  assert(d.flags.includes('location_low_pref'));
});

// ========== v2 Test D: quota deficit bonus beats a higher-scoring non-quota instructor ==========

Deno.test('v2-D: under-quota instructor wins via +100 bonus even when scored lower', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'quota-test',
    location_name: 'Catlin Gabel Summer Camp',
    week_num: 4,
    session_type: 'full_day',
  });
  // Tiffany has higher score (HP location + HP curriculum).
  const tiffany = makeInstructor({
    id: 'tiffany',
    first_name: 'Tiffany',
    session_types: ['morning', 'afternoon', 'full_day'],
    available_weeks: [4],
  });
  // Skyler has lower score but is under quota → gets +100.
  const skyler = makeInstructor({
    id: 'skyler',
    first_name: 'Skyler',
    session_types: ['full_day'],
    available_weeks: [4],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'tiffany', region: 'Portland', preference: 'highly_preferred' }, // +30
      { instructor_id: 'skyler', region: 'Portland', preference: 'preferred' },        // +20
    ],
    currPrefs: [
      { instructor_id: 'tiffany', curriculum_category: 'lego', preference: 'highly_preferred' }, // +15
      { instructor_id: 'skyler', curriculum_category: 'lego', preference: 'preferred' },         // +10
    ],
  });

  const quotas: InstructorQuotas = new Map([
    ['skyler', { min_full_day: 1 }],
  ]);

  const { decisions } = runMatching({
    camps: [camp],
    pool: [tiffany, skyler],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
    quotas,
  });

  // Without quota: Tiffany (45) > Skyler (30). With +100 Skyler bonus: Skyler (130) wins.
  assertEquals(decFor(decisions, 'quota-test').proposed_instructor_id, 'skyler');
});

// ========== v2 Test D: low_load_alerts surfaces zero-camp instructors ==========

Deno.test('v2-D: low_load_alerts lists instructors with zero assignments', () => {
  const cycle = makeCycle();
  const camp = makeCamp({
    id: 'only-camp',
    location_name: 'Forest Grove Parks and Rec',
    week_num: 2,
    session_type: 'afternoon',
  });
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'],
    available_weeks: [2],
  });
  // Ricky is in the pool but only has W1; not eligible for W2.
  const ricky = makeInstructor({
    id: 'ricky',
    first_name: 'Ricky',
    session_types: ['afternoon'],
    available_weeks: [1],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'kristin', region: 'Forest Grove', preference: 'preferred' },
      { instructor_id: 'ricky', region: 'Forest Grove', preference: 'preferred' },
    ],
  });
  const pool = [kristin, ricky];
  const { decisions, counts, fullDayCounts } = runMatching({
    camps: [camp],
    pool,
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const out = buildOutputJSON({
    cycle_id: 'cycle-1',
    cycle_name: 'SU26',
    decisions,
    missing_surveys: [],
    pool,
    counts,
    fullDayCounts,
  });
  assertEquals(out.summary.low_load_alerts, ['Ricky']);
});

// ========== v2 Test E: developing_proposal for high-enrollment camp ==========

Deno.test('v2-E: enrollment >= dev_threshold gets a developing_proposal alongside the lead', () => {
  const cycle = makeCycle({ dev_instructor_threshold: 12 });
  const camp = makeCamp({
    id: 'high-enroll',
    location_name: 'Firstenburg Community Center',
    week_num: 4,
    session_type: 'morning',
    current_enrollment: 18,
  });
  const aiden = makeInstructor({
    id: 'aiden',
    first_name: 'Aiden',
    session_types: ['morning', 'afternoon'],
    available_weeks: [4],
  });
  const tiffany = makeInstructor({
    id: 'tiffany',
    first_name: 'Tiffany',
    session_types: ['morning', 'afternoon', 'full_day'],
    available_weeks: [4],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [
      { instructor_id: 'aiden', region: 'Vancouver, WA', preference: 'preferred' },
      { instructor_id: 'tiffany', region: 'Vancouver, WA', preference: 'preferred' },
    ],
  });
  const { decisions } = runMatching({
    camps: [camp],
    pool: [aiden, tiffany],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const d = decFor(decisions, 'high-enroll');
  assertEquals(d.status, 'assigned');
  // Lead and developing are different instructors.
  assert(d.developing_proposal !== undefined);
  assertNotEquals(d.proposed_instructor_id, d.developing_proposal!.instructor_id);
});

// ========== v2 Test E: developing skipped when enrollment below threshold ==========

Deno.test('v2-E: enrollment < dev_threshold does NOT trigger a developing_proposal', () => {
  const cycle = makeCycle({ dev_instructor_threshold: 12 });
  const camp = makeCamp({
    id: 'low-enroll',
    location_name: 'Forest Grove Parks and Rec',
    week_num: 2,
    session_type: 'afternoon',
    current_enrollment: 8,
  });
  const kristin = makeInstructor({
    id: 'kristin',
    first_name: 'Kristin',
    session_types: ['afternoon'],
    available_weeks: [2],
  });
  const { constraintCtx, scoreCtx } = makeContexts({
    cycle,
    locPrefs: [{ instructor_id: 'kristin', region: 'Forest Grove', preference: 'preferred' }],
  });
  const { decisions } = runMatching({
    camps: [camp],
    pool: [kristin],
    constraintCtx,
    scoreCtx,
    lockedAssignments: new Map(),
  });
  const d = decFor(decisions, 'low-enroll');
  assertEquals(d.developing_proposal, undefined);
});
