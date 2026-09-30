// Which step of the scheduling cockpit to open on.
//
// WHY THIS IS ITS OWN FILE. It was three characters of logic inside a component
// (`steps.find(s => s.state === "active")`) and it cost Jessica two reports of
// the same thing: "the offers are stuck to fall and i don't see that pop up in
// winter" (2026-09-30). A rule that decides what an operator sees when they land
// on a screen deserves a test, and a test needs it out here.
//
// THE RULE. Open on the step with WORK WAITING. Fall back to the first step that
// is merely active, then to the first step at all.
//
// The fallback used to be the whole rule, and it is wrong for a camp term. The
// Availability step is "active" whenever no availability survey has been opened,
// and a camp term may legitimately never have one - camps are staffed by hand.
// So a term with offers ready to send opened on "send an availability survey",
// and the Send offers button was not merely hard to find, it was never rendered:
// one panel shows at a time, and it was not that one.
//
// WAITING ON SOMEONE ELSE IS NOT WORK WAITING. Responses still out, or offers
// sent and awaiting a reply, are states to watch, not things to do. Only the
// caller decides which steps carry hasWork; this file just honours it.
//
// ORDER IS THE BOARD'S ORDER, except that a higher workRank jumps the queue.
// The one thing that uses it today is offers READY TO SEND, and that is
// Jessica's call, 2026-09-30. I argued the other way first - sending an offer
// for one class while thirty are unstaffed books that instructor and makes
// every later addition a patch-send - and she overruled it by pointing at the
// term where she has actually done this work: "just do what we did for fall -
// it worked." A send that is ready to go is a finished decision waiting on one
// click; an unstaffed class is work that has not been done yet. Her board.
//
// Ties keep board order, so Draft still comes before Offers whenever Offers has
// work but nothing actually queued to send.

/**
 * @param {Array<{key: string, state?: string, hasWork?: boolean, workRank?: number}>} steps
 * @returns {string|undefined} the key of the step to focus
 */
export function pickFocusedStep(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const working = list.filter((s) => s?.state === "active" && s?.hasWork);
  if (working.length > 0) {
    // Strictly greater, so a tie keeps the FIRST one in board order.
    let best = working[0];
    for (const s of working) {
      if ((s.workRank ?? 0) > (best.workRank ?? 0)) best = s;
    }
    return best.key;
  }
  return list.find((s) => s?.state === "active")?.key ?? list[0]?.key;
}
