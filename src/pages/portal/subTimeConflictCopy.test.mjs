// The sub-offer "time_conflict" refusal is one sentence shown from two places:
// respond-to-sub-offer returns it as `detail`, and the instructor portal falls
// back to its own copy when the response carries none. A Deno edge function
// cannot import from src/, so the sentence is spelled twice on purpose - this
// test is what keeps the two spellings one sentence. Wording approved by
// Jessica on 2026-10-21. The old sentence said "already covering another
// class", which was false whenever the clash was the sub's OWN class.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..", "..");
const SENTENCE = "This overlaps with another class on your schedule that day. Contact the office if that's wrong.";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

const portal = readFileSync(join(root, "src", "pages", "portal", "InstructorPortal.jsx"), "utf8");
const edge = readFileSync(join(root, "supabase", "functions", "respond-to-sub-offer", "index.ts"), "utf8");

check("portal fallback uses the approved sentence", portal.includes(`"${SENTENCE}"`));
check("edge fn detail uses the approved sentence", edge.includes(`detail: "${SENTENCE}"`));
check("portal no longer says 'already covering another class'", !/already covering another class/.test(portal));
check("edge fn detail no longer says 'already covering another class'", !/detail:.*already covering another class/.test(edge));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
