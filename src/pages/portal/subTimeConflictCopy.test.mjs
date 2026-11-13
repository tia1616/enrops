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

// too_close (20261113b): accept_sub_offer returns it for a sub day too close to
// another school. If the edge fn stops handling it, the accept falls through to
// "unrecognised accept outcome" and the instructor sees a generic 500.
const migration = readFileSync(join(root, "supabase", "migrations", "20261113b_sub_travel_time_between_sites.sql"), "utf8");
const modal = readFileSync(join(root, "src", "pages", "admin", "AssignSubModal.jsx"), "utf8");
check("accept_sub_offer can return too_close", /'outcome', 'too_close'/.test(migration));
check("edge fn handles the too_close outcome", edge.includes("result.outcome === 'too_close'"));
check("edge fn answers too_close with the time_conflict code the portal explains", /too_close'\) \{[\s\S]{0,900}error: 'time_conflict'/.test(edge));
check("picker labels the too_close reason", /too_close:\s*'/.test(modal));
check("picker cannot tick a too_close person", /working_reason === 'too_close'/.test(modal) && /!!instr\.email && !tooClose/.test(modal));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
