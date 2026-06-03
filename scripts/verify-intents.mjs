// Eat-the-cooking for the Family Comms intent registry. Constructs synthetic
// PeriodFacts payloads representing the boundary conditions in
// docs/specs/family-comms-q1-intent-first.md and asserts that
// getIntentsForPeriod fires/hides the right intents with the right labels.
//
// Run: `node scripts/verify-intents.mjs` from the repo root.
// Exit 0 = all assertions pass. Exit 1 = at least one failure (printed).
//
// Why this exists: Step 2 of the Family Comms Q1 build. Per Jessica's
// directive 2026-06-02: "verify what you can before asking me to do it."
// SQL trace covers today's J2S data; this script covers boundary conditions
// (exactly 28/91 days for registration_opened, exactly 7/14 days for
// last_call, etc.) that don't exist in live data right now.

import { getIntentsForPeriod, OTHER_INTENTS } from "../src/pages/admin/marketing-v2/lib/intents.js";

// ---------- Test plumbing ----------

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(msg);
}

function assertHas(intents, key, msg) {
  assert(intents.some((i) => i.key === key), `${msg}: expected intent '${key}' to fire, got [${intents.map((i) => i.key).join(", ")}]`);
}
function assertNoneOf(intents, key, msg) {
  assert(!intents.some((i) => i.key === key), `${msg}: expected intent '${key}' to hide, got [${intents.map((i) => i.key).join(", ")}]`);
}
function intent(intents, key) {
  return intents.find((i) => i.key === key);
}

// ---------- Synthetic-fact builders ----------

const TODAY_ISO = new Date().toISOString().slice(0, 10);

function isoFromNow(daysAhead) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// Build a synthetic afterschool period with `n` programs, all sharing the
// same first_session_date + class_size_min/max + enrollment. Overrides let
// individual tests vary EB deadline, enrollment, etc.
function afterschoolPeriod({
  term = "FA26",
  programCount = 5,
  daysToFirstSession = 90,
  daysToEarlyBird = null, // null = no EB
  enrolled = 0,
  classMin = 4,
  classMax = 14,
}) {
  const firstSession = daysToFirstSession != null ? isoFromNow(daysToFirstSession) : null;
  const eb = daysToEarlyBird != null ? isoFromNow(daysToEarlyBird) : null;
  const programs = Array.from({ length: programCount }, (_, i) => ({
    id: `p-${i}`,
    term,
    curriculum: `Curriculum ${i}`,
    first_session_date: firstSession,
    early_bird_deadline: eb,
    early_bird_price_cents: eb ? 1900 : null,
    enrolled,
    max_capacity: classMax,
    class_size_min: classMin,
    class_size_max: classMax,
    program_locations: { name: `School ${i}` },
  }));
  return buildPeriod({ term, programType: "afterschool", programs, camps: [] });
}

function campsPeriod({
  term = "SU26",
  sessionCount = 8,
  daysToFirstSession = 30,
  enrolled = 0,
  classMin = 4,
  classMax = 20,
}) {
  const startsOn = isoFromNow(daysToFirstSession);
  const camps = Array.from({ length: sessionCount }, (_, i) => ({
    id: `c-${i}`,
    curriculum_name: `Camp ${i}`,
    location_name: `Location ${i % 3}`,
    starts_on: startsOn,
    ends_on: isoFromNow(daysToFirstSession + 4),
    current_enrollment: enrolled,
    class_size_min: classMin,
    class_size_max: classMax,
  }));
  return buildPeriod({ term, programType: "camps", programs: [], camps });
}

// Lightweight buildPeriod (mirrors periodDetection.js#buildPeriod but
// purely for tests — no Supabase calls).
function buildPeriod({ term, programType, programs, camps }) {
  const isAfterschool = programType === "afterschool";
  const items = isAfterschool ? programs : camps;
  const startsOf = (it) => it.first_session_date ?? it.starts_on;

  const firstSessions = items.map(startsOf).filter(Boolean).sort();
  const earliestFirstSession = firstSessions[0] ?? null;

  const ebDeadlines = isAfterschool
    ? programs.map((p) => p.early_bird_deadline).filter((d) => d && d >= TODAY_ISO).sort()
    : [];
  const earliestActiveEarlyBird = ebDeadlines[0] ?? null;

  const daysFrom = (iso) => {
    if (!iso) return null;
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    const target = new Date(`${iso}T00:00:00`);
    return Math.ceil((target.getTime() - t.getTime()) / 86400000);
  };

  const facts = {
    key: `${term}-${programType}`,
    term,
    programType,
    isAfterschool,
    programs,
    camps,
    programIds: programs.map((p) => p.id),
    campIds: camps.map((c) => c.id),
    schoolNames: isAfterschool
      ? [...new Set(programs.map((p) => p.program_locations?.name).filter(Boolean))]
      : [...new Set(camps.map((c) => c.location_name).filter(Boolean))],
    earliestActiveEarlyBird,
    earliestFirstSession,
    latestFirstSession: firstSessions[firstSessions.length - 1] ?? null,
    daysUntilEarlyBird: earliestActiveEarlyBird ? daysFrom(earliestActiveEarlyBird) : null,
    daysUntilFirstSession: earliestFirstSession ? daysFrom(earliestFirstSession) : null,
  };

  return { key: facts.key, label: `${term}-${programType}`, facts };
}

// ---------- Tests ----------

// === registration_opened: 28-91 day window ===
{
  // Just inside the lower bound
  const p = afterschoolPeriod({ daysToFirstSession: 28 });
  assertHas(getIntentsForPeriod(p, [p]), "registration_opened", "registration_opened fires at 28-day boundary");
}
{
  // Just inside the upper bound
  const p = afterschoolPeriod({ daysToFirstSession: 91 });
  assertHas(getIntentsForPeriod(p, [p]), "registration_opened", "registration_opened fires at 91-day boundary");
}
{
  // Just outside lower
  const p = afterschoolPeriod({ daysToFirstSession: 27 });
  assertNoneOf(getIntentsForPeriod(p, [p]), "registration_opened", "registration_opened hides at 27 days (too close)");
}
{
  // Just outside upper
  const p = afterschoolPeriod({ daysToFirstSession: 92 });
  assertNoneOf(getIntentsForPeriod(p, [p]), "registration_opened", "registration_opened hides at 92 days (too far)");
}

// === last_call: EB ≤ 7 days OR start ≤ 14 days, EB-driven wins ties ===
{
  // EB tomorrow → fires, label uses EB
  const p = afterschoolPeriod({ daysToFirstSession: 60, daysToEarlyBird: 1 });
  const lc = intent(getIntentsForPeriod(p, [p]), "last_call");
  assert(!!lc, "last_call fires when EB is 1 day out");
  assert(lc?.label === "Last 1 day for early-bird", `last_call label expected 'Last 1 day for early-bird', got '${lc?.label}'`);
}
{
  // Start 5 days, no EB → fires, label uses start
  const p = afterschoolPeriod({ daysToFirstSession: 5, daysToEarlyBird: null });
  const lc = intent(getIntentsForPeriod(p, [p]), "last_call");
  assert(!!lc, "last_call fires when first-session is 5 days out and no EB");
  assert(lc?.label === "Starts in 5 days — last call", `last_call label expected 'Starts in 5 days — last call', got '${lc?.label}'`);
}
{
  // Start 1 day → "tomorrow" label
  const p = afterschoolPeriod({ daysToFirstSession: 1, daysToEarlyBird: null });
  const lc = intent(getIntentsForPeriod(p, [p]), "last_call");
  assert(lc?.label === "Starts tomorrow — last call", `last_call label expected 'Starts tomorrow — last call', got '${lc?.label}'`);
}
{
  // Start 15 days, no EB → does NOT fire (out of window)
  const p = afterschoolPeriod({ daysToFirstSession: 15, daysToEarlyBird: null });
  assertNoneOf(getIntentsForPeriod(p, [p]), "last_call", "last_call hides at 15 days first-session");
}
{
  // EB 5 days AND start 10 days — EB wins (closer)
  const p = afterschoolPeriod({ daysToFirstSession: 10, daysToEarlyBird: 5 });
  const lc = intent(getIntentsForPeriod(p, [p]), "last_call");
  assert(lc?.label.includes("early-bird"), `tie-break: EB closer → EB label, got '${lc?.label}'`);
}

// === fill_remaining_seats: first_session > 21 days AND items with room ===
{
  // 60 days out, items at 0/14 → fires
  const p = afterschoolPeriod({ daysToFirstSession: 60, enrolled: 0, classMax: 14 });
  assertHas(getIntentsForPeriod(p, [p]), "fill_remaining_seats", "fill_remaining_seats fires at 60 days with room");
}
{
  // 21 days exactly → does NOT fire (gate is > 21)
  const p = afterschoolPeriod({ daysToFirstSession: 21, enrolled: 0 });
  assertNoneOf(getIntentsForPeriod(p, [p]), "fill_remaining_seats", "fill_remaining_seats hides at exactly 21 days");
}
{
  // 60 days out, all items full → does NOT fire (no room)
  const p = afterschoolPeriod({ daysToFirstSession: 60, enrolled: 14, classMax: 14 });
  assertNoneOf(getIntentsForPeriod(p, [p]), "fill_remaining_seats", "fill_remaining_seats hides when all items full");
}
{
  // 60 days out, class_size_max unknown → does NOT fire (honest default)
  const p = afterschoolPeriod({ daysToFirstSession: 60, classMax: null });
  // Override max_capacity too so hasRoomToFill sees null
  p.facts.programs.forEach((pr) => { pr.max_capacity = null; pr.class_size_max = null; });
  assertNoneOf(getIntentsForPeriod(p, [p]), "fill_remaining_seats", "fill_remaining_seats hides when class_size_max unknown");
}

// === low_enrollment_push: enrolled<min AND within 42 days ===
{
  // 30 days out, 1 enrolled, min 4 → fires
  const p = afterschoolPeriod({ daysToFirstSession: 30, enrolled: 1, classMin: 4 });
  assertHas(getIntentsForPeriod(p, [p]), "low_enrollment_push", "low_enrollment_push fires at 30 days with enrolled<min");
}
{
  // 60 days out, 1 enrolled — fires because enrolled>=1 signals real struggle
  // (refined rule 2026-06-02 — old 42-day cap dropped, Portland camps were
  // falsely excluded at 50+ days out)
  const p = afterschoolPeriod({ daysToFirstSession: 60, enrolled: 1 });
  assertHas(getIntentsForPeriod(p, [p]), "low_enrollment_push", "low_enrollment_push fires beyond 14 days when at least 1 enrolled");
}
{
  // 60 days out, 0 enrolled — NOT low (could be reg-just-opened)
  const p = afterschoolPeriod({ daysToFirstSession: 60, enrolled: 0 });
  assertNoneOf(getIntentsForPeriod(p, [p]), "low_enrollment_push", "low_enrollment_push hides at 60d with 0 enrolled (no signal yet)");
}
{
  // 7 days out, 0 enrolled — fires (within 14d urgency, any below-min counts)
  const p = afterschoolPeriod({ daysToFirstSession: 7, enrolled: 0 });
  assertHas(getIntentsForPeriod(p, [p]), "low_enrollment_push", "low_enrollment_push fires within 14d even with 0 enrolled (urgent)");
}
{
  // class_size_min unknown → honest-default hides
  const p = afterschoolPeriod({ daysToFirstSession: 30, enrolled: 1, classMin: null });
  p.facts.programs.forEach((pr) => { pr.class_size_min = null; });
  assertNoneOf(getIntentsForPeriod(p, [p]), "low_enrollment_push", "low_enrollment_push hides when class_size_min unknown");
}
{
  // 20 days out, enrolled=5 ≥ min=4 → does NOT fire
  const p = afterschoolPeriod({ daysToFirstSession: 20, enrolled: 5, classMin: 4 });
  assertNoneOf(getIntentsForPeriod(p, [p]), "low_enrollment_push", "low_enrollment_push hides when enrolled meets min");
}

// === Cross-sell removed — verify it never fires ===
{
  const p1 = afterschoolPeriod({ term: "FA26" });
  const p2 = campsPeriod({ term: "SU26" });
  const result = [...getIntentsForPeriod(p1, [p1, p2]), ...getIntentsForPeriod(p2, [p1, p2])];
  assert(!result.some((i) => i.key === "cross_sell"), "cross_sell removed — must not fire under any condition");
}

// === Camps period with first_session within 14 days ===
{
  const p = campsPeriod({ daysToFirstSession: 13, sessionCount: 10, enrolled: 0, classMin: 4 });
  const intents = getIntentsForPeriod(p, [p]);
  assertHas(intents, "last_call", "camps: last_call fires at 13 days");
  assertHas(intents, "low_enrollment_push", "camps: low_enrollment_push fires (within 42d, enrolled<min)");
  assertNoneOf(intents, "fill_remaining_seats", "camps: fill_remaining_seats hides (within 21d)");
  assertNoneOf(intents, "registration_opened", "camps: registration_opened hides (too close)");
}

// === Period with no items at all → no intents ===
{
  const p = afterschoolPeriod({ programCount: 0, daysToFirstSession: 60 });
  const intents = getIntentsForPeriod(p, [p]);
  assert(intents.length === 0, `empty period should produce 0 intents, got ${intents.length}: [${intents.map((i) => i.key).join(", ")}]`);
}

// === Preselect shape assertions — Step 5 wiring proof ===
// Each intent's preselects payload must produce inputs the reducer +
// downstream Q2-Q4 can consume without further wiring. Specifically:
//   - what.mode is set and matches the period type (or 'other' for one-offs)
//   - what.intent_key is set (drives edge function tone rules)
//   - who.audience='parents' and filter.type is one Q2 understands
//   - duration is non-empty for non-other intents (Q3 valid)
//   - promo is null OR an object (reducer merges over INITIAL.promo)
{
  const p = afterschoolPeriod({ daysToFirstSession: 90, daysToEarlyBird: 3 });
  const intents = getIntentsForPeriod(p, [p]);

  for (const i of intents) {
    const ps = i.preselects;
    assert(ps != null, `intent ${i.key}: preselects must be defined`);
    assert(ps.what != null, `intent ${i.key}: preselects.what must be defined`);
    assert(["programs", "camps", "other"].includes(ps.what.mode), `intent ${i.key}: what.mode invalid (${ps.what.mode})`);
    assert(typeof ps.what.intent_key === "string" && ps.what.intent_key.length > 0, `intent ${i.key}: what.intent_key must be a non-empty string`);
    assert(ps.who?.audience === "parents", `intent ${i.key}: who.audience must be 'parents' in v1`);
    assert(["auto", "master_list", "school", "area", "segment", "person"].includes(ps.who?.filter?.type), `intent ${i.key}: who.filter.type unknown (${ps.who?.filter?.type})`);
    assert(typeof ps.duration === "string" && ps.duration.length > 0, `intent ${i.key}: duration must be set for period intents (got ${JSON.stringify(ps.duration)})`);
    assert(ps.promo === null || typeof ps.promo === "object", `intent ${i.key}: promo must be null or object`);
  }
}

// === OTHER_INTENTS shape assertions — Step 4 wiring proof ===
{
  for (const i of OTHER_INTENTS) {
    const ps = i.preselects;
    assert(ps?.what?.mode === "other", `other intent ${i.key}: what.mode must be 'other'`);
    assert(typeof ps.what.intent_key === "string" && ps.what.intent_key.startsWith("other_"), `other intent ${i.key}: intent_key must start with 'other_'`);
    // Free-form skips topic preset; others must have one
    if (!i.expandsPickerOnly) {
      assert(Array.isArray(ps.what.topics) && ps.what.topics.length > 0, `other intent ${i.key}: topics must be pre-filled for non-free-form`);
      assert(ps.who?.audience === "parents", `other intent ${i.key}: who.audience must be 'parents'`);
    }
  }
}

// === Reducer round-trip — APPLY_PRESELECT semantics ===
// Simulate the reducer step to prove inputs settle in a Q2/Q3/Q4-ready shape.
function applyPreselect(state, preselect) {
  const p = preselect ?? {};
  return {
    ...state,
    inputs: {
      ...state.inputs,
      what: { ...state.inputs.what, ...(p.what ?? {}) },
      who: p.who ?? state.inputs.who,
      duration: p.duration ?? state.inputs.duration,
      promo: p.promo ? { ...state.inputs.promo, ...p.promo } : state.inputs.promo,
    },
  };
}
const INITIAL_INPUTS = {
  what: { mode: "programs", program_ids: [], camp_session_ids: [], topics: [], intent_key: null },
  who: { audience: "parents", filter: { type: "auto" }, exclude_already_registered: false },
  promo: { early_bird: false, vip_option: false, multi_camp_discount: false, code: null },
  duration: "",
  channels: ["email"],
};
{
  // last_call intent → inputs settle with intent_key, programs picked, who=auto, duration=custom, promo.early_bird=true (merged)
  const p = afterschoolPeriod({ daysToFirstSession: 60, daysToEarlyBird: 3 });
  const lc = intent(getIntentsForPeriod(p, [p]), "last_call");
  const next = applyPreselect({ inputs: INITIAL_INPUTS }, lc.preselects);
  assert(next.inputs.what.intent_key === "last_call", "reducer: intent_key persisted on what");
  assert(next.inputs.what.mode === "programs", "reducer: mode applied");
  assert(next.inputs.what.program_ids.length > 0, "reducer: program_ids non-empty");
  assert(next.inputs.who.filter.type === "auto", "reducer: who.filter.type set by intent");
  assert(next.inputs.duration.startsWith("custom:"), "reducer: duration set to custom range");
  assert(next.inputs.promo.early_bird === true, "reducer: early_bird merged into existing promo defaults");
  assert(next.inputs.promo.vip_option === false, "reducer: other promo defaults preserved");
  assert(next.inputs.channels[0] === "email", "reducer: channels untouched");
}
{
  // fill_remaining_seats → no promo → reducer keeps INITIAL.promo intact
  const p = afterschoolPeriod({ daysToFirstSession: 60, enrolled: 5, classMax: 14 });
  const frs = intent(getIntentsForPeriod(p, [p]), "fill_remaining_seats");
  const next = applyPreselect({ inputs: INITIAL_INPUTS }, frs.preselects);
  assert(next.inputs.duration === "2 weeks", "reducer: 2 weeks duration set");
  assert(next.inputs.promo.early_bird === false, "reducer: null promo intent leaves defaults alone");
}
{
  // Schedule change (other intent) → mode='other', intent_key set, no duration (Q3 routes to send-time)
  const sc = OTHER_INTENTS.find((i) => i.key === "other_schedule_change");
  const next = applyPreselect({ inputs: INITIAL_INPUTS }, sc.preselects);
  assert(next.inputs.what.mode === "other", "reducer: other intent sets mode='other'");
  assert(next.inputs.what.intent_key === "other_schedule_change", "reducer: other_schedule_change intent_key set");
  assert(next.inputs.what.topics.length === 1 && next.inputs.what.topics[0] === "Schedule change", "reducer: other_schedule_change pre-fills topic");
  // Q3 for mode='other' uses send_at, not duration. Intent doesn't preset send_at; Q3 picker asks.
  assert(next.inputs.duration === "", "reducer: schedule change intent doesn't preset duration (send_at lives elsewhere)");
}

// ---------- Result ----------

console.log(`\nintent registry verification: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
