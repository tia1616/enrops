// The sentences an operator reads on the LAST screen before a roster action that
// cannot be quietly undone: moving a child, refunding or removing them.
//
// WHY THIS EXISTS (Jessica, 2026-10-27, after two misfires on 10/21): Micah Cho was
// cancelled instead of Sahir Wanchoo, in the same class two minutes apart, and a
// refund went out of money she meant to keep. The drawer named the child at the TOP
// and the money on the BUTTON, and nothing at the button named the class or the
// site. So every confirm now says, in one sentence beside the button: WHO, WHICH
// CLASS (day, name, site), and WHAT HAPPENS TO THE MONEY.
//
// Pure functions, pinned by rosterActions.test.mjs.

const fmt = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;

// "Tuesday Minecraft Makers at Jackson Elementary". Twin of classLabel in
// supabase/functions/admin-move-registration/index.ts, which writes the same words
// into the registration's note - keep the two in step.
export function rosterClassLabel({ curriculum, day_of_week, class_days, site } = {}) {
  const isCamp = Array.isArray(class_days) && class_days.length > 0;
  const day = !isCamp && day_of_week
    ? String(day_of_week).charAt(0).toUpperCase() + String(day_of_week).slice(1).toLowerCase() + " "
    : "";
  const name = String(curriculum ?? "").trim() || "this class";
  const where = String(site ?? "").trim();
  return `${day}${name}${where ? ` at ${where}` : ""}`;
}

/**
 * The refund drawer's confirm sentence, for whichever outcome is selected.
 * Returns "" when no outcome is chosen yet, so nothing half-true is shown.
 *
 * mode: 'refund' | 'credit' | 'credit_return' | 'withdraw_no_refund'
 * withdraw: does this action take them off the roster
 */
export function refundConfirmSentence({ studentName, classLabel, mode, amountCents, withdraw }) {
  const who = String(studentName ?? "").trim() || "this child";
  const cls = String(classLabel ?? "").trim() || "this class";
  switch (mode) {
    case "withdraw_no_refund":
      return `Take ${who} out of ${cls}. No money goes back to the family.`;
    case "credit":
      return `Take ${who} out of ${cls} and give the family ${fmt(amountCents)} of credit. No money leaves your Stripe balance.`;
    case "credit_return":
      if (withdraw === true) return `Take ${who} out of ${cls} and put ${fmt(amountCents)} back on the family's credit.`;
      if (withdraw === false) return `Put ${fmt(amountCents)} back on the family's credit for ${cls}. ${who} keeps their spot.`;
      return "";
    case "refund":
      if (withdraw === true) return `Refund ${fmt(amountCents)} to the family's card and take ${who} out of ${cls}.`;
      if (withdraw === false) return `Refund ${fmt(amountCents)} to the family's card for ${cls}. ${who} keeps their spot.`;
      return "";
    default:
      return "";
  }
}

/**
 * The move panel's confirm sentence. No money ever moves on a move (Jessica,
 * 2026-11-25), so the money clause says what they PAID against what the new class
 * COSTS, only when the two differ - a difference is the operator's to settle.
 */
export function moveConfirmSentence({ studentName, fromLabel, toLabel, paidCents, toPriceCents }) {
  const who = String(studentName ?? "").trim() || "this child";
  const base = `Move ${who} from ${fromLabel || "their class"} to ${toLabel || "the new class"}.`;
  const paid = Number.isFinite(Number(paidCents)) && paidCents != null ? Number(paidCents) : null;
  const price = Number.isFinite(Number(toPriceCents)) && toPriceCents != null ? Number(toPriceCents) : null;
  if (paid != null && price != null && paid !== price) {
    return `${base} No money moves: they paid ${fmt(paid)} and the new class is ${fmt(price)}.`;
  }
  return `${base} No money moves.`;
}

/** "3 spots left" / "1 spot left" / "Full (14 of 14)" / "" when uncapped. */
export function seatLabel({ max_capacity, seats_taken, is_full }) {
  const cap = Number(max_capacity) || 0;
  if (cap <= 0) return "";
  const taken = Number(seats_taken) || 0;
  if (is_full || taken >= cap) return `Full (${taken} of ${cap})`;
  const left = cap - taken;
  return `${left} ${left === 1 ? "spot" : "spots"} left`;
}
