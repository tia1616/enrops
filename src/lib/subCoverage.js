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
// (migration 20260923a) that feeds the homescreen card and NeedsCoverBanner:
// somebody confirmed wins; otherwise offers still out; otherwise declines.
// The two live on different data paths (the boards already hold the rows; the
// banner asks the database), so they cannot be one query -- keeping the rule in
// one module on this side is what stops the two boards drifting from each other
// and from the server.

// Statuses a board surfaces at all. A declined offer leaves the regular
// instructor covering the day, so it is not drawn on the card.
export const SUB_ACTIVE_STATUSES = new Set(["pending", "confirmed", "taught"]);

export function subSlotKey(parentAssignmentId, date) {
  return `${parentAssignmentId}:${date}`;
}

// rows: assignment_substitutions rows for one class-day, any statuses.
// Returns the slot's single honest answer, or null when the day has nothing to
// show (no rows, or only declined/missed ones).
//
// `sub` and `sub_instructor_id` are named after the row fields on purpose: a
// slot owned by exactly one person is drop-in compatible with the single row
// the callers used to hold. They are NULL when several offers are out, because
// there is no one person to name yet -- callers must render the count instead.
export function aggregateSubSlot(rows) {
  const all = rows ?? [];
  if (all.length === 0) return null;

  const winner = all.find((r) => r.status === "confirmed" || r.status === "taught");
  if (winner) {
    return {
      status: winner.status,
      sub: winner.sub ?? null,
      sub_instructor_id: winner.sub_instructor_id ?? null,
      offersOut: 0,
      rows: all,
    };
  }

  const pending = all.filter((r) => r.status === "pending");
  if (pending.length > 0) {
    const only = pending.length === 1 ? pending[0] : null;
    return {
      status: "pending",
      sub: only ? (only.sub ?? null) : null,
      sub_instructor_id: only ? (only.sub_instructor_id ?? null) : null,
      offersOut: pending.length,
      rows: all,
    };
  }

  // Everyone declined, or the day only holds a 'missed' row. Nothing is drawn
  // on the card (SUB_ACTIVE_STATUSES excludes both), but the slot is still
  // reported so callers that care about declines can see it.
  return {
    status: all.find((r) => r.status === "declined") ? "declined" : all[0].status,
    sub: null,
    sub_instructor_id: null,
    offersOut: 0,
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

// The name a person reads off a sub row. Kept here so both boards spell it the
// same way.
export function subDisplayName(sub) {
  if (!sub) return "Sub";
  const name = [sub.first_name, sub.last_name].filter(Boolean).join(" ").trim();
  return name || "Sub";
}

// The one sentence a card shows for a class-day's coverage.
// Returns null when the day has nothing to say (declined / missed / no rows) so
// callers keep their own "+ Sub day" affordance for that case.
//
// Every branch has to be TRUE in the state that selects it: "3 offers out"
// must never appear once somebody has accepted, and a name must never appear
// while three people are still deciding.
export function subSlotLabel(slot) {
  if (!slot || !SUB_ACTIVE_STATUSES.has(slot.status)) return null;
  if (slot.status === "confirmed" || slot.status === "taught") {
    return { text: `${subDisplayName(slot.sub)} ✓`, tone: "confirmed" };
  }
  if (slot.offersOut > 1) {
    return { text: `${slot.offersOut} offers out`, tone: "pending" };
  }
  return { text: `${subDisplayName(slot.sub)} · pending`, tone: "pending" };
}
