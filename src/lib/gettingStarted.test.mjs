// Pins every state of the Getting started card's logic, and that its stage 1
// labels really come from the guide.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageOneItems, nextStageLine, addDays, isPublished } from "./gettingStarted.js";
import { parseGuide } from "./guideParse.js";

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const here = fileURLToPath(new URL(".", import.meta.url));
const g1 = parseGuide(readFileSync(join(here, "..", "content", "guides", "1-get-your-link.md"), "utf8"), "1-get-your-link.md");
const ids = g1.checklist.map((c) => c.id).join();
ok(ids === "first-program,connect-stripe,share-link", "stage 1 checklist read from the guide", `got ${ids}`);
ok(g1.checklist.every((c) => c.label && c.label.length > 0), "every checklist item has a label");
ok(g1.checklist.every((c) => g1.sections.some((s) => s.id === c.id)), "every checklist id is a heading the card can link to");

// --- stage 1 ----------------------------------------------------------------
const none = stageOneItems(g1.checklist, { hasProgram: false, chargesOn: false, hasPublished: false });
ok(none.every((i) => !i.done), "brand new org: nothing ticked");
const draftOnly = stageOneItems(g1.checklist, { hasProgram: true, chargesOn: false, hasPublished: false });
ok(draftOnly.map((i) => i.done).join() === "true,false,false", "a draft ticks only the first item");
const pubNoStripe = stageOneItems(g1.checklist, { hasProgram: true, chargesOn: false, hasPublished: true });
ok(pubNoStripe[2].done === false, "published without Stripe is NOT shareable, so item 3 stays open");
const all = stageOneItems(g1.checklist, { hasProgram: true, chargesOn: true, hasPublished: true });
ok(all.every((i) => i.done), "all three done");
ok(stageOneItems([{ id: "mystery", label: "x" }], { hasProgram: true, chargesOn: true, hasPublished: true })[0].done === false, "an unknown item is never ticked");

ok(isPublished({ status: "closed" }) && isPublished({ status: "open" }), "open and closed count as published");
ok(!isPublished({ status: "draft" }) && !isPublished({ status: "cancelled" }), "draft and cancelled do not");

// --- follow-up line ---------------------------------------------------------
const today = "2026-11-19";
ok(addDays("2026-12-25", 14) === "2027-01-08", "addDays crosses a year");
ok(nextStageLine({ stageOneDone: false, today }) === null, "no line while stage 1 is open");
ok(nextStageLine({ stageOneDone: true, today }).stage === 2, "stage 1 done, nothing else: stages 2 and 3");

const soon = nextStageLine({ stageOneDone: true, today, orgPrograms: [{ status: "open", first_session_date: "2026-12-01" }] });
ok(soon.stage === 4 && soon.firstDate === "2026-12-01", "a class starting in 12 days: stage 4");
ok(nextStageLine({ stageOneDone: true, today, orgPrograms: [{ status: "open", first_session_date: "2026-12-04" }] }).stage === 2, "15 days out is not yet stage 4");
ok(nextStageLine({ stageOneDone: true, today, orgPrograms: [{ status: "draft", first_session_date: "2026-11-25" }] }).stage === 2, "a draft starting soon does not trigger stage 4");
ok(nextStageLine({ stageOneDone: true, today, orgPrograms: [{ status: "open", first_session_date: "2026-11-01" }] }).stage === 2, "a class that already started is not stage 4");
ok(nextStageLine({ stageOneDone: true, today, orgPrograms: [{ status: "open", first_session_date: today }] }).stage === 4, "starting today is still stage 4");

const ended = {
  stageOneDone: true, today, term: "FA26",
  termPrograms: [{ id: "a", status: "open" }, { id: "b", status: "open" }],
  datesByProgram: {
    a: [{ date: "2026-09-10", kind: "session" }, { date: "2026-11-12", kind: "session" }],
    b: [{ date: "2026-11-18", kind: "session" }, { date: "2026-11-26", kind: "no_school" }],
  },
};
const six = nextStageLine(ended);
ok(six.stage === 6 && six.key === "stage6-FA26", "every class's last session is past: stage 6 for that term");
ok(nextStageLine({ ...ended, datesByProgram: { ...ended.datesByProgram, b: [{ date: "2026-11-19", kind: "session" }] } }).stage !== 6, "a class meeting today keeps the term running");
ok(nextStageLine({ ...ended, termPrograms: [], datesByProgram: {} }).stage === 2, "no classes in the term is not 'the term ended'");
ok(nextStageLine({ ...ended, termPrograms: [{ id: "a", status: "draft" }] }).stage === 2, "drafts never end a term");
const both = nextStageLine({ ...ended, orgPrograms: [{ status: "open", first_session_date: "2026-11-25" }] });
ok(both.stage === 6, "stage 6 outranks stage 4, one line at a time");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
