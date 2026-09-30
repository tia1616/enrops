// Pins which step the scheduling cockpit opens on. Only one step's panel renders
// at a time, so this decides whether the operator can see the Send offers button
// at all - which is how it went wrong: a camp term opened on "send an
// availability survey" and never rendered Offers.
import { strict as assert } from "node:assert";
import test from "node:test";
import { pickFocusedStep } from "./scheduleSteps.js";

// The five steps, in board order, as AfterschoolSchedule builds them.
const board = ({ survey, responses, draft, offers, confirmed }) => [
  { key: "survey", state: survey ?? "todo" },
  { key: "responses", state: responses ?? "todo" },
  { key: "draft", ...(draft ?? { state: "todo" }) },
  { key: "offers", ...(offers ?? { state: "todo" }) },
  { key: "confirmed", state: confirmed ?? "todo" },
];

test("THE CAMP TERM: offers are ready and no survey was ever sent -> Offers", () => {
  // Camps are staffed by hand, so a camp term may never have an availability
  // survey, which leaves that step "active" forever. Before hasWork it swallowed
  // the focus and the Send offers button was never rendered.
  const steps = board({
    survey: "active", // no survey opened, and none is coming
    draft: { state: "done" }, // the camp was assigned by hand and locked in
    offers: { state: "active", hasWork: true }, // 1 ready to send
  });
  assert.equal(pickFocusedStep(steps), "offers");
});

test("a change request waiting is work, even with offers already out", () => {
  const steps = board({
    survey: "done",
    responses: "done",
    draft: { state: "done" },
    offers: { state: "active", hasWork: true },
    confirmed: "active",
  });
  assert.equal(pickFocusedStep(steps), "offers");
});

test("DRAFT BEATS OFFERS when both have work - lock in, then send", () => {
  // Sending one offer while thirty classes are unstaffed books that instructor
  // and turns every later addition into a patch-send.
  const steps = board({
    survey: "done",
    responses: "done",
    draft: { state: "active", hasWork: true },
    offers: { state: "active", hasWork: true },
  });
  assert.equal(pickFocusedStep(steps), "draft");
});

test("waiting on other people is NOT work waiting", () => {
  // Responses still out and offers awaiting a reply are states to watch. With
  // nothing to do, the first active step wins as it always did.
  const steps = board({
    survey: "done",
    responses: "active", // some instructors have not replied
    draft: { state: "done" },
    offers: { state: "active", hasWork: false }, // all sent, awaiting replies
  });
  assert.equal(pickFocusedStep(steps), "responses");
});

test("a brand new term with nothing done opens on Availability", () => {
  assert.equal(pickFocusedStep(board({ survey: "active" })), "survey");
});

test("a finished term falls back to the first step rather than nothing", () => {
  const steps = board({ survey: "done", responses: "done", draft: { state: "done" }, offers: { state: "done" }, confirmed: "done" });
  assert.equal(pickFocusedStep(steps), "survey");
});

test("never throws on junk", () => {
  assert.equal(pickFocusedStep([]), undefined);
  assert.equal(pickFocusedStep(null), undefined);
  assert.equal(pickFocusedStep(undefined), undefined);
  assert.equal(pickFocusedStep([null, { key: "a", state: "active" }]), "a");
});
