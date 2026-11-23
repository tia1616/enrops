// Pins the one "which seasons are on sale" rule (classSeasons.js), and that it
// orders seasons the same way as SQL term_for_date / term_ordinal (20261123d).
import { termOrdinal, nextTerm, onSaleTerms, isTermOnSale, classTermFor, isPastTerm } from "./classSeasons.js";

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// Same numbers the staging SQL returned for term_ordinal (FA26 107, WI27 108, SP27 109).
eq(termOrdinal("FA26"), 107, "ordinal matches SQL: FA26");
eq(termOrdinal("WI27"), 108, "ordinal matches SQL: WI27");
eq(termOrdinal("SP27"), 109, "ordinal matches SQL: SP27");
eq(termOrdinal("junk"), null, "non-season code has no ordinal");
eq(nextTerm("FA26"), "WI27", "Fall 2026 is followed by Winter 2027");
eq(nextTerm("SU27"), "FA27", "Summer is followed by Fall of the same year");

const dates = { classes_follow_dates: true, active_registration_term: "FA26" };
const manual = { classes_follow_dates: false, active_registration_term: "WI27" };

eq(onSaleTerms(dates), ["FA26", "WI27", "SP27", "SU27"], "a date-following org sells the open season and three after");
eq(onSaleTerms(manual), ["WI27"], "a season-switching org sells only its open season (unchanged)");
eq(onSaleTerms({ classes_follow_dates: true }), [], "no open season = nothing on sale");
ok(isTermOnSale(dates, "WI27"), "a January class is on sale in November for a date-following org");
ok(!isTermOnSale(manual, "FA26"), "a season-switching org's old season stays off sale");
ok(!isTermOnSale(dates, null), "a class with no season is not on sale");

// THE BUG: Branching Minds' January classes were filed under Fall.
eq(classTermFor(dates, "2027-01-05"), "WI27", "a class starting Jan 5 is filed under Winter 2027");
eq(classTermFor(dates, "2026-11-30"), "FA26", "a class starting Nov 30 is filed under Fall 2026");
eq(classTermFor(dates, "2026-12-01"), "WI27", "December belongs to the next Winter");
eq(classTermFor(dates, "2026-09-17"), "FA26", "a September class stays Fall when re-saved later (no clamp to the open season)");
eq(classTermFor({ classes_follow_dates: true, active_registration_term: "WI27" }, "2026-09-17"), "FA26",
  "editing a Fall class in Winter does NOT move it into Winter");
eq(classTermFor(dates, null), "FA26", "no first day yet falls back to the open season");
eq(classTermFor(manual, "2027-04-01"), "WI27", "a season-switching org files under its open season (unchanged)");

ok(isPastTerm(dates, "SU26"), "an earlier season is past");
ok(!isPastTerm(dates, "WI27"), "a LATER season is never past");
ok(!isPastTerm(dates, "FA26"), "the open season is not past");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
