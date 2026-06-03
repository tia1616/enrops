// Period detection — collapses the operator's open catalog into "what's
// currently actionable" cards for the Q1 intent-first UI.
//
// One card per (term, program_type) combination. After-school uses
// programs.term directly; camps derive a term from starts_on (no `term`
// column on camp_sessions). Cards with nothing actionable (empty pickset)
// are dropped.
//
// Each card carries a PeriodFacts payload — the structured data the intent
// registry (./intents.js) consumes to decide which sub-actions to surface
// and which programs to preselect.
//
// Used by Q1_What.jsx. Re-fetches on every Q1 mount; data changes day-to-day
// (deadlines drift, programs open/close) and caching across mounts hides that
// drift.
//
// All queries are organization-scoped. Runs under user auth + RLS — same
// posture as the existing catalog picker in Q1_What.jsx.
//
// Pure helpers (isLowEnrollment, hasRoomToFill, formatPeriodLabel,
// deriveCampTerm, computeTimeSignal, date utils) live in ./periodHelpers.js
// so the intent registry can be unit-tested without a Supabase client.

import { useEffect, useState } from "react";
import { supabase } from "../../../../lib/supabase.js";
import {
  computeTimeSignal,
  daysFromToday,
  deriveCampTerm,
  formatPeriodLabel,
  startOfToday,
  todayIso,
} from "./periodHelpers.js";

// Re-export the pure helpers so existing callers (Q1_What.jsx imports
// `isLowEnrollment` from this file) don't break.
export {
  isLowEnrollment,
  hasRoomToFill,
  formatPeriodLabel,
  deriveCampTerm,
} from "./periodHelpers.js";

// ---------- Public API ----------

export function usePeriodCards(orgId) {
  const [state, setState] = useState({ status: "loading", periods: [], error: null });
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setState({ status: "loading", periods: [], error: null });
    detectPeriods(orgId).then((result) => {
      if (!alive) return;
      setState(result);
    });
    return () => { alive = false; };
  }, [orgId]);
  return state;
}

// Pure-ish: takes orgId, returns { status, periods, error }. Exposed for
// callers that want to manage their own fetching (e.g., tests).
export async function detectPeriods(orgId) {
  try {
    const [progRes, campRes, regRes] = await Promise.all([
      // Programs join curricula for class_size_min/max — single source of truth
      // for low-enrollment + capacity-room intents. See
      // [[feedback-build-right-first-time]]. programs.max_capacity overrides
      // when set (existing column); falls back to curriculum's class_size_max.
      supabase
        .from("programs")
        .select("id, term, curriculum, curriculum_id, day_of_week, first_session_date, session_count, price_cents, early_bird_price_cents, early_bird_deadline, max_capacity, status, program_location_id, program_locations(name), curricula(class_size_min, class_size_max)")
        .eq("organization_id", orgId)
        .eq("status", "open")
        .gte("first_session_date", todayIso())
        .order("term")
        .order("first_session_date"),
      // Camps inherit class_size_min/max from curricula via curriculum_id
      // (camp_sessions has no min/max columns — by design; one source of truth
      // is the curriculum, not per-session).
      supabase
        .from("camp_sessions")
        .select("id, week_num, session_type, location_name, curriculum_name, curriculum_id, starts_on, ends_on, current_enrollment, status, curricula(class_size_min, class_size_max)")
        .eq("organization_id", orgId)
        .gte("starts_on", todayIso())
        .order("starts_on"),
      // Registrations across the org — used for confirmed-enrollment counts on
      // programs (low-enrollment intent). status='confirmed' filters out
      // cancellations/drafts. Paginated to handle 10k+ at scale.
      fetchAllRegistrations(orgId),
    ]);

    if (progRes.error) return { status: "error", periods: [], error: progRes.error };
    if (campRes.error) return { status: "error", periods: [], error: campRes.error };
    // Registration failure IS fatal — incomplete reg data poisons enrollment
    // counts. Surface the error rather than silently shipping wrong numbers.
    if (regRes?.error) return { status: "error", periods: [], error: regRes.error };

    const programRows = progRes.data ?? [];
    const campRows = campRes.data ?? [];
    const regs = regRes?.data ?? [];

    // Count confirmed registrations per program for low-enrollment math.
    const enrolledByProgram = new Map();
    for (const r of regs) {
      if (!r.program_id) continue;
      enrolledByProgram.set(r.program_id, (enrolledByProgram.get(r.program_id) ?? 0) + 1);
    }
    // Normalize each program: enrolled count + resolved size bounds.
    const programsWithFacts = programRows.map((p) => ({
      ...p,
      enrolled: enrolledByProgram.get(p.id) ?? 0,
      class_size_min: p.curricula?.class_size_min ?? null,
      // programs.max_capacity is the per-program override (always set today on
      // J2S); when null, fall back to the curriculum default.
      class_size_max: p.max_capacity ?? p.curricula?.class_size_max ?? null,
    }));
    // Camps already carry current_enrollment on the row (synced from Squarespace).
    const campsWithFacts = campRows.map((c) => ({
      ...c,
      class_size_min: c.curricula?.class_size_min ?? null,
      class_size_max: c.curricula?.class_size_max ?? null,
    }));

    const periods = [
      ...groupAfterSchool(programsWithFacts),
      ...groupCamps(campsWithFacts),
    ];

    return { status: "ready", periods, error: null };
  } catch (e) {
    return { status: "error", periods: [], error: e };
  }
}

// ---------- Grouping ----------

function groupAfterSchool(rows) {
  if (rows.length === 0) return [];
  const byTerm = new Map();
  for (const r of rows) {
    const term = r.term || "(no term)";
    if (!byTerm.has(term)) byTerm.set(term, []);
    byTerm.get(term).push(r);
  }
  const out = [];
  for (const [term, programs] of byTerm) {
    out.push(buildPeriod({ programType: "afterschool", term, programs, camps: [] }));
  }
  // Most urgent (soonest deadline) first.
  out.sort(comparePeriodsByUrgency);
  return out;
}

function groupCamps(rows) {
  if (rows.length === 0) return [];
  const byTerm = new Map();
  for (const r of rows) {
    const term = deriveCampTerm(r.starts_on);
    if (!byTerm.has(term)) byTerm.set(term, []);
    byTerm.get(term).push(r);
  }
  const out = [];
  for (const [term, camps] of byTerm) {
    out.push(buildPeriod({ programType: "camps", term, programs: [], camps }));
  }
  out.sort(comparePeriodsByUrgency);
  return out;
}

// ---------- Period assembly ----------

// Builds a single period card. Computes counts, time signal, and a
// PeriodFacts payload for the intent registry.
function buildPeriod({ programType, term, programs, camps }) {
  const today = startOfToday();
  const isAfterschool = programType === "afterschool";

  const programIds = programs.map((p) => p.id);
  const campIds = camps.map((c) => c.id);

  const schoolNames = isAfterschool
    ? [...new Set(programs.map((p) => p.program_locations?.name).filter(Boolean))]
    : [...new Set(camps.map((c) => c.location_name).filter(Boolean))];

  // Earliest active early-bird deadline (programs only; camps don't have EB).
  const activeEbDeadlines = isAfterschool
    ? programs
        .map((p) => p.early_bird_deadline)
        .filter((d) => d && d >= todayIso())
    : [];
  activeEbDeadlines.sort();
  const earliestActiveEarlyBird = activeEbDeadlines[0] ?? null;

  // Earliest first-session date in the period.
  const firstSessionDates = isAfterschool
    ? programs.map((p) => p.first_session_date).filter(Boolean).sort()
    : camps.map((c) => c.starts_on).filter(Boolean).sort();
  const earliestFirstSession = firstSessionDates[0] ?? null;
  const latestFirstSession = firstSessionDates[firstSessionDates.length - 1] ?? null;

  const daysUntilEarlyBird = earliestActiveEarlyBird ? daysFromToday(earliestActiveEarlyBird, today) : null;
  const daysUntilFirstSession = earliestFirstSession ? daysFromToday(earliestFirstSession, today) : null;

  const facts = {
    key: `${term}-${programType}`,
    term,
    programType,
    isAfterschool,
    programs,
    camps,
    programIds,
    campIds,
    schoolNames,
    earliestActiveEarlyBird,
    earliestFirstSession,
    latestFirstSession,
    daysUntilEarlyBird,
    daysUntilFirstSession,
  };

  return {
    key: facts.key,
    label: formatPeriodLabel(term, programType),
    programCount: programs.length,
    schoolCount: schoolNames.length,
    campCount: camps.length,
    timeSignal: computeTimeSignal(facts),
    facts,
  };
}

// Sort key: smallest non-null days-to-something first (most urgent).
function comparePeriodsByUrgency(a, b) {
  const ax = urgencyKey(a.facts);
  const bx = urgencyKey(b.facts);
  return ax - bx;
}
function urgencyKey(f) {
  const candidates = [f.daysUntilEarlyBird, f.daysUntilFirstSession].filter((x) => x != null);
  return candidates.length ? Math.min(...candidates) : Number.MAX_SAFE_INTEGER;
}

// Paginates through ALL confirmed registrations for an org. PostgREST caps
// .select() results at 1000 rows by default; J2S today is 273, but other
// tenants could ship with 10k+ from day one, so handle it from the start
// (see [[feedback-build-right-first-time]]). Mirrors the loop in
// supabase/functions/marketing-draft-campaign/index.ts#resolveParents.
//
// Errors are FATAL — silent partial-success was a bug ([[feedback-pressure
// -test-questions]] ship-checklist E: "every async load that can fail must
// surface the failure"). A mid-page failure poisons enrollment counts (low-
// enrollment intent + Q1 picker's "Low enrollment" chip both depend on
// completeness). Better to surface the error and let the operator retry than
// to ship wrong counts.
async function fetchAllRegistrations(orgId) {
  const PAGE = 1000;
  const all = [];
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabase
      .from("registrations")
      .select("program_id, camp_session_id, parent_id")
      .eq("organization_id", orgId)
      .eq("status", "confirmed")
      .range(off, off + PAGE - 1);
    if (error) return { data: null, error };
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    if (all.length >= 100_000) break; // sanity ceiling
  }
  return { data: all, error: null };
}
