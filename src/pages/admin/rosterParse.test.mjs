// Portable regression tests for the roster-file parser. Pure — inline fixtures,
// no external files or deps. Run: `node src/pages/admin/rosterParse.test.mjs`
// (fixtures mirror the two real vendor exports this parser was built for: an
// FGO/Sawyer "Roster Report" CSV with a title row above the header, and an
// extended-day XLSX that repeats a stacked header band per camp with a
// before/after-care day grid.)
import {
  parseCsvRows, parseSheet, buildRegistrants, splitName, detectStructure,
} from "./rosterParse.js";

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}
const nameOf = (r) => [r.student_first_name, r.student_last_name];

// ---- splitName ---------------------------------------------------------------
eq("splitName First Last", splitName("Liam Fullerton"), { first: "Liam", last: "Fullerton" });
eq("splitName Last, First", splitName("Dussel, Oliver"), { first: "Oliver", last: "Dussel" });
eq("splitName compound Last, First", splitName("Van Wie, Charlotte"), { first: "Charlotte", last: "Van Wie" });
eq("splitName suffix not swapped", splitName("John Smith, Jr."), { first: "John", last: "Smith Jr." });
eq("splitName trailing suffix", splitName("John Smith Jr"), { first: "John", last: "Smith Jr" });
eq("splitName single token", splitName("Cher"), { first: "Cher", last: "" });
eq("splitName middle name", splitName("Mary Anne Smith"), { first: "Mary Anne", last: "Smith" });

// ---- FGO/Sawyer shape: title row above header, trailing junk -----------------
{
  const csv = [
    `"Coding Camps - Minecraft Makers"`,
    `Name,Age,Gender,Parent,"Phone 1",Email,Accommodations,"Emergency Contacts /Authorized Pick Up",Medication`,
    `"Jake Hartley",7,Male,"Jessica Hartley",503-680-0373,jh@example.com,No,"Jesse Hartley (503)830-5626`,
    `(503)680-0373",No`,
    `"Aislynn Van Wie",12,Non-binary,"Matthew Van Wie",503-425-9144,vw@example.com,Gluten,"Celestial Van Wie",No`,
    `" "`,
    ``,
  ].join("\n");
  const { headers, data, mapping, multi } = parseSheet(parseCsvRows(csv));
  const regs = buildRegistrants(data, headers, mapping);
  eq("FGO not grouped", multi, false);
  eq("FGO kid count (title + junk stripped)", regs.length, 2);
  eq("FGO row1 name", nameOf(regs[0]), ["Jake", "Hartley"]);
  eq("FGO name col mapped", mapping.student_full_name, "Name");
  eq("FGO phone1 mapped", mapping.parent_phone, "Phone 1");
  eq("FGO medication mapped", mapping.medications_at_program, "Medication");
  eq("FGO pickup multiline preserved", /Jesse Hartley/.test(regs[0].authorized_pickup_contacts || ""), true);
}

// ---- Extended-day shape: stacked header + repeated groups + day grid ---------
{
  const band = [
    ["", "", "Parents", "P1 Cell", "", "P1 Email", "", "MON", "TUE"], // labels split across
    ["Camper's Name", "", "", "", "", "", "", "", ""],                 //   three stacked rows
    ["", "AGE", "", "", "", "", "", "MON", "TUE"],
  ];
  const kid = (n, age, par, cell, email) => [n, age, par, cell, "", email, "", "X", "X"];
  const aoa = [
    ["Before and After care Roster"],
    ["Week 1 (July 6-10)"],
    ["Summer Beehive"],                                    // camp/section title
    ...band,
    kid("Dussel, Oliver", "5.7", "Adrienne and John Dussel", "+1 516-532-7678", "ab@example.com"),
    kid("Greenblatt, Jack", "5.2", "Rachel Greenblatt", "+1 310-562-8049", "rg@example.com"),
    ["Before and After care Roster"],
    ["Week 1 (July 6-10)"],
    ["Eagle Adventure"],                                   // second group
    ...band,
    kid("Goel, Kiara", "7.3", "Divya and Mohit Goel", "+1 555-000-1111", "dg@example.com"),
    ["1/"], ["15"],                                        // trailing junk
  ];
  const { headers, data, mapping, multi } = parseSheet(aoa);
  const regs = buildRegistrants(data, headers, mapping);
  eq("XD grouped detected", multi, true);
  eq("XD name col mapped", mapping.student_full_name, "Camper's Name");
  eq("XD blank col synthesized addressable", headers[1], "Column B");
  eq("XD kid count across groups (titles/junk stripped)", regs.length, 3);
  eq("XD Last,First", nameOf(regs[0]), ["Oliver", "Dussel"]);
  eq("XD later group kid", nameOf(regs[2]), ["Kiara", "Goel"]);
  eq("XD no title leaked", regs.some((r) => /roster|week|beehive|eagle/i.test(`${r.student_first_name} ${r.student_last_name}`)), false);
}

// ---- Regression: a data row valued "Parent" must NOT merge into the header ----
{
  const aoa = [
    ["First Name", "Last Name", "Relationship", "Email"],
    ["Ana", "Reyes", "Parent", "ana@example.com"],  // "Parent" is a known alias word
    ["Ben", "Cole", "Guardian", "ben@example.com"],
  ];
  const { headers, dataRows, multi } = detectStructure(aoa);
  eq("relationship-value not grouped", multi, false);
  eq("header row not extended into data", headers[0], "First Name");
  const { data } = parseSheet(aoa);
  eq("both data rows kept", data.length, 2);
}

// ---- Regression: name-only file stays lenient (not grouped) -------------------
{
  const aoa = [["Name"], ["Kid One"], ["Kid Two"], ["Kid Three"]];
  const { data, multi } = parseSheet(aoa);
  eq("name-only not grouped", multi, false);
  eq("name-only keeps all", data.length, 3);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAIL"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
