// ONE rule for "who is covering this class-day", shared by the camp board
// (Schedule.jsx) and the after-school board (AfterschoolSchedule.jsx).
//
// WHY THIS MODULE EXISTS. Both boards used to index substitution rows straight
// into a map keyed by class-day, which is only correct while the database
// allows ONE offer per class-day. The first-come sub build lets an operator
// offer one day to several people at once, and at that point:
//   * the camp board's `map.set(key, row)` keeps whichever row happened to load
//     last, so the card names an arbitrary one of three candidates; and
//   * the after-school card lists all three as if three different people were
//     subbing the same class.
// Neither is a crash. Both are the board stating something untrue about who is
// covering a class, which is worse.
//
// The precedence below deliberately MIRRORS the get_sub_coverage RPC
// (migration 20260923b) that feeds the homescreen card and NeedsCoverBanner:
// somebody confirmed wins; otherwise offers still out; otherwise declines.
// The two live on different data paths (the boards already hold the rows; the
// banner asks the database), so they cannot be one query -- keeping the rule in
// one module on this side is what stops the two boards drifting from each other
// and from the server.

import { displayFullName } from './instructorName.js';

// Statuses a board surfaces at all. A declined offer leaves the regular
// instructor covering the day, so it is not drawn on the card.
export const SUB_ACTIVE_STATUSES = new Set(["pending", "confirmed", "taught"]);

export function subSlotKey(parentAssignmentId, date) {
  return `${parentAssignmentId}:${date}`;
}

// How many DIFFERENT PEOPLE are represented by these rows. Counting rows would
// be a proxy: re-offering the same day to the same person after they declined
// leaves two rows for one human, and every sentence built on this ("3 offers
// out", "2 people declined") is about people, not rows.
function distinctPeople(rows) {
  const ids = new Set();
  let unknown = 0;
  for (const r of rows) {
    if (r.sub_instructor_id) ids.add(r.sub_instructor_id);
    else unknown += 1;   // no id to dedupe on: count it as its own person
  }
  return ids.size + unknown;
}

// rows: assignment_substitutions rows for one class-day, any statuses.
// Returns the slot's single honest answer, or null when there are no rows.
//
// `sub` and `sub_instructor_id` are named after the row fields on purpose: a
// slot owned by exactly one person is drop-in compatible with the single row
// the callers used to hold. They are NULL when several offers are out, because
// there is no one person to name yet -- callers must render the count instead.
export function aggregateSubSlot(rows) {
  const all = rows ?? [];
  if (all.length === 0) return null;

  // A PERSON who turned the class down. Somebody auto-declined for LOSING a
  // first-come race carries decline_reason='covered_by_other' -- they said yes
  // and were closed out by somebody faster, so counting them here would report
  // a refusal that never happened. The RPC (migration 20260923b) filters the
  // same value; these two halves must agree or the card and the banner above it
  // will disagree about the same day.
  const declined = all.filter((r) => r.status === "declined"
    && r.decline_reason !== "covered_by_other");
  const declineCount = distinctPeople(declined);

  // A confirmed sub wins the day. 'taught' is the SAME person one step later,
  // but the single-winner index only guards 'confirmed', so a day can legally
  // hold both -- prefer 'confirmed' EXPLICITLY rather than taking whichever row
  // the database happened to return first. Neither board query orders its rows.
  const winner = all.find((r) => r.status === "confirmed")
    ?? all.find((r) => r.status === "taught")
    ?? null;
  if (winner) {
    // Offers that are still live ALONGSIDE a winner: the accept path declines
    // the siblings it can lock, so a skipped one stays pending. The day is
    // covered, but somebody is still holding an unanswered email and the card
    // has to be able to say so.
    const stillOut = distinctPeople(all.filter((r) => r.status === "pending"));
    return {
      status: winner.status,
      sub: winner.sub ?? null,
      sub_instructor_id: winner.sub_instructor_id ?? null,
      offersOut: stillOut,
      declineCount,
      rows: all,
    };
  }

  const pending = all.filter((r) => r.status === "pending");
  if (pending.length > 0) {
    const people = distinctPeople(pending);
    const only = people === 1 ? pending[0] : null;
    return {
      status: "pending",
      sub: only ? (only.sub ?? null) : null,
      sub_instructor_id: only ? (only.sub_instructor_id ?? null) : null,
      offersOut: people,
      declineCount,
      rows: all,
    };
  }

  // Everyone declined, or the day only holds a 'missed' row. Nothing is drawn
  // on the card (SUB_ACTIVE_STATUSES excludes both), but the slot is still
  // reported so callers that care about declines can see it -- a day everybody
  // turned down is exactly the day an operator must not be left guessing about.
  return {
    // `declined` here is REAL refusals only, so a day whose every row is an
    // auto-decline falls through to the first row's own status and draws
    // nothing -- correct: nobody refused it, and nobody is coming either, which
    // is a state only the winner's removal can produce and chunk 2 owns.
    status: declined.length > 0 ? "declined" : all[0].status,
    sub: null,
    sub_instructor_id: null,
    offersOut: 0,
    declineCount,
    rows: all,
  };
}

// rows: every substitution row a board loaded. Returns Map<"assignmentId:date", slot>.
export function aggregateSubOffers(rows) {
  const byKey = new Map();
  for (const r of rows ?? []) {
    if (!r?.parent_assignment_id || !r?.date) continue;
    const key = subSlotKey(r.parent_assignment_id, r.date);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }
  const out = new Map();
  for (const [key, group] of byKey) {
    const slot = aggregateSubSlot(group);
    if (slot) out.set(key, slot);
  }
  return out;
}

// The name a person reads off a sub row. ONE spelling, from the shared helper
// that already owns preferred-name handling -- the coverage RPC resolves names
// the same way, so a card and the banner above it must not call the same
// instructor two different things.
export function subDisplayName(sub) {
  return displayFullName(sub) || "Sub";
}

// The one thing a card says about a class-day's coverage.
//   text   - the subject: a person's name, or a count when there is no one
//            person to name yet
//   marker - the state, kept SEPARATE so a caller can pin it against
//            truncation; a clipped name is a nuisance, a clipped state marker
//            makes "covered" and "still waiting" look identical
//   tone   - 'confirmed' | 'pending' | 'uncovered'
// Returns null only when the day has nothing to say at all.
//
// Every branch has to be TRUE in the state that selects it: a name must never
// appear while several people are still deciding, and nothing may read as
// settled while a day still needs somebody.
export function subSlotLabel(slot) {
  // A declined or missed day draws no sub on the card -- the regular instructor
  // is still the one on the schedule. That the day NEEDS somebody is a separate
  // question, answered by slotNeedsCover() below, because a card that quietly
  // draws nothing is how an uncovered day hides in plain sight.
  if (!slot || !SUB_ACTIVE_STATUSES.has(slot.status)) return null;

  // The marker is PINNED against truncation by its callers, so it stays short.
  // Anything longer belongs in `note`, which a caller shows only where it has
  // the room -- a marker long enough to evict the name is the same defect as a
  // marker short enough to be clipped.
  if (slot.status === "confirmed" || slot.status === "taught") {
    return {
      text: subDisplayName(slot.sub),
      marker: "✓",
      // Covered, but somebody is still holding an unanswered offer.
      note: slot.offersOut > 0
        ? (slot.offersOut === 1 ? "1 still to answer" : `${slot.offersOut} still to answer`)
        : null,
      tone: "confirmed",
    };
  }

  if (slot.status === "pending") {
    // Somebody has already said no on this day and an offer is still out: the
    // day is AT RISK, not calmly waiting, and it must not read like a healthy
    // first offer. Mirrors the RPC's 'at_risk' state (migration 20260923b).
    const atRisk = slot.declineCount > 0;
    const who = slot.offersOut > 1
      ? `${slot.offersOut} people asked`
      : subDisplayName(slot.sub);
    return {
      text: who,
      marker: atRisk ? "· needs cover" : "· pending",
      note: atRisk
        ? (slot.declineCount === 1 ? "1 said no" : `${slot.declineCount} said no`)
        : null,
      tone: atRisk ? "uncovered" : "pending",
    };
  }

  return null;
}

// Does this class-day still need somebody? True when nobody is confirmed and at
// least one person has turned it down -- the state the card draws nothing for.
// Callers that summarise SEVERAL days (the after-school card's "N sub days")
// must consult this, or they report a class as settled on the strength of the
// days they can see while one of its days has nobody coming.
export function slotNeedsCover(slot) {
  if (!slot) return false;
  // Only an ACCEPTANCE clears a day. An unanswered offer does not: a day two
  // people have already refused is at risk whether or not a third is still
  // deciding, which is exactly the 'at_risk' state the RPC reports and the
  // regression this module had to have fixed in both halves, not one.
  if (slot.status === "confirmed" || slot.status === "taught") return false;
  return slot.declineCount > 0;
}

// The whole label as one string, for callers that cannot pin the marker
// separately. Keep the two halves defined in one place so they cannot drift.
export function subSlotLabelText(slot) {
  const label = subSlotLabel(slot);
  if (!label) return null;
  return `${label.text} ${label.marker}`.trim();
}
