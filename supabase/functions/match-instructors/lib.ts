// match-instructors lib — pure functions extracted for unit testing.
//
// index.ts handles HTTP + DB I/O. This file contains:
//   - DB row types
//   - Instructor classification (file 02)
//   - Hard-constraints predicate, 5 rules incl. class_days-aware double-booking (file 04)
//   - Soft scoring: Location > Curriculum; combo = location-only (file 04)
//   - Sort/tiebreak: needs_confirmation → score → load-balance → alphabetical
//   - Running-calendar helpers (per-instructor day-of-week booking tracker)
//   - Location-week grouping
//
// Chunk B will add: three passes, output JSON builder, write logic.

// ========== Types ==========

export type SessionType = 'morning' | 'afternoon' | 'full_day';
export type PreferenceLevel = 'highly_preferred' | 'preferred' | 'not_preferred' | 'unavailable';

// camp_sessions.location_name uses venue names ("Bricks and Mini Figs Beaverton");
// instructor_location_preferences.location_name uses regions ("Beaverton").
// We always look up preferences by REGION — see commit context for Path A decision
// after smoke test 2026-05-12 showed the Lacamas Lodge backfill set every instructor
// to "preferred" instead of mirroring their Camas pref, breaking 5 of 11 instructors'
// unavailable signal. Region map is the source of truth.
export const VENUE_REGION_MAP: Record<string, string> = {
  'Bricks and Mini Figs Beaverton': 'Beaverton',
  'Camas Community Ed': 'Camas',
  'Camas Parks and Rec': 'Camas',
  'Catlin Gabel Summer Camp': 'Portland',
  'Community of Faith Church': 'West Linn',
  'Corbett Elementary': 'Corbett',
  'First Congregational UCC': 'Hillsboro',
  'Firstenburg Community Center': 'Vancouver, WA',
  'Forest Grove Parks and Rec': 'Forest Grove',
  'Happy Valley Annex': 'Happy Valley',
  'Hillsboro Tyson Rec Center': 'Hillsboro',
  'Lacamas Lodge': 'Camas',
  "St. Paul's Episcopal Church": 'Oregon City',
  'The Historic Overlook House': 'Portland',
  'West Linn Parks and Rec': 'West Linn',
};

// Throws on unmapped venue — better to fail loudly than silently default everyone
// to "preferred". index.ts runs a pre-flight check across all camp location_names
// before matching to surface unmapped venues as a clear error.
// The venue->region map is the org's config (organizations.venue_region_map),
// passed through the score context. The runtime (index.ts) ALWAYS passes the org's
// own map and fails closed when it's empty — it never falls back to the J2S constant.
// The VENUE_REGION_MAP default here exists ONLY so the unit tests can call regionFor
// without threading a map; it is never reached in production (codex review #4).
export function regionFor(locationName: string, map?: Record<string, string>): string {
  const region = (map ?? VENUE_REGION_MAP)[locationName];
  if (!region) throw new Error(`Unmapped venue: "${locationName}". Add it to the org's venue_region_map.`);
  return region;
}
export type RolePreference = 'lead_only' | 'developing_only' | 'lead_or_developing';
export type InstructorClass = 'full_day_only' | 'full_day_capable' | 'half_day_combo' | 'half_day_single';
export type AssignmentStatus = 'proposed' | 'confirmed' | 'declined' | 'withdrawn';

export type ReasonCode =
  | 'wrong_session_type'
  | 'week_unavailable'
  | 'location_unavailable'  // v1 reason — kept for backward compat; v2 demoted location to soft, so no longer rejects
  | 'double_booked'
  | 'cross_location_conflict'  // v2.3: instructor already at a different location that same weekday
  | 'role_tier_mismatch'
  | 'reserved_full_day_specialist'
  | 'deprioritized_needs_confirmation';

// v2: per-instructor minimum-camp quotas. Boosts the instructor's score by +100
// until their quota is met. Score-bonus stacks beat location (+30) and curriculum
// (+15) so quota'd instructors win contested camps.
export interface InstructorQuota {
  min_camps?: number;       // total camp_assignments across all passes
  min_full_day?: number;    // explicit full_day camp count (subset of total)
}
export type InstructorQuotas = Map<string, InstructorQuota>;

export interface CampSession {
  id: string;
  organization_id: string;
  cycle_id: string;
  location_id: string;
  location_name: string;
  week_num: number;
  session_type: SessionType;
  curriculum_category: string;
  curriculum_name: string;
  starts_on: string;
  ends_on: string;
  class_days: string[];
  current_enrollment: number;
  status: 'active' | 'cancelled';
}

export interface Instructor {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
}

export interface InstructorAvailability {
  instructor_id: string;
  cycle_id: string;
  session_types: SessionType[];
  available_weeks: number[];
  unavailable_dates: string[] | null;
  role_preference: RolePreference;
  developing_min_enrollment: number | null;
  needs_confirmation: boolean;
  notes: string | null;
}

export interface InstructorLocationPref {
  cycle_id: string;
  instructor_id: string;
  location_name: string;
  preference: PreferenceLevel;
}

export interface InstructorCurriculumPref {
  instructor_id: string;
  curriculum_category: string;
  preference: PreferenceLevel;
}

export interface SchedulingCycle {
  id: string;
  organization_id: string;
  name?: string;          // human-readable label, e.g. "SU26"
  cycle_type: string;     // machine label, e.g. "summer_camp"
  starts_on: string;
  ends_on: string;
  weeks: unknown;
  status: string;
  dev_instructor_threshold: number;
}

export interface ExistingAssignment {
  id: string;
  camp_session_id: string;
  instructor_id: string;
  status: AssignmentStatus;
  role: 'lead' | 'developing';
}

// Enriched instructor record carried through matching
export interface MatchInstructor {
  id: string;
  first_name: string;
  last_name: string;
  availability: InstructorAvailability;
  klass: InstructorClass;
}

// Running calendar entry: which location_id the instructor is committed to on a
// given (week, weekday), and the set of session_types already taken there.
// v2.3: enforces same-day-one-location rule — an instructor's morning and
// afternoon on the same weekday must be at the same physical location (combo
// case is fine; cross-location commute is not).
export interface CalendarEntry {
  session_types: Set<SessionType>;
  location_id: string;
}
// Running calendar: per-instructor map of (week_num + weekday) -> entry.
export type RunningCalendar = Map<string, Map<string, CalendarEntry>>;

// ========== Classification ==========

export function classifyInstructor(sessionTypes: SessionType[]): InstructorClass {
  const hasFullDay = sessionTypes.includes('full_day');
  const hasMorning = sessionTypes.includes('morning');
  const hasAfternoon = sessionTypes.includes('afternoon');
  if (hasFullDay && !hasMorning && !hasAfternoon) return 'full_day_only';
  if (hasFullDay) return 'full_day_capable';
  if (hasMorning && hasAfternoon) return 'half_day_combo';
  if (hasMorning || hasAfternoon) return 'half_day_single';
  throw new Error(`Cannot classify session_types: ${JSON.stringify(sessionTypes)}`);
}

// ========== Running calendar ==========

function calKey(weekNum: number, weekday: string): string {
  return `${weekNum}:${weekday}`;
}

export function bookInstructor(
  calendar: RunningCalendar,
  instructorId: string,
  weekNum: number,
  classDays: string[],
  sessionType: SessionType,
  locationId: string,
): void {
  let perInstr = calendar.get(instructorId);
  if (!perInstr) {
    perInstr = new Map();
    calendar.set(instructorId, perInstr);
  }
  for (const weekday of classDays) {
    const key = calKey(weekNum, weekday);
    let entry = perInstr.get(key);
    if (!entry) {
      entry = { session_types: new Set(), location_id: locationId };
      perInstr.set(key, entry);
    }
    entry.session_types.add(sessionType);
  }
}

// v2.3: returns the specific conflict reason, or null if the booking is OK.
// `cross_location_conflict` fires when the instructor is already committed to
// a different location_id on any of the candidate weekdays (same-day cross-town
// commute is treated as a physical impossibility — see PR discussion).
export function bookingConflict(
  calendar: RunningCalendar,
  instructorId: string,
  weekNum: number,
  classDays: string[],
  sessionType: SessionType,
  locationId: string,
): null | 'double_booked' | 'cross_location_conflict' {
  const perInstr = calendar.get(instructorId);
  if (!perInstr) return null;
  for (const weekday of classDays) {
    const entry = perInstr.get(calKey(weekNum, weekday));
    if (!entry) continue;
    if (entry.location_id !== locationId) return 'cross_location_conflict';
    if (windowConflict(entry.session_types, sessionType)) return 'double_booked';
  }
  return null;
}

// Convenience boolean wrapper (used by tests + any code that just needs to know
// "blocked or not"). When called with locationId='_any', the cross-location check
// is skipped (treat as same-location for the purpose of window-conflict tests).
export function isDoubleBooked(
  calendar: RunningCalendar,
  instructorId: string,
  weekNum: number,
  classDays: string[],
  sessionType: SessionType,
  locationId: string = '_any',
): boolean {
  if (locationId === '_any') {
    // Backward-compat path: only check window conflict, ignore location_id mismatch.
    const perInstr = calendar.get(instructorId);
    if (!perInstr) return false;
    for (const weekday of classDays) {
      const entry = perInstr.get(calKey(weekNum, weekday));
      if (!entry) continue;
      if (windowConflict(entry.session_types, sessionType)) return true;
    }
    return false;
  }
  return bookingConflict(calendar, instructorId, weekNum, classDays, sessionType, locationId) !== null;
}

// Window conflict rules (file 04):
//   full_day vs anything -> conflict
//   morning vs morning   -> conflict
//   afternoon vs afternoon -> conflict
//   morning vs afternoon -> NO conflict (the Pass 2 combo case)
function windowConflict(existing: Set<SessionType>, incoming: SessionType): boolean {
  if (incoming === 'full_day') return existing.size > 0;
  return existing.has('full_day') || existing.has(incoming);
}

// ========== Hard constraints ==========

export interface ConstraintContext {
  cycle: SchedulingCycle;
  locPrefByKey: Map<string, PreferenceLevel>; // key: `${instructorId}:${locationName}`
}

export type ConstraintResult = { eligible: true } | { eligible: false; reason: ReasonCode };

export function checkHardConstraints(
  camp: CampSession,
  instructor: MatchInstructor,
  ctx: ConstraintContext,
  calendar: RunningCalendar,
  opts: {
    // v2: when true, skip the session_type match check. Used by Pass 1 half-day
    // fallback (half_day_combo doing a full_day camp) and Pass 3 Tier 4
    // (full_day_only doing a half-day camp). Double-booking still applies but
    // the new camp's window is treated as `full_day` if the instructor's a
    // half_day_combo doing a full_day camp (synthetic), or the actual half-day
    // window otherwise.
    skipSessionType?: boolean;
  } = {},
): ConstraintResult {
  const av = instructor.availability;

  if (!opts.skipSessionType && !av.session_types.includes(camp.session_type)) {
    return { eligible: false, reason: 'wrong_session_type' };
  }
  if (!av.available_weeks.includes(camp.week_num)) {
    return { eligible: false, reason: 'week_unavailable' };
  }
  // v2 (Change C): location 'unavailable' is no longer a hard reject. It's
  // demoted to a heavy soft penalty in LOC_SCORE (-50) and emits a
  // `location_override` flag plus `hardship_bonus_offered: 50` on the assignment.
  // The Offer Flow email surfaces the bonus.
  if (av.role_preference === 'developing_only') {
    if (camp.current_enrollment < ctx.cycle.dev_instructor_threshold) {
      return { eligible: false, reason: 'role_tier_mismatch' };
    }
  }
  // For double-booking check: use the camp's actual session_type. The assign()
  // function decides booking width separately (synthetic combos block full day;
  // session_type overrides block only the half-day). v2.3 also enforces the
  // same-day-one-location rule via bookingConflict — an instructor at Location A
  // on Mon cannot also be at Location B on Mon, regardless of session_type.
  const conflict = bookingConflict(
    calendar,
    instructor.id,
    camp.week_num,
    camp.class_days,
    camp.session_type,
    camp.location_id,
  );
  if (conflict) {
    return { eligible: false, reason: conflict };
  }
  return { eligible: true };
}

// ========== Soft scoring ==========

export interface SoftScoreContext {
  locPrefByKey: Map<string, PreferenceLevel>;
  currPrefByKey: Map<string, PreferenceLevel>;
  regionMap?: Record<string, string>; // org's venue->region map; falls back to the constant
}

export interface ScoreResult {
  score: number;
  flags: OutputFlag[];
}

const LOC_SCORE: Record<PreferenceLevel, number> = {
  highly_preferred: 30,
  preferred: 20,
  not_preferred: 5,
  unavailable: -50, // v2: soft penalty + location_override flag + $50 hardship bonus
};

const CURR_SCORE: Record<PreferenceLevel, number> = {
  highly_preferred: 15,
  preferred: 10,
  not_preferred: 2,
  unavailable: -9999, // curriculum can't be 'unavailable' in practice; defensive
};

// v2 (Change C): hardship-bonus amount surfaced to the Offer Flow.
export const HARDSHIP_BONUS_AMOUNT = 50;

export function scoreCamp(
  camp: CampSession,
  instructorId: string,
  ctx: SoftScoreContext,
  opts: { skipCurriculum?: boolean } = {},
): ScoreResult {
  const locPref = ctx.locPrefByKey.get(`${instructorId}:${regionFor(camp.location_name, ctx.regionMap)}`) ?? 'preferred';
  let score = LOC_SCORE[locPref];
  const flags: OutputFlag[] = [];
  if (locPref === 'unavailable') flags.push('location_override');
  else if (locPref === 'not_preferred') flags.push('location_low_pref');
  if (!opts.skipCurriculum) {
    const currPref = ctx.currPrefByKey.get(`${instructorId}:${camp.curriculum_category}`) ?? 'preferred';
    score += CURR_SCORE[currPref];
    if (currPref === 'not_preferred') flags.push('curriculum_mismatch');
  }
  return { score, flags };
}

// v2 (Change D): quota-deficit bonus. Returns +100 if instructor is below either
// their min_camps or min_full_day quota. Score-bonus dominates location/curriculum
// so under-quota instructors win contested camps.
export function quotaBonus(
  instructorId: string,
  camp: CampSession,
  quotas: InstructorQuotas,
  counts: AssignmentCounts,
  fullDayCounts: AssignmentCounts,
): number {
  const q = quotas.get(instructorId);
  if (!q) return 0;
  const total = counts.get(instructorId) ?? 0;
  if (q.min_camps && total < q.min_camps) return 100;
  if (q.min_full_day && camp.session_type === 'full_day') {
    const fd = fullDayCounts.get(instructorId) ?? 0;
    if (fd < q.min_full_day) return 100;
  }
  return 0;
}

// Pass 2 combo: location is identical for both halves; score by location only (file 03).
export function scoreComboLocation(
  locationName: string,
  instructorId: string,
  ctx: SoftScoreContext,
): number {
  const locPref = ctx.locPrefByKey.get(`${instructorId}:${regionFor(locationName, ctx.regionMap)}`) ?? 'preferred';
  return LOC_SCORE[locPref];
}

// ========== Sort / tiebreak ==========

export interface ScoredCandidate {
  instructor: MatchInstructor;
  score: number;
  flags: OutputFlag[];
  assignmentCount: number;
}

export function sortCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return [...candidates].sort((a, b) => {
    const aConfirm = a.instructor.availability.needs_confirmation;
    const bConfirm = b.instructor.availability.needs_confirmation;
    if (aConfirm !== bConfirm) return aConfirm ? 1 : -1;
    if (a.score !== b.score) return b.score - a.score;
    if (a.assignmentCount !== b.assignmentCount) return a.assignmentCount - b.assignmentCount;
    return a.instructor.first_name.localeCompare(b.instructor.first_name);
  });
}

// ========== Camp ordering within a pass ==========

export function sortCampsForPass(camps: CampSession[]): CampSession[] {
  return [...camps].sort((a, b) => {
    if (a.week_num !== b.week_num) return a.week_num - b.week_num;
    if (a.location_name !== b.location_name) return a.location_name.localeCompare(b.location_name);
    return a.session_type.localeCompare(b.session_type);
  });
}

// ========== Location-week grouping ==========

export interface LocationWeek {
  location_id: string;
  location_name: string;
  week_num: number;
  morning?: CampSession;
  afternoon?: CampSession;
  full_day?: CampSession;
}

export function groupIntoLocationWeeks(camps: CampSession[]): LocationWeek[] {
  const map = new Map<string, LocationWeek>();
  for (const camp of camps) {
    const key = `${camp.location_id}:${camp.week_num}`;
    let lw = map.get(key);
    if (!lw) {
      lw = {
        location_id: camp.location_id,
        location_name: camp.location_name,
        week_num: camp.week_num,
      };
      map.set(key, lw);
    }
    if (camp.session_type === 'morning') lw.morning = camp;
    else if (camp.session_type === 'afternoon') lw.afternoon = camp;
    else if (camp.session_type === 'full_day') lw.full_day = camp;
  }
  return [...map.values()];
}

export function isCombo(lw: LocationWeek): boolean {
  return !!lw.morning && !!lw.afternoon;
}

// ========== Matching: shared helpers ==========

// Output flag enum. v2 added 4 new flags for soft-override scenarios.
export type OutputFlag =
  | 'continuity_combo'
  | 'curriculum_mismatch'
  | 'no_eligible_instructor'
  | 'fallback_assignment'
  | 'synthetic_full_day_combo'  // v2: half_day_combo covering a full_day camp
  | 'session_type_override'      // v2: full_day_only doing half-day OR half-day-combo doing full-day
  | 'location_override'          // v2: instructor assigned to location they marked unavailable
  | 'location_low_pref';         // v2: instructor assigned to a not_preferred location

// v2: developing-instructor proposal nested under a lead decision.
export interface DevelopingProposal {
  instructor_id: string;
  instructor_name: string;
  flags: OutputFlag[];
  hardship_bonus_offered?: number;
}

// Per-camp decision the algorithm emits. Consumed by both the JSON builder
// and the DB writer.
export interface CampDecision {
  camp: CampSession;
  proposed_instructor_id: string | null;   // null when needs_hire (lead slot empty)
  proposed_instructor_name: string | null;
  role: 'lead' | 'developing';
  flags: OutputFlag[];
  status: 'assigned' | 'needs_hire' | 'locked_confirmed';
  alternates_considered?: { name: string; reason: ReasonCode }[];
  hardship_bonus_offered?: number;        // v2: present when location_override fires for lead
  developing_proposal?: DevelopingProposal; // v2: when enrollment >= dev_threshold AND a dev was found
  developing_needs_hire?: boolean;        // v2: true when dev slot was needed but no eligible instructor
  developing_alternates_considered?: { name: string; reason: ReasonCode }[]; // v2: who failed dev pool
}

// Decide what role to write. lead is the default; developing_only with sufficient
// enrollment writes 'developing'. (file 04 hard constraint 4 already filtered out
// developing_only with insufficient enrollment.)
export function decideRole(av: InstructorAvailability): 'lead' | 'developing' {
  return av.role_preference === 'developing_only' ? 'developing' : 'lead';
}

// Top-5 alternates_considered builder (file 05). Sorts most-eligible-first using
// a "how close did they get" heuristic: passing more hard constraints wins.
// In practice this means a reason like double_booked / location_unavailable
// (the instructor was otherwise viable) ranks before wrong_session_type / week_unavailable
// (structurally not a candidate). We cap at 5 — UX target is <10s per gap scan.
const REASON_PROXIMITY: Record<ReasonCode, number> = {
  reserved_full_day_specialist: 0,  // closest miss — would have worked, held back by tier
  deprioritized_needs_confirmation: 1,
  double_booked: 2,
  cross_location_conflict: 2,        // v2.3: physically can't be at two sites same day
  location_unavailable: 3,
  role_tier_mismatch: 4,
  wrong_session_type: 5,
  week_unavailable: 6,
};

export function rankAlternates(
  raw: { name: string; reason: ReasonCode }[],
): { name: string; reason: ReasonCode }[] {
  return [...raw]
    .sort((a, b) => {
      const pa = REASON_PROXIMITY[a.reason] ?? 99;
      const pb = REASON_PROXIMITY[b.reason] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 5);
}

// Per-instructor assignment counter for load-balancing tiebreaker (file 04).
export type AssignmentCounts = Map<string, number>;

export function incAssignmentCount(counts: AssignmentCounts, instructorId: string): void {
  counts.set(instructorId, (counts.get(instructorId) ?? 0) + 1);
}

// v2: helper to detect a full_day assignment for min_full_day quota tracking.
export function isFullDay(camp: CampSession): boolean {
  return camp.session_type === 'full_day';
}

// ========== Matching: build candidates ==========

// Build a ranked candidate list for a single camp from a pool of instructors.
// Returns the sorted survivors AND the list of pool members that failed hard
// constraints (with reasons) so the caller can populate alternates_considered.
export interface CandidateBuildResult {
  ranked: ScoredCandidate[];
  filtered: { name: string; reason: ReasonCode }[];
}

export function buildCandidatesForCamp(
  camp: CampSession,
  pool: MatchInstructor[],
  constraintCtx: ConstraintContext,
  scoreCtx: SoftScoreContext,
  calendar: RunningCalendar,
  counts: AssignmentCounts,
  opts: {
    skipCurriculum?: boolean;
    // v2: skip session_type hard constraint (Pass 1 half-day fallback, Pass 3 T4)
    skipSessionType?: boolean;
    // v2: extra flag to attach to ranked candidates (e.g., 'synthetic_full_day_combo', 'session_type_override')
    extraFlag?: OutputFlag;
    // v2: per-instructor quotas and full-day counts (for the deficit bonus)
    quotas?: InstructorQuotas;
    fullDayCounts?: AssignmentCounts;
    // v2: explicit exclude list (used by Pass 4 to exclude the lead from the dev pool)
    excludeInstructorIds?: Set<string>;
  } = {},
): CandidateBuildResult {
  const ranked: ScoredCandidate[] = [];
  const filtered: { name: string; reason: ReasonCode }[] = [];
  const quotas = opts.quotas ?? new Map();
  const fullDayCounts = opts.fullDayCounts ?? new Map();
  for (const inst of pool) {
    if (opts.excludeInstructorIds?.has(inst.id)) continue;
    const res = checkHardConstraints(camp, inst, constraintCtx, calendar, {
      skipSessionType: opts.skipSessionType,
    });
    if (!res.eligible) {
      filtered.push({ name: inst.first_name, reason: res.reason });
      continue;
    }
    const { score, flags } = scoreCamp(camp, inst.id, scoreCtx, { skipCurriculum: opts.skipCurriculum });
    const bonus = quotaBonus(inst.id, camp, quotas, counts, fullDayCounts);
    const allFlags = opts.extraFlag ? [...flags, opts.extraFlag] : flags;
    ranked.push({
      instructor: inst,
      score: score + bonus,
      flags: allFlags,
      assignmentCount: counts.get(inst.id) ?? 0,
    });
  }
  return { ranked: sortCandidates(ranked), filtered };
}

// Pass 2 combo variant: an instructor must pass hard constraints for BOTH halves.
// Score is location-only (file 04). Returns the morning-half failed list as the
// canonical "alternates_considered" pool — the afternoon half's filtering is
// usually a subset, and we just want to surface why someone couldn't take the combo.
export function buildComboCandidates(
  morning: CampSession,
  afternoon: CampSession,
  pool: MatchInstructor[],
  constraintCtx: ConstraintContext,
  scoreCtx: SoftScoreContext,
  calendar: RunningCalendar,
  counts: AssignmentCounts,
  opts: { quotas?: InstructorQuotas; fullDayCounts?: AssignmentCounts } = {},
): CandidateBuildResult {
  const ranked: ScoredCandidate[] = [];
  const filtered: { name: string; reason: ReasonCode }[] = [];
  const quotas = opts.quotas ?? new Map();
  const fullDayCounts = opts.fullDayCounts ?? new Map();
  for (const inst of pool) {
    const am = checkHardConstraints(morning, inst, constraintCtx, calendar);
    if (!am.eligible) {
      filtered.push({ name: inst.first_name, reason: am.reason });
      continue;
    }
    const pm = checkHardConstraints(afternoon, inst, constraintCtx, calendar);
    if (!pm.eligible) {
      filtered.push({ name: inst.first_name, reason: pm.reason });
      continue;
    }
    const score = scoreComboLocation(morning.location_name, inst.id, scoreCtx);
    // For combos, quota bonus uses the morning camp as a proxy (location identical).
    const bonus = quotaBonus(inst.id, morning, quotas, counts, fullDayCounts);
    // Combo location-pref flags: if location is unavailable or not_preferred, emit those flags.
    const locPref = scoreCtx.locPrefByKey.get(`${inst.id}:${regionFor(morning.location_name, scoreCtx.regionMap)}`) ?? 'preferred';
    const flags: OutputFlag[] = [];
    if (locPref === 'unavailable') flags.push('location_override');
    else if (locPref === 'not_preferred') flags.push('location_low_pref');
    ranked.push({
      instructor: inst,
      score: score + bonus,
      flags,
      assignmentCount: counts.get(inst.id) ?? 0,
    });
  }
  return { ranked: sortCandidates(ranked), filtered };
}

// ========== Matching: three passes ==========

export interface MatchingInputs {
  camps: CampSession[];
  pool: MatchInstructor[];
  constraintCtx: ConstraintContext;
  scoreCtx: SoftScoreContext;
  // Camps locked by an existing 'confirmed' camp_assignments row (and their
  // instructors are pre-booked on the running calendar before passes start).
  // map: camp_session_id -> { instructor_id, role }
  lockedAssignments: Map<string, { instructor_id: string; role: 'lead' | 'developing' }>;
  // v2 (Change D): per-instructor quota targets. Under-quota instructors get
  // a +100 score bonus that dominates location/curriculum so they win contested
  // camps until their target is met.
  quotas?: InstructorQuotas;
}

export interface MatchingResult {
  decisions: CampDecision[];           // one per camp_session, in input order
  calendar: RunningCalendar;
  counts: AssignmentCounts;
  // v2: per-instructor full-day-only counter (for min_full_day quota tracking)
  fullDayCounts: AssignmentCounts;
}

export function runMatching(input: MatchingInputs): MatchingResult {
  const { camps, pool, constraintCtx, scoreCtx, lockedAssignments } = input;
  const quotas = input.quotas ?? new Map();
  const calendar: RunningCalendar = new Map();
  const counts: AssignmentCounts = new Map();
  const fullDayCounts: AssignmentCounts = new Map();
  const decisionByCampId = new Map<string, CampDecision>();
  const poolById = new Map(pool.map((p) => [p.id, p]));

  // ----- Pre-step: pre-book locked (confirmed) instructors -----
  for (const camp of camps) {
    const lock = lockedAssignments.get(camp.id);
    if (!lock) continue;
    bookInstructor(calendar, lock.instructor_id, camp.week_num, camp.class_days, camp.session_type, camp.location_id);
    incAssignmentCount(counts, lock.instructor_id);
    if (isFullDay(camp)) incAssignmentCount(fullDayCounts, lock.instructor_id);
    const lockedInst = poolById.get(lock.instructor_id);
    decisionByCampId.set(camp.id, {
      camp,
      proposed_instructor_id: lock.instructor_id,
      proposed_instructor_name: lockedInst ? lockedInst.first_name : null,
      role: lock.role,
      flags: [],
      status: 'locked_confirmed',
    });
  }

  const unassigned = camps.filter((c) => !decisionByCampId.has(c.id));

  // ----- Pass 1: explicit full_day camps -----
  const pass1Pool = pool.filter((p) => p.klass === 'full_day_only' || p.klass === 'full_day_capable');
  // v2 Pass 1 fallback pool: half_day_combo instructors with session_type override
  // (synthetic full_day — they cover both halves at the location).
  const pass1FallbackPool = pool.filter((p) => p.klass === 'half_day_combo');
  const pass1Camps = sortCampsForPass(unassigned.filter((c) => c.session_type === 'full_day'));
  for (const camp of pass1Camps) {
    const { ranked, filtered } = buildCandidatesForCamp(
      camp, pass1Pool, constraintCtx, scoreCtx, calendar, counts,
      { quotas, fullDayCounts },
    );
    if (ranked.length > 0) {
      assign(camp, ranked[0], decisionByCampId, calendar, counts, fullDayCounts);
      continue;
    }
    // v2 (Change B): half_day_combo synthetic full-day fallback
    const fb = buildCandidatesForCamp(
      camp, pass1FallbackPool, constraintCtx, scoreCtx, calendar, counts,
      { quotas, fullDayCounts, skipSessionType: true, extraFlag: 'synthetic_full_day_combo' },
    );
    if (fb.ranked.length > 0) {
      assign(camp, fb.ranked[0], decisionByCampId, calendar, counts, fullDayCounts);
      continue;
    }
    decisionByCampId.set(camp.id, {
      camp,
      proposed_instructor_id: null,
      proposed_instructor_name: null,
      role: 'lead',
      flags: ['no_eligible_instructor'],
      status: 'needs_hire',
      alternates_considered: rankAlternates([...filtered, ...fb.filtered]),
    });
  }

  // ----- Pass 2: AM+PM combo location-weeks -----
  const unassignedAfterP1 = camps.filter((c) => !decisionByCampId.has(c.id));
  const locWeeks = groupIntoLocationWeeks(unassignedAfterP1);
  const combos = locWeeks
    .filter(isCombo)
    .sort((a, b) => {
      if (a.week_num !== b.week_num) return a.week_num - b.week_num;
      return a.location_name.localeCompare(b.location_name);
    });
  const pass2Pool = pool.filter((p) => p.klass === 'full_day_capable' || p.klass === 'half_day_combo');
  for (const lw of combos) {
    const am = lw.morning!;
    const pm = lw.afternoon!;
    const { ranked } = buildComboCandidates(am, pm, pass2Pool, constraintCtx, scoreCtx, calendar, counts, { quotas, fullDayCounts });
    if (ranked.length === 0) {
      continue; // fall through to Pass 3 for each half
    }
    const winner = ranked[0];
    assign(am, winner, decisionByCampId, calendar, counts, fullDayCounts, ['continuity_combo']);
    assign(pm, winner, decisionByCampId, calendar, counts, fullDayCounts, ['continuity_combo']);
  }

  // ----- Pass 3: remaining single-session camps, tiered fallback -----
  // v2.1: Tier 0 promotes under-quota instructors of ANY klass above the standard
  // tier order, with session_type_override when needed. This is how the agent
  // honors per-instructor commitments (e.g., "Lance was promised 5 camps") — if
  // Lance is under quota, he wins his next eligible camp even if a half_day_single
  // instructor would otherwise have it on tier priority.
  const unassignedAfterP2 = camps.filter((c) => !decisionByCampId.has(c.id));
  const pass3Camps = sortCampsForPass(unassignedAfterP2);
  const tier1Pool = pool.filter((p) => p.klass === 'half_day_single');
  const tier2Pool = pool.filter((p) => p.klass === 'half_day_combo');
  const tier3Pool = pool.filter((p) => p.klass === 'full_day_capable');
  const tier4Pool = pool.filter((p) => p.klass === 'full_day_only');

  for (const camp of pass3Camps) {
    // v2.1 Tier 0: quota-deficit promotion. Split by whether session_type override is needed.
    const t0NoOverride = pool.filter((p) =>
      quotaBonus(p.id, camp, quotas, counts, fullDayCounts) > 0
      && p.availability.session_types.includes(camp.session_type)
    );
    const t0WithOverride = pool.filter((p) =>
      quotaBonus(p.id, camp, quotas, counts, fullDayCounts) > 0
      && !p.availability.session_types.includes(camp.session_type)
    );
    let t0Ranked: ScoredCandidate[] = [];
    if (t0NoOverride.length > 0) {
      const a = buildCandidatesForCamp(camp, t0NoOverride, constraintCtx, scoreCtx, calendar, counts, { quotas, fullDayCounts });
      t0Ranked = t0Ranked.concat(a.ranked);
    }
    if (t0WithOverride.length > 0) {
      const b = buildCandidatesForCamp(camp, t0WithOverride, constraintCtx, scoreCtx, calendar, counts, {
        quotas, fullDayCounts, skipSessionType: true, extraFlag: 'session_type_override',
      });
      t0Ranked = t0Ranked.concat(b.ranked);
    }
    if (t0Ranked.length > 0) {
      const winner = sortCandidates(t0Ranked)[0];
      assign(camp, winner, decisionByCampId, calendar, counts, fullDayCounts, ['fallback_assignment']);
      continue;
    }

    const t1 = buildCandidatesForCamp(camp, tier1Pool, constraintCtx, scoreCtx, calendar, counts, { quotas, fullDayCounts });
    if (t1.ranked.length > 0) {
      assign(camp, t1.ranked[0], decisionByCampId, calendar, counts, fullDayCounts);
      continue;
    }
    const t2 = buildCandidatesForCamp(camp, tier2Pool, constraintCtx, scoreCtx, calendar, counts, { quotas, fullDayCounts });
    if (t2.ranked.length > 0) {
      assign(camp, t2.ranked[0], decisionByCampId, calendar, counts, fullDayCounts);
      continue;
    }
    const t3 = buildCandidatesForCamp(camp, tier3Pool, constraintCtx, scoreCtx, calendar, counts, { quotas, fullDayCounts });
    if (t3.ranked.length > 0) {
      assign(camp, t3.ranked[0], decisionByCampId, calendar, counts, fullDayCounts, ['fallback_assignment']);
      continue;
    }
    const t4 = buildCandidatesForCamp(
      camp, tier4Pool, constraintCtx, scoreCtx, calendar, counts,
      { quotas, fullDayCounts, skipSessionType: true, extraFlag: 'session_type_override' },
    );
    if (t4.ranked.length > 0) {
      assign(camp, t4.ranked[0], decisionByCampId, calendar, counts, fullDayCounts, ['fallback_assignment']);
      continue;
    }
    const merged = [...t1.filtered, ...t2.filtered, ...t3.filtered, ...t4.filtered];
    decisionByCampId.set(camp.id, {
      camp,
      proposed_instructor_id: null,
      proposed_instructor_name: null,
      role: 'lead',
      flags: ['no_eligible_instructor'],
      status: 'needs_hire',
      alternates_considered: rankAlternates(merged),
    });
  }

  // ----- Pass 4 (v2 Change E): developing-instructor for high-enrollment camps -----
  // For each camp with current_enrollment >= dev_instructor_threshold, find a SECOND
  // instructor (not the lead) to serve as developing. Lead must already be assigned.
  // Eligible pool: any role_preference except lead_only.
  const devEligibleClasses = new Set<InstructorClass>([
    'full_day_only', 'full_day_capable', 'half_day_combo', 'half_day_single',
  ]);
  const devPool = pool.filter((p) =>
    p.availability.role_preference !== 'lead_only' && devEligibleClasses.has(p.klass)
  );
  for (const camp of camps) {
    if (camp.current_enrollment < constraintCtx.cycle.dev_instructor_threshold) continue;
    const leadDecision = decisionByCampId.get(camp.id);
    if (!leadDecision || !leadDecision.proposed_instructor_id) continue; // no lead, no developing
    const excludeLead = new Set([leadDecision.proposed_instructor_id]);
    const dev = buildCandidatesForCamp(
      camp, devPool, constraintCtx, scoreCtx, calendar, counts,
      { quotas, fullDayCounts, excludeInstructorIds: excludeLead },
    );
    let winner = dev.ranked[0];
    let devFlags: OutputFlag[] = [];
    let allFiltered: { name: string; reason: ReasonCode }[] = [...dev.filtered];
    if (!winner) {
      const devFb = buildCandidatesForCamp(
        camp, devPool, constraintCtx, scoreCtx, calendar, counts,
        {
          quotas, fullDayCounts, excludeInstructorIds: excludeLead,
          skipSessionType: true, extraFlag: 'session_type_override',
        },
      );
      winner = devFb.ranked[0];
      if (winner) devFlags = [...winner.flags];
      allFiltered = [...allFiltered, ...devFb.filtered];
    } else {
      devFlags = [...winner.flags];
    }
    if (winner) {
      bookInstructor(calendar, winner.instructor.id, camp.week_num, camp.class_days, camp.session_type, camp.location_id);
      incAssignmentCount(counts, winner.instructor.id);
      if (isFullDay(camp)) incAssignmentCount(fullDayCounts, winner.instructor.id);
      const hardship = devFlags.includes('location_override') ? HARDSHIP_BONUS_AMOUNT : undefined;
      leadDecision.developing_proposal = {
        instructor_id: winner.instructor.id,
        instructor_name: winner.instructor.first_name,
        flags: devFlags,
        ...(hardship !== undefined ? { hardship_bonus_offered: hardship } : {}),
      };
    } else {
      // v2.1: surface the gap — dev slot needed but no eligible instructor
      leadDecision.developing_needs_hire = true;
      leadDecision.developing_alternates_considered = rankAlternates(allFiltered);
    }
  }

  const decisions: CampDecision[] = camps.map((c) =>
    decisionByCampId.get(c.id) ?? {
      camp: c,
      proposed_instructor_id: null,
      proposed_instructor_name: null,
      role: 'lead',
      flags: ['no_eligible_instructor'],
      status: 'needs_hire',
    },
  );

  return { decisions, calendar, counts, fullDayCounts };
}

function assign(
  camp: CampSession,
  winner: ScoredCandidate,
  out: Map<string, CampDecision>,
  calendar: RunningCalendar,
  counts: AssignmentCounts,
  fullDayCounts: AssignmentCounts,
  extraFlags: OutputFlag[] = [],
): void {
  // Booking semantics:
  //   - `synthetic_full_day_combo` = half_day_combo covers a full_day camp → they ARE
  //     teaching the full day; block the full-day window.
  //   - `session_type_override` = a full_day_only/capable instructor takes a half-day
  //     camp → they're only teaching that half; book the actual session_type so they
  //     stay available for the other half elsewhere (e.g., Skyler doing HV W5 AM should
  //     still be free for an afternoon camp that week).
  //   - Normal case: book the camp's session_type.
  const bookType: SessionType =
    winner.flags.includes('synthetic_full_day_combo')
      ? 'full_day'
      : camp.session_type;
  bookInstructor(calendar, winner.instructor.id, camp.week_num, camp.class_days, bookType, camp.location_id);
  incAssignmentCount(counts, winner.instructor.id);
  if (isFullDay(camp)) incAssignmentCount(fullDayCounts, winner.instructor.id);
  const role = decideRole(winner.instructor.availability);
  const flags = [...extraFlags, ...(winner.flags as OutputFlag[])];
  const hardship = flags.includes('location_override') ? HARDSHIP_BONUS_AMOUNT : undefined;
  out.set(camp.id, {
    camp,
    proposed_instructor_id: winner.instructor.id,
    proposed_instructor_name: winner.instructor.first_name,
    role,
    flags,
    status: 'assigned',
    ...(hardship !== undefined ? { hardship_bonus_offered: hardship } : {}),
  });
}

// ========== Output JSON builder ==========

// v2.2: platform AI surfaces actionable recommendations alongside the schedule.
// The Director can render these as cards on the home screen ("Ask Kristin about
// adding W4 — she'd cover 2 more camps", "W4 is over-subscribed — consider
// canceling Lacamas W4 PM").
export type RecommendationType =
  | 'hire_external'                  // unfilled lead/developing slots → hire
  | 'reduce_camps_in_week'           // saturated week with structural gap
  | 'expand_instructor_availability'; // adding weeks to an instructor's availability would close gaps

export interface Recommendation {
  type: RecommendationType;
  priority: 'high' | 'medium' | 'low';
  summary: string;        // one-line headline for card title
  detail: string;         // longer body for card body / hover
  data: Record<string, unknown>;
}

export interface OutputJSON {
  cycle_id: string;
  cycle_name?: string;
  summary: {
    total_camps: number;
    assigned: number;
    flagged: number;
    needs_hire: number;
    missing_surveys: string[];
    missing_training: string[];
    // v2: instructors with zero camps after all passes — admin notifications
    low_load_alerts: string[];
    // v2: instructors with promised quotas that the algorithm could not meet
    unmet_quotas: Array<{ name: string; got: number; target_camps?: number; target_full_day?: number; got_full_day?: number }>;
    // v2: count of high-enrollment camps where a developing slot is also proposed
    developing_assignments: number;
    // v2.2: programmatic suggestions for the admin (hire/reduce/expand)
    recommendations: Recommendation[];
  };
  camps: Array<{
    camp_session_id: string;
    location_name: string;
    week_num: number;
    session_type: SessionType;
    class_days: string[];
    curriculum_name: string;
    proposed_instructor_id: string | null;
    proposed_instructor_name: string | null;
    flags: OutputFlag[];
    status?: 'needs_hire' | 'locked_confirmed';
    alternates_considered?: { name: string; reason: ReasonCode }[];
    // v2 (Change C): present when location_override fires for the lead.
    hardship_bonus_offered?: number;
    // v2 (Change E): present when enrollment >= dev_instructor_threshold AND a dev was matched.
    developing_proposal?: DevelopingProposal;
    // v2.1: present when enrollment >= dev_instructor_threshold but no dev was matched.
    developing_needs_hire?: boolean;
    developing_alternates_considered?: { name: string; reason: ReasonCode }[];
  }>;
}

export function buildOutputJSON(opts: {
  cycle_id: string;
  cycle_name?: string;
  decisions: CampDecision[];
  missing_surveys: string[];
  missing_training?: string[];
  // v2 inputs for richer summary
  pool: MatchInstructor[];
  counts: AssignmentCounts;
  fullDayCounts: AssignmentCounts;
  quotas?: InstructorQuotas;
  // v2.2: needed for `expand_instructor_availability` recommendations
  camps?: CampSession[];
  scoreCtx?: SoftScoreContext;
}): OutputJSON {
  const { cycle_id, cycle_name, decisions, missing_surveys, pool, counts, fullDayCounts } = opts;
  const quotas = opts.quotas ?? new Map();
  const assigned = decisions.filter((d) => d.status === 'assigned' || d.status === 'locked_confirmed').length;
  const needs_hire = decisions.filter((d) => d.status === 'needs_hire').length;
  const flagged = decisions.filter((d) => d.flags.length > 0).length;
  const developing_assignments = decisions.filter((d) => !!d.developing_proposal).length;

  // v2: low_load alerts — instructors with 0 camps after all passes
  const low_load_alerts = pool
    .filter((p) => (counts.get(p.id) ?? 0) === 0)
    .map((p) => `${p.first_name}${p.last_name ? ' ' + p.last_name : ''}`);

  // v2: unmet quotas
  const unmet_quotas: OutputJSON['summary']['unmet_quotas'] = [];
  for (const [instrId, q] of quotas) {
    const got = counts.get(instrId) ?? 0;
    const gotFd = fullDayCounts.get(instrId) ?? 0;
    const inst = pool.find((p) => p.id === instrId);
    const name = inst ? inst.first_name : instrId.slice(0, 8);
    const missedCamps = q.min_camps !== undefined && got < q.min_camps;
    const missedFullDay = q.min_full_day !== undefined && gotFd < q.min_full_day;
    if (missedCamps || missedFullDay) {
      unmet_quotas.push({
        name,
        got,
        ...(q.min_camps !== undefined ? { target_camps: q.min_camps } : {}),
        ...(q.min_full_day !== undefined ? { target_full_day: q.min_full_day, got_full_day: gotFd } : {}),
      });
    }
  }

  // v2.2: programmatic recommendations
  const recommendations = generateRecommendations({
    pool,
    decisions,
    camps: opts.camps ?? decisions.map((d) => d.camp),
    scoreCtx: opts.scoreCtx,
  });

  return {
    cycle_id,
    cycle_name,
    summary: {
      total_camps: decisions.length,
      assigned,
      flagged,
      needs_hire,
      missing_surveys,
      missing_training: opts.missing_training ?? [],
      low_load_alerts,
      unmet_quotas,
      developing_assignments,
      recommendations,
    },
    camps: decisions.map((d) => {
      const out: OutputJSON['camps'][number] = {
        camp_session_id: d.camp.id,
        location_name: d.camp.location_name,
        week_num: d.camp.week_num,
        session_type: d.camp.session_type,
        class_days: d.camp.class_days,
        curriculum_name: d.camp.curriculum_name,
        proposed_instructor_id: d.proposed_instructor_id,
        proposed_instructor_name: d.proposed_instructor_name,
        flags: d.flags,
      };
      if (d.status === 'needs_hire') {
        out.status = 'needs_hire';
        if (d.alternates_considered) out.alternates_considered = d.alternates_considered;
      } else if (d.status === 'locked_confirmed') {
        out.status = 'locked_confirmed';
      }
      if (d.hardship_bonus_offered !== undefined) out.hardship_bonus_offered = d.hardship_bonus_offered;
      if (d.developing_proposal) out.developing_proposal = d.developing_proposal;
      if (d.developing_needs_hire) {
        out.developing_needs_hire = true;
        if (d.developing_alternates_considered) {
          out.developing_alternates_considered = d.developing_alternates_considered;
        }
      }
      return out;
    }),
  };
}

// ========== v2.2: Recommendations engine ==========

// Surfaces 3 kinds of actionable suggestions for the admin:
//   1. Hire external instructors (high priority when needs_hire or developing_unfilled > 0)
//   2. Reduce camp count in a saturated week (when parallel locations > W-available instructors AND gaps exist)
//   3. Expand a specific instructor's availability (when adding weeks to their availability would close gaps)
// The Director home screen will render these as cards.
export function generateRecommendations(opts: {
  pool: MatchInstructor[];
  decisions: CampDecision[];
  camps: CampSession[];
  scoreCtx?: SoftScoreContext;
}): Recommendation[] {
  const recs: Recommendation[] = [];
  const { pool, decisions, camps, scoreCtx } = opts;

  // --- 1. Hire external ---
  const needsHireCamps = decisions.filter((d) => d.status === 'needs_hire');
  const devUnfilledCamps = decisions.filter((d) => d.developing_needs_hire);
  if (needsHireCamps.length + devUnfilledCamps.length > 0) {
    const gapList = needsHireCamps.map((d) => `${d.camp.location_name} W${d.camp.week_num} ${d.camp.session_type}`);
    const devList = devUnfilledCamps.map((d) => `${d.camp.location_name} W${d.camp.week_num} ${d.camp.session_type} (developing)`);
    recs.push({
      type: 'hire_external',
      priority: 'high',
      summary: `Hire ${needsHireCamps.length + devUnfilledCamps.length} external instructor(s) for unfilled slots`,
      detail: `${needsHireCamps.length} lead slot(s) and ${devUnfilledCamps.length} developing slot(s) cannot be filled by your current pool. Gaps: ${[...gapList, ...devList].join('; ')}.`,
      data: {
        needs_hire_count: needsHireCamps.length,
        developing_unfilled_count: devUnfilledCamps.length,
        gaps: [...gapList, ...devList],
      },
    });
  }

  // --- 2. Reduce camps in saturated weeks ---
  const weeks = [...new Set(camps.map((c) => c.week_num))].sort((a, b) => a - b);
  for (const wk of weeks) {
    const wkCamps = camps.filter((c) => c.week_num === wk);
    const uniqueLocs = new Set(wkCamps.map((c) => c.location_id));
    const parallelLocs = uniqueLocs.size;
    const availInstructors = pool.filter((p) => p.availability.available_weeks.includes(wk)).length;
    const wkGaps = decisions.filter((d) => d.camp.week_num === wk && d.status === 'needs_hire').length;
    if (parallelLocs > availInstructors && wkGaps > 0) {
      // We deliberately don't name specific cancellation candidates here. Several
      // J2S venues (Camas Community Ed, West Linn, Corbett) run their own
      // registration, so DB enrollment can be stale and naming low-enrollment
      // camps would risk recommending cancellation of camps that are actually
      // filling. The over-subscription signal alone is useful; admin picks the
      // cancel candidates with partner/external-reg context the agent lacks.
      recs.push({
        type: 'reduce_camps_in_week',
        priority: 'medium',
        summary: `Week ${wk} is over-subscribed: ${parallelLocs} parallel locations, only ${availInstructors} instructors available`,
        detail: `${wkGaps} camp(s) cannot be staffed in Week ${wk}. Review individual camps closer to start date and decide on cancellations if enrollment stays low.`,
        data: {
          week_num: wk,
          parallel_locations: parallelLocs,
          available_instructors: availInstructors,
          gaps: wkGaps,
        },
      });
    }
  }

  // --- 3. Expand a specific instructor's availability ---
  // For each needs_hire camp, identify instructors who would have passed all hard
  // constraints (session_type, location, role) IF they had this week in their
  // available_weeks. Tally per instructor; surface top 3.
  if (scoreCtx) {
    const impact = new Map<string, { id: string; name: string; weeks: Set<number>; campsCovered: number }>();
    for (const d of needsHireCamps) {
      for (const inst of pool) {
        if (inst.availability.available_weeks.includes(d.camp.week_num)) continue; // already had this week
        if (!inst.availability.session_types.includes(d.camp.session_type)) continue; // session_type mismatch
        const region = regionFor(d.camp.location_name, scoreCtx.regionMap);
        const locPref = scoreCtx.locPrefByKey.get(`${inst.id}:${region}`) ?? 'preferred';
        if (locPref === 'unavailable') continue; // would still need hardship override
        const entry = impact.get(inst.id) ?? { id: inst.id, name: inst.first_name, weeks: new Set<number>(), campsCovered: 0 };
        entry.weeks.add(d.camp.week_num);
        entry.campsCovered += 1;
        impact.set(inst.id, entry);
      }
    }
    const ranked = [...impact.values()].sort((a, b) => b.campsCovered - a.campsCovered).slice(0, 3);
    for (const ent of ranked) {
      const weeksList = [...ent.weeks].sort((a, b) => a - b);
      const wkLabel = weeksList.length > 1 ? `Weeks ${weeksList.join(', ')}` : `Week ${weeksList[0]}`;
      recs.push({
        type: 'expand_instructor_availability',
        priority: 'medium',
        summary: `Ask ${ent.name} about adding ${wkLabel} — would cover ${ent.campsCovered} more camp(s)`,
        detail: `${ent.name} already has the right session_type and location preferences for ${ent.campsCovered} unfilled slot(s). Only blocker is week availability.`,
        data: {
          instructor_id: ent.id,
          instructor_name: ent.name,
          weeks_to_add: weeksList,
          camps_covered: ent.campsCovered,
        },
      });
    }
  }

  return recs;
}
