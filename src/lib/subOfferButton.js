// What the send button in AssignSubModal promises, in one place.
//
// It lives here rather than inline in the modal because it is five branches of
// operator-facing copy and EVERY one of them has to be true in the state that
// selects it. "Resend" said to somebody who has never been emailed, or "Send
// offer" said when three people are already holding the day, is the same class
// of defect the sub reviews keep turning up: a sentence that describes a
// different situation from the one the operator is in.
//
// Pure and exported so the branches can be asserted directly. The modal owns
// the styling and the disabled state; this owns the words.

/**
 * @param {object} a
 * @param {string[]} a.selectedIds     people ticked in the picker
 * @param {(id:string)=>string} a.nameOf   short display name for an id
 * @param {number}  a.resendCount      how many of the SELECTED already hold a live, emailed offer
 * @param {number}  a.othersPending    people NOT selected who hold a live, emailed offer on this day
 * @param {boolean} a.sending          a send is in flight
 * @param {boolean} a.noDate           no class date chosen yet
 */
export function offerButtonLabel({ selectedIds, nameOf, resendCount, othersPending, sending, noDate }) {
  // Every state this button can be in is decided HERE, including the two that
  // used to be decided by the component: "sending" was shadowed by a ternary at
  // the button and "no date yet" was a separate check in the modal, so the
  // module that claims to own the copy owned only some of it.
  if (sending) return "Sending…";
  const n = (selectedIds ?? []).length;
  const resends = resendCount ?? 0;

  // Nobody ticked, or no day picked. The button is disabled in both, but it
  // still has to say something honest rather than naming an action it will not
  // perform.
  if (noDate || n === 0) return "Send offer";

  if (n === 1) {
    const who = nameOf(selectedIds[0]);
    // A resend is a DIFFERENT act from a first ask: the same person already has
    // this email. Saying "Send offer" would invite a second identical message.
    if (resends > 0) return `Resend to ${who}`;
    // Somebody else is already holding the day unanswered, so this ADDS a
    // candidate rather than replacing one. "Also" is the whole difference.
    if (othersPending > 0) return `Also ask ${who}`;
    return `Send offer to ${who}`;
  }

  // Several people. Never name one of them - naming implies they are the sub,
  // and the entire point is that nobody is yet.
  //
  // A RESEND CAN HIDE INSIDE A MULTI-SELECT, and that is the dangerous one.
  // Ticking Ann (already emailed yesterday) alongside Bo and Cy used to read
  // "Send offer to 3 people" - a first-ask sentence - because "is this a
  // resend?" was a yes/no that only existed when exactly one person was ticked.
  // Ann got a second identical email and nothing on screen ever said so.
  if (resends === n) return `Resend to ${n} people`;
  if (resends > 0) {
    const fresh = n - resends;
    return `Ask ${fresh} more, resend to ${resends}`;
  }
  return othersPending > 0
    ? `Also ask ${n} people`
    : `Send offer to ${n} people`;
}

/**
 * What just happened, for the success line. `asked` is the edge function's own
 * report of who it actually reached, not what we intended to send - a round can
 * stop partway, and the count the operator reads has to be the real one.
 */
export function offerSentMessage(asked) {
  const list = asked ?? [];
  if (list.length === 0) return "Nothing was sent.";
  if (list.length === 1) return `Offer sent to ${list[0].recipient}.`;
  return `Offer sent to ${list.length} people. The first to accept gets the day.`;
}
