// Intent registry — the Q1 intents from docs/specs/family-comms-q1-intent-first.md.
//
// Each intent is a pure-function record:
//   - key:        stable identifier persisted in inputs.what.intent_key
//   - appliesTo:  given a period's facts, returns false OR an "applies"
//                 object carrying intent-specific data (matching items, etc.)
//   - buildButton: produces { label, subtitle, preselects } where preselects
//                  is an InputsPatch the reducer can apply in one shot.
//
// Operator picks an intent → reducer applies preselects → Q2-Q4 render with
// values pre-filled and operator clicks through to draft.
//
// Cross-sell intent removed 2026-06-02 (Jessica's call). The same goal is
// covered by Automations (kid-finishes-program → next-program-offer auto-fire);
// a one-shot manual cross-sell push was extra surface area without enough
// operator value to justify it. If a tenant wants to push cross-sell manually,
// they use the "Pick programs manually" picker.

import { isLowEnrollment, hasRoomToFill, formatPeriodLabel } from "./periodHelpers.js";

// ---------- Public API ----------

// Returns the visible, computed intents for a single period. Filters out
// intents whose appliesTo returns false. Each returned intent is a button:
// { key, label, subtitle, icon, preselects }.
export function getIntentsForPeriod(period, allPeriods = []) {
  const out = [];
  for (const intent of INTENTS) {
    const applies = intent.appliesTo(period.facts, allPeriods);
    if (!applies) continue;
    const button = intent.buildButton(period.facts, allPeriods, applies);
    if (!button) continue;
    out.push({ key: intent.key, ...button });
  }
  return out;
}

// ---------- Intent definitions ----------

export const INTENTS = [
  // 1. REGISTRATION JUST OPENED
  // Fires when reg is open and start date is 28-91 days out (4-13 weeks — wider
  // than the spec's "4-12 weeks" so FA26-today at 90 days still surfaces it,
  // matching the spec's own mockup).
  {
    key: "registration_opened",
    appliesTo(facts) {
      const d = facts.daysUntilFirstSession;
      if (d == null) return false;
      if (d < 28 || d > 91) return false;
      const items = allItems(facts);
      if (items.length === 0) return false;
      return { items };
    },
    buildButton(facts, _all, applies) {
      const ebActive = facts.earliestActiveEarlyBird != null;
      return {
        label: "Registration just opened",
        subtitle: subtitleForCount(applies.items.length, facts.isAfterschool),
        icon: "🎉",
        preselects: {
          what: pickAll(facts, "registration_opened"),
          who: autoFilter(),
          duration: "1 month",
          promo: ebActive ? { early_bird: true } : null,
        },
      };
    },
  },

  // 2. LAST CALL
  // Fires when an early-bird deadline ≤7 days OR a first-session date ≤14
  // days. Spec says: pick whichever's closer, and label shows which deadline
  // drove the choice.
  {
    key: "last_call",
    appliesTo(facts) {
      const ebSoon = facts.daysUntilEarlyBird != null && facts.daysUntilEarlyBird <= 7 && facts.daysUntilEarlyBird >= 0;
      const startSoon = facts.daysUntilFirstSession != null && facts.daysUntilFirstSession <= 14 && facts.daysUntilFirstSession >= 1;
      if (!ebSoon && !startSoon) return false;

      // Pick whichever deadline is closer. EB wins ties (per Jessica's confirm
      // — "the deadline you set first wins").
      const ebDays = ebSoon ? facts.daysUntilEarlyBird : Infinity;
      const startDays = startSoon ? facts.daysUntilFirstSession : Infinity;
      const driver = ebDays <= startDays ? "early_bird" : "start";

      // Programs that have the driving deadline active.
      const items = driver === "early_bird"
        ? allItems(facts).filter((it) =>
            it.early_bird_deadline && it.early_bird_deadline >= isoToday()
          )
        : allItems(facts).filter((it) =>
            firstSessionOf(it) && daysAhead(firstSessionOf(it)) <= 14 && daysAhead(firstSessionOf(it)) >= 1
          );
      if (items.length === 0) return false;
      const days = driver === "early_bird" ? ebDays : startDays;
      return { items, driver, days };
    },
    buildButton(facts, _all, applies) {
      const { driver, days, items } = applies;
      const label = driver === "early_bird"
        ? `Last ${days} day${days === 1 ? "" : "s"} for early-bird`
        : days === 1
          ? "Starts tomorrow — last call"
          : `Starts in ${days} days — last call`;
      // Custom duration: today through deadline (close-out window).
      const deadlineIso = driver === "early_bird"
        ? facts.earliestActiveEarlyBird
        : facts.earliestFirstSession;
      const duration = `custom: ${isoToday()} to ${deadlineIso}`;
      return {
        label,
        subtitle: subtitleForCount(items.length, facts.isAfterschool),
        icon: "🔥",
        preselects: {
          what: pickItems(facts, items, "last_call"),
          who: autoFilter(),
          duration,
          promo: driver === "early_bird" ? { early_bird: true } : null,
        },
      };
    },
  },

  // 3. FILL REMAINING SEATS
  // Fires when first-session is >21 days out (still time to recruit BEFORE
  // the term starts — not mid-term). Pre-selects programs/camps that still
  // have room (current < max). Label kept jargon-free per
  // [[feedback-no-tech-jargon]] and the 2026-06-02 rename ("mid-window
  // enrollment push" → "Fill remaining seats" — the original reads like
  // mid-term, which is wrong; students don't enrol mid-term).
  {
    key: "fill_remaining_seats",
    appliesTo(facts) {
      if (facts.daysUntilFirstSession == null) return false;
      if (facts.daysUntilFirstSession <= 21) return false;
      const items = allItems(facts).filter((it) => hasRoomToFill(it));
      if (items.length === 0) return false;
      return { items };
    },
    buildButton(facts, _all, applies) {
      return {
        label: "Fill remaining seats",
        subtitle: subtitleForCount(applies.items.length, facts.isAfterschool) + " still have room",
        icon: "📈",
        preselects: {
          what: pickItems(facts, applies.items, "fill_remaining_seats"),
          who: autoFilter(),
          duration: "2 weeks",
          promo: null,
        },
      };
    },
  },

  // 4. LOW-ENROLLMENT-ONLY PUSH
  // Fires when any program in the period is below its class_size_min. Pre-
  // selects only the low ones — focused copy lands harder than blasting the
  // whole period.
  {
    key: "low_enrollment_push",
    appliesTo(facts) {
      const items = allItems(facts).filter((it) => isLowEnrollment(it));
      if (items.length === 0) return false;
      return { items };
    },
    buildButton(facts, _all, applies) {
      const n = applies.items.length;
      // Duration: if start is within 14 days, custom-range to start; otherwise
      // a 2-week push.
      const duration = facts.daysUntilFirstSession != null && facts.daysUntilFirstSession <= 14
        ? `custom: ${isoToday()} to ${facts.earliestFirstSession}`
        : "2 weeks";
      return {
        label: `Low-enrollment-only push (${n})`,
        subtitle: `Focus on the ${n} ${facts.isAfterschool ? "program" : "session"}${n === 1 ? "" : "s"} below minimum`,
        icon: "🎯",
        preselects: {
          what: pickItems(facts, applies.items, "low_enrollment_push"),
          who: autoFilter(),
          duration,
          promo: null,
        },
      };
    },
  },

  // Cross-sell intent removed 2026-06-02. Same goal handled by Automations
  // (kid finishes program → auto-fired next-program offer); operators wanting
  // a one-shot manual cross-sell push use the catalog picker.
];

// ---------- "Something else" sub-intents (one-off notes) ----------
//
// These live on a separate card from the period cards (rendered by
// PeriodCards.jsx as a trailing card). All set mode='other' + a starter
// topic + intent_key so Ennie writes appropriate tone (urgent for schedule
// changes, warm for recaps, etc. — see Step 6 edge function rules).
//
// Spec note: scheduled recurring recaps (mid-term recap, last-day thank-you)
// live in Automations, NOT here. Photo gallery + ad-hoc recap belong here
// because they're operator-initiated one-offs.
//
// Audience: all default to filter.type='auto' which Q2's auto-derive resolves
// to master_list for mode='other' (operator can narrow in Q2). Future-friendly:
// schedule-change could default to "registered parents of affected program"
// once we have a program-picker in Q2 for mode='other'; queued.
//
// Free-form is special — `expandsPickerOnly: true` flag tells the click
// handler to open the picker on the 'other' tab without advancing, so the
// operator types their topic before moving on.

export const OTHER_INTENTS = [
  {
    key: "other_schedule_change",
    label: "Schedule change / cancellation",
    icon: "📅",
    subtitle: "Class moved, time shifted, or program update",
    preselects: {
      what: {
        mode: "other",
        program_ids: [],
        camp_session_ids: [],
        topics: ["Schedule change"],
        intent_key: "other_schedule_change",
      },
      who: { audience: "parents", filter: { type: "auto" }, exclude_already_registered: false },
    },
  },
  {
    key: "other_photo_gallery",
    label: "Photo gallery / one-time recap",
    icon: "📸",
    subtitle: "Share photos or a one-time recap moment",
    preselects: {
      what: {
        mode: "other",
        program_ids: [],
        camp_session_ids: [],
        topics: ["Photo gallery"],
        intent_key: "other_photo_gallery",
      },
      who: { audience: "parents", filter: { type: "auto" }, exclude_already_registered: false },
    },
  },
  {
    key: "other_partner_event",
    label: "Partner event invite",
    icon: "🎟️",
    subtitle: "Cross-promote a partner's event to your parents",
    preselects: {
      what: {
        mode: "other",
        program_ids: [],
        camp_session_ids: [],
        topics: ["Partner event"],
        intent_key: "other_partner_event",
      },
      who: { audience: "parents", filter: { type: "master_list" }, exclude_already_registered: false },
    },
  },
  {
    key: "other_free_form",
    label: "Free-form (you write the topic)",
    icon: "✍️",
    subtitle: "Open the picker and type your own",
    // Special: handled by Q1's click handler — opens the picker on 'other' tab
    // and does NOT advance to Q2 (operator types their topic first).
    expandsPickerOnly: true,
    preselects: {
      what: {
        mode: "other",
        program_ids: [],
        camp_session_ids: [],
        topics: [],
        intent_key: "other_free_form",
      },
    },
  },
];

export function getOtherIntents() {
  return OTHER_INTENTS;
}

// ---------- Helpers ----------

// Returns the period's programs OR camps, whichever applies.
function allItems(facts) {
  return facts.isAfterschool ? facts.programs : facts.camps;
}

function firstSessionOf(item) {
  return item.first_session_date ?? item.starts_on ?? null;
}

// inputs.what shape for "all items in the period."
function pickAll(facts, intentKey) {
  if (facts.isAfterschool) {
    return { mode: "programs", program_ids: facts.programIds, camp_session_ids: [], topics: [], intent_key: intentKey };
  }
  return { mode: "camps", program_ids: [], camp_session_ids: facts.campIds, topics: [], intent_key: intentKey };
}

// inputs.what shape for a subset of items (intent filtered them).
function pickItems(facts, items, intentKey) {
  const ids = items.map((it) => it.id);
  if (facts.isAfterschool) {
    return { mode: "programs", program_ids: ids, camp_session_ids: [], topics: [], intent_key: intentKey };
  }
  return { mode: "camps", program_ids: [], camp_session_ids: ids, topics: [], intent_key: intentKey };
}

// Default Q2 filter — Q2's auto-derive handles the rest (school-scope for
// programs, master-list for cross-period camps, etc.).
function autoFilter() {
  return { audience: "parents", filter: { type: "auto" }, exclude_already_registered: false };
}

// "12 programs across 11 schools" / "8 sessions across 4 locations"
function subtitleForCount(n, isAfterschool) {
  const noun = isAfterschool ? "program" : "session";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function daysAhead(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${iso}T00:00:00`);
  return Math.ceil((target.getTime() - today.getTime()) / 86400000);
}

// Re-export for convenience — callers that already have the period label
// don't need to re-import from periodDetection.js
export { formatPeriodLabel };
