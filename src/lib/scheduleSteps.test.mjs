// Pins which step the scheduling cockpit opens on. Only one step's panel renders
// at a time, so this decides whether the operator can see the Send offers button
// at all - which is how it went wrong twice: a camp term opened on "send an
// availability survey", and then on a staffing list, and never drew Offers.
//
// THE FIXTURE MIRRORS THE REAL STEPS, workRank included. A first version of this
// file left workRank off, so every step tied at 0 and the "draft beats offers"
// case passed by accident - it was pinning board order, not the rule under test,
// and it went on passing after the rule changed. If AfterschoolSchedule's
// cockpitSteps grows a field that decides focus, it belongs here too.
import { strict as assert } from "node:assert";
import test from "node:test";
import { pickFocusedStep } from "./scheduleSteps.js";

// The five steps exactly as AfterschoolSchedule builds them, from the counts
// that decide each one. Keeping the counts as the input, rather than hand-built
// step objects, is what stops this file drifting from the board.
function board({ surveyOpened = false, allResponded = false, needsHire = 0, proposed = 0, sendable = 0, changeRequested = 0, awaitingReply = 0, accepted = 0 } = {}) {
  const hasDraft = proposed + sendable + awaitingReply + accepted + changeRequested > 0;
  const offersOut = awaitingReply > 0 || accepted > 0;
  return [
    { key: "survey", state: surveyOpened ? "done" : "active" },
    { key: "responses", state: !surveyOpened ? "todo" : (allResponded ? "done" : "active") },
    {
      key: "draft",
      state: (!hasDraft && needsHire === 0) ? "todo" : (needsHire > 0 || proposed > 0) ? "active" : "done",
      hasWork: needsHire > 0 || proposed > 0,
      workRank: 1,
    },
    {
      key: "offers",
      state: (!offersOut && sendable === 0) ? "todo" : (sendable > 0 || awaitingReply > 0 || changeRequested > 0) ? "active" : "done",
      hasWork: sendable > 0 || changeRequested > 0,
      workRank: sendable > 0 ? 2 : 1,
    },
    { key: "confirmed", state: offersOut ? "active" : "todo" },
  ];
}

test("THE CAMP TERM: offers ready and no survey ever sent -> Offers", () => {
  // Camps are staffed by hand, so a camp term may never have an availability
  // survey, which leaves that step "active" forever. It used to swallow the
  // focus and the Send offers button was never rendered.
  assert.equal(pickFocusedStep(board({ surveyOpened: false, sendable: 1 })), "offers");
});

test("JESSICA'S CALL: a queued send outranks a staffing list", () => {
  // The real Winter 2027 shape, and the reason this rule exists: 31 classes
  // still need an instructor AND one camp offer is queued. Opening on Draft
  // hides the button she came for. 2026-09-30: "just do what we did for fall -
  // it worked."
  assert.equal(pickFocusedStep(board({ needsHire: 31, sendable: 1 })), "offers");
});

test("a change request alone does NOT jump the draft", () => {
  // Rank 1, same as Draft, so board order decides. A reply to handle is not a
  // send sitting queued.
  const steps = board({ surveyOpened: true, allResponded: true, needsHire: 4, changeRequested: 2, awaitingReply: 3 });
  assert.equal(pickFocusedStep(steps), "draft");
});

test("a change request wins when there is no draft work", () => {
  const steps = board({ surveyOpened: true, allResponded: true, changeRequested: 1, awaitingReply: 3 });
  assert.equal(pickFocusedStep(steps), "offers");
});

test("waiting on other people is NOT work waiting", () => {
  // Responses still out and offers awaiting a reply are states to watch. With
  // nothing to do, the first active step wins as it always did.
  const steps = board({ surveyOpened: true, allResponded: false, awaitingReply: 5 });
  assert.equal(pickFocusedStep(steps), "responses");
});

test("a brand new term with nothing done opens on Availability", () => {
  assert.equal(pickFocusedStep(board()), "survey");
});

test("a finished term falls back to the first step rather than nothing", () => {
  const steps = board({ surveyOpened: true, allResponded: true, accepted: 6 })
    .map((s) => ({ ...s, state: s.key === "confirmed" ? "done" : s.state }));
  assert.equal(pickFocusedStep(steps), "survey");
});

test("ties keep board order", () => {
  // Two steps at the same rank must not reorder on the strength of array
  // position inside the filter. Draft is earlier on the board, so Draft wins.
  const steps = [
    { key: "draft", state: "active", hasWork: true, workRank: 1 },
    { key: "offers", state: "active", hasWork: true, workRank: 1 },
  ];
  assert.equal(pickFocusedStep(steps), "draft");
});

test("never throws on junk", () => {
  assert.equal(pickFocusedStep([]), undefined);
  assert.equal(pickFocusedStep(null), undefined);
  assert.equal(pickFocusedStep(undefined), undefined);
  assert.equal(pickFocusedStep([null, { key: "a", state: "active" }]), "a");
});
