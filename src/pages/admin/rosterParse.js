// src/pages/admin/rosterParse.js
// Pure, framework-free roster-file parsing shared by the roster upload modal
// (Rosters.jsx) and its Node test harness (rosterParse.test.mjs). Everything
// here operates on plain strings / arrays so it can be unit-tested against real
// vendor export files without a browser.
//
// The job: take a messy CSV / Excel export from *any* camp-management system and
// turn it into a clean list of registrants (kids + their parent/contact info).
// Real exports are rarely a tidy "headers on row 1, data below" table:
//   - A report title sits on row 1 and the real headers are on row 2+
//     (e.g. FGO / Sawyer "Roster Report").
//   - Headers are split across several stacked rows because of merged cells
//     (e.g. a "Parents" / "P1 Cell" / "P1 Email" band above a "Camper's Name"
//     row above an "AGE" row).
//   - The file is a *pivoted attendance report* that repeats the whole header
//     band once per camp/room, with camp-title rows and blank spacer rows in
//     between, and trailing junk (page numbers, export timestamps) at the end.
//   - Names come "Last, First" instead of "First Last".
// detectStructure + filterDataRows handle all of that; buildRegistrants maps the
// surviving rows onto Enrops fields.

// Column-name auto-mapping. Keys are normalized header (lowercase, no
// non-alpha), values are the target field name. First match wins. Aliases
// cover common Squarespace + Google Forms + spreadsheet + camp-management
// (FGO/Sawyer, extended-day reports, RecTrac/ActiveNet) header variants.
export const FIELD_DEFS = [
  { key: "student_first_name", label: "Camper first name", required: true,
    aliases: ["camperfirstname", "studentfirstname", "childfirstname", "firstname", "first"] },
  { key: "student_last_name", label: "Camper last name", required: false,
    aliases: ["camperlastname", "studentlastname", "childlastname", "lastname", "last", "surname"] },
  // Single full-name column ("participant name", "camper name") — split into
  // first/last at import time. Common in Squarespace / hand-built rosters and
  // camp-management exports. "campersname" = extended-day report; bare "name" =
  // FGO/Sawyer roster report.
  { key: "student_full_name", label: "Camper full name", required: false,
    aliases: ["participantname", "participant", "campername", "campersname", "camper", "studentname",
      "studentfullname", "childname", "childfullname", "kidname", "attendeename", "fullname", "name"] },
  { key: "grade", label: "Grade", required: false,
    aliases: ["grade", "gradelevel", "currentgrade", "school grade"] },
  { key: "birthdate", label: "Birthdate", required: false,
    aliases: ["birthdate", "dob", "dateofbirth", "birthday"] },
  { key: "pronouns", label: "Pronouns", required: false,
    aliases: ["pronouns"] },
  { key: "allergies", label: "Allergies", required: false,
    aliases: ["allergies", "allergy", "foodallergies"] },
  { key: "dietary_restrictions", label: "Dietary restrictions", required: false,
    aliases: ["dietary", "dietaryrestrictions", "dietneeds", "foodrestrictions"] },
  { key: "medical_notes", label: "Medical notes", required: false,
    aliases: ["medicalnotes", "medicalinfo", "medicalconcerns", "healthnotes", "health", "concerns"] },
  { key: "medical_conditions", label: "Medical conditions", required: false,
    aliases: ["medicalconditions"] },
  { key: "epipen_required", label: "EpiPen required (Y/N)", required: false,
    aliases: ["epipen", "epipenrequired", "carriesepipen"] },
  // "Medication" (singular) = FGO/Sawyer roster report column.
  { key: "medications_at_program", label: "Medications at program", required: false,
    aliases: ["medications", "medication", "medicationsatprogram", "meds"] },
  { key: "emergency_contact_name", label: "Emergency contact name", required: false, coalesce: true,
    aliases: ["emergencycontactname", "emergencyname", "emergencycontact", "emergencycontact1", "emergencycontact2"] },
  { key: "emergency_contact_phone", label: "Emergency contact phone", required: false, coalesce: true,
    aliases: ["emergencycontactphone", "emergencyphone", "emergencycontact1phone", "emergencycontact2phone"] },
  { key: "special_needs_accommodations", label: "Accommodations", required: false,
    aliases: ["accommodations", "specialneeds", "specialneedsaccommodations"] },
  { key: "homeroom_teacher", label: "Homeroom teacher", required: false,
    aliases: ["homeroomteacher", "homeroom", "teacher", "classroomteacher", "homeroomname"] },
  { key: "photo_release_consent", label: "Photo release (Y/N)", required: false,
    aliases: ["photorelease", "photoconsent", "photoreleaseconsent"] },
  // Some reports fold emergency contacts + authorized pickup into one free-text
  // column ("Emergency Contacts / Authorized Pick Up") — keep it whole here.
  { key: "authorized_pickup_contacts", label: "Authorized pickup", required: false,
    aliases: ["pickup", "authorizedpickup", "authorizedpickupcontacts", "pickupcontacts", "pickuplist",
      "emergencycontactsauthorizedpickup", "emergencycontactauthorizedpickup", "authorizedpickupemergencycontacts"] },
  { key: "notes", label: "Notes", required: false,
    aliases: ["notes", "parentnotes", "comments"] },
  { key: "parent_first_name", label: "Parent first name", required: false,
    aliases: ["parentfirstname", "guardianfirstname", "parentfirst"] },
  { key: "parent_last_name", label: "Parent last name", required: false,
    aliases: ["parentlastname", "guardianlastname", "parentlast"] },
  // "HOH 1 Name" = Head of Household 1, how rec-management exports (West Linn
  // Parks & Rec, RecTrac, ActiveNet) label the guardian. "Parents"/"Parent" =
  // extended-day report / FGO roster report.
  { key: "parent_full_name", label: "Parent full name", required: false, coalesce: true,
    aliases: ["parentname", "parentsname", "parents", "parent", "guardianname", "guardiansname",
      "parentfullname", "guardianfullname", "parentguardian", "guardian", "hoh1name", "hoh2name",
      "headofhousehold", "headofhousehold1", "householdhead", "primaryguardian"] },
  { key: "parent_email", label: "Parent email", required: false, coalesce: true,
    aliases: ["parentemail", "parentsemail", "guardianemail", "email", "emailaddress",
      "p1email", "p2email", "hoh1email", "hoh2email", "altemailaddress1"] },
  // Rec exports scatter the number across Mobile/Home/HOH columns and fill a
  // different one per family — coalesce picks the first non-empty per row.
  // "P1 Cell" = extended-day report; "Phone 1" = FGO roster report.
  { key: "parent_phone", label: "Parent phone", required: false, coalesce: true,
    aliases: ["parentphone", "parentsphone", "guardianphone", "mobilephone", "cellphone", "cellularphone",
      "homephone", "p1cell", "p2cell", "p1phone", "phone1", "phone2", "hoh1cellphone", "hoh1homephone",
      "hoh2cellphone", "workphone", "phone", "phonenumber"] },
];

export function normalizeHeader(h) {
  return (h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Every normalized alias across all fields — used to recognize header cells
// (vs data cells) when we scan a messy file for its header row(s).
const ALIAS_SET = new Set();
for (const def of FIELD_DEFS) for (const a of def.aliases) ALIAS_SET.add(normalizeHeader(a));

export function autoMap(headers) {
  const map = {};
  const normHeaders = headers.map(normalizeHeader);
  for (const def of FIELD_DEFS) {
    for (const alias of def.aliases) {
      const idx = normHeaders.indexOf(normalizeHeader(alias));
      if (idx !== -1) {
        map[def.key] = headers[idx];
        break;
      }
    }
  }
  return map;
}

// Ordered list of column indices to try for a field, primary (operator-mapped)
// first, then — for coalesce fields — every other column whose header matches
// one of the field's aliases. Shared by buildRegistrants + filterDataRows.
export function candidateIndices(def, headers, mapping) {
  const normHeaders = headers.map(normalizeHeader);
  const idxs = [];
  const primary = mapping[def.key];
  if (primary) {
    const pi = headers.indexOf(primary);
    if (pi !== -1) idxs.push(pi);
  }
  if (def.coalesce) {
    for (const alias of def.aliases) {
      const na = normalizeHeader(alias);
      normHeaders.forEach((h, i) => {
        if (h === na && !idxs.includes(i)) idxs.push(i);
      });
    }
  }
  return idxs;
}

// Generational / professional suffixes — kept OUT of the "Last, First" swap so
// "John Smith, Jr." is not read as first name "Jr.".
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "phd", "md", "do", "dds", "esq"]);
const normSuffix = (t) => (t || "").toLowerCase().replace(/[^a-z]/g, "");

// Split a single full-name string into first + last.
//   "Liam Fullerton"      -> { first: "Liam",      last: "Fullerton" }
//   "Mary Anne Smith"     -> { first: "Mary Anne", last: "Smith" }
//   "Dussel, Oliver"      -> { first: "Oliver",    last: "Dussel" }     (Last, First)
//   "John Smith, Jr."     -> { first: "John",      last: "Smith Jr." }  (suffix, not swapped)
// "Last, First" is detected only when the string is exactly two comma-parts and
// the part after the comma is a given name (not a suffix) — extended-day and
// many roster reports export names this way. Otherwise the last whitespace token
// is the surname (or "Surname Suffix" when a trailing suffix is present).
// Mirrors the server (splitName in admin-import-camp-roster / admin-import-program-roster).
export function splitName(v) {
  const s = (v ?? "").toString().trim().replace(/\s+/g, " ");
  if (!s) return { first: "", last: "" };
  const commaParts = s.split(",").map((t) => t.trim()).filter(Boolean);
  if (commaParts.length === 2 && !NAME_SUFFIXES.has(normSuffix(commaParts[1]))) {
    return { first: commaParts[1], last: commaParts[0] };
  }
  const toks = s.replace(/,/g, " ").replace(/\s+/g, " ").trim().split(" ");
  if (toks.length === 1) return { first: toks[0], last: "" };
  if (toks.length >= 3 && NAME_SUFFIXES.has(normSuffix(toks[toks.length - 1]))) {
    return { first: toks.slice(0, -2).join(" "), last: toks.slice(-2).join(" ") };
  }
  return { first: toks.slice(0, -1).join(" "), last: toks[toks.length - 1] };
}

// Per-row label stats: how many non-empty cells look like known header labels,
// and how many non-empty cells there are. A header row is mostly labels; a data
// row is mostly values (names, emails, phones).
function rowLabelStats(row) {
  let alias = 0, nonEmpty = 0;
  for (const cell of row) {
    const t = (cell ?? "").toString().trim();
    if (!t) continue;
    nonEmpty++;
    if (ALIAS_SET.has(normalizeHeader(t))) alias++;
  }
  return { alias, nonEmpty };
}

// A row joins the header band only if it has >=1 recognized label AND at least
// half its non-empty cells are labels. This keeps a *data* row that merely
// contains one value equal to a label word ("Parent", "Comments", "Camper")
// from being absorbed into the header and dropped from the data.
function isHeaderish(stats) {
  return stats.alias >= 1 && stats.alias * 2 >= stats.nonEmpty;
}

// Spreadsheet-style column letter (0 -> A, 25 -> Z, 26 -> AA) for synthesizing
// a label for an unlabeled column so it stays addressable in the mapping panel.
function colLetter(i) {
  let s = "";
  let k = i + 1;
  while (k > 0) { const m = (k - 1) % 26; s = String.fromCharCode(65 + m) + s; k = Math.floor((k - 1) / 26); }
  return s;
}

// Locate the header row(s) in a raw sheet (array-of-arrays) and collapse them
// into a single header array, then return everything below as candidate data.
//
// Returns { headers, dataRows, multi }:
//   headers  – one header string per column (stacked header rows merged: for
//              each column, the last non-empty label in the header band wins).
//   dataRows – every row after the header band (still needs filterDataRows).
//   multi    – true when the same header band repeats later in the file, i.e.
//              this is a grouped/pivoted report (kids under repeated camp
//              headers). Turns on stricter title-row rejection downstream.
//
// If no row looks like a header at all, falls back to the legacy assumption
// (row 0 is the header) so ordinary tidy files behave exactly as before.
export function detectStructure(aoa) {
  const rows = (aoa || []).map((r) => (Array.isArray(r) ? r : []));
  const n = rows.length;
  if (n === 0) return { headers: [], dataRows: [], multi: false };

  const stats = rows.map(rowLabelStats);
  const scores = stats.map((s) => s.alias);
  let bestRow = 0, bestScore = 0;
  for (let i = 0; i < n; i++) {
    if (scores[i] > bestScore) { bestScore = scores[i]; bestRow = i; }
  }

  // Nothing recognizable — behave like the old importer (header = first row).
  if (bestScore === 0) {
    return { headers: rows[0] || [], dataRows: rows.slice(1), multi: false };
  }

  // Grow the header band across neighbouring rows that are *mostly labels*
  // (stacked/merged headers span several rows) — never absorb a data row.
  let bandStart = bestRow, bandEnd = bestRow;
  while (bandStart - 1 >= 0 && isHeaderish(stats[bandStart - 1])) bandStart--;
  while (bandEnd + 1 < n && isHeaderish(stats[bandEnd + 1])) bandEnd++;

  // Collapse the band into one header row: per column, the last non-empty label.
  // Give an unlabeled column a synthetic "Column X" name so it stays addressable
  // in the manual mapping panel and doesn't collide with the "not in file"
  // (empty-string) sentinel there.
  const width = Math.max(...rows.slice(bandStart, bandEnd + 1).map((r) => r.length), 0);
  const headers = [];
  for (let c = 0; c < width; c++) {
    let label = "";
    for (let r = bandStart; r <= bandEnd; r++) {
      const cell = (rows[r][c] ?? "").toString().trim();
      if (cell) label = cell;
    }
    headers.push(label || `Column ${colLetter(c)}`);
  }

  // Grouped/pivoted report? A *real* header band (>=2 labels) repeats further
  // down (the same columns above another camp/room's kids). Requiring >=2 keeps
  // an ordinary file whose header has a single recognized label out of grouped
  // mode (whose stricter row filter would otherwise drop sparse rows).
  let multi = false;
  if (bestScore >= 2) {
    for (let i = bandEnd + 1; i < n; i++) {
      if (scores[i] >= 2) { multi = true; break; }
    }
  }

  return { headers, dataRows: rows.slice(bandEnd + 1), multi };
}

// Drop the non-data rows left over after detectStructure: blank spacers, echoed
// header rows, camp/section title rows, and trailing junk (page numbers, export
// timestamps). Uses the column mapping so it can tell a camper name from a
// section title that happens to sit in the same column.
export function filterDataRows(dataRows, headers, mapping, multi) {
  const nameDefs = FIELD_DEFS.filter((d) =>
    d.key === "student_first_name" || d.key === "student_last_name" || d.key === "student_full_name");
  const nameCols = [];
  for (const def of nameDefs) {
    for (const i of candidateIndices(def, headers, mapping)) if (!nameCols.includes(i)) nameCols.push(i);
  }
  const mappedCols = [];
  for (const def of FIELD_DEFS) {
    for (const i of candidateIndices(def, headers, mapping)) if (!mappedCols.includes(i)) mappedCols.push(i);
  }

  const cell = (row, i) => (row[i] ?? "").toString().trim();

  // No name column mapped => we can't reason about which rows are records;
  // preserve the legacy behavior (keep any row with content) so the manual
  // "adjust columns" escape hatch still has rows to work with.
  if (nameCols.length === 0) {
    return dataRows.filter((r) => r.some((c) => (c ?? "").toString().trim() !== ""));
  }

  return dataRows.filter((row) => {
    if (!mappedCols.some((i) => cell(row, i))) return false;          // blank / off-table (e.g. day-grid only)
    const nameVal = nameCols.map((i) => cell(row, i)).find(Boolean);
    if (!nameVal) return false;                                       // header/label rows w/o a name ("Parents", "AGE")
    if (multi) {
      // In grouped reports a repeated header row ("Camper's Name") and a
      // section/camp title both sit alone in the name column with nothing else
      // on the row — a real camper always carries another datum (age, parent,
      // phone, email). Rows with only a name are treated as titles/headers.
      const otherMapped = mappedCols.some((i) => !nameCols.includes(i) && cell(row, i));
      if (!otherMapped) return false;
    }
    return true;
  });
}

// Turn parsed rows into editable registrant objects using the column mapping.
// Full-name columns are split into first/last here so the review list shows
// real names; explicit first/last columns always win. Coalesce fields fall
// through every matching column, first non-empty per row.
export function buildRegistrants(rows, headers, mapping) {
  return rows.map((row) => {
    const out = {};
    for (const def of FIELD_DEFS) {
      for (const idx of candidateIndices(def, headers, mapping)) {
        const c = (row[idx] ?? "").toString().trim();
        if (c) { out[def.key] = c; break; }
      }
    }
    if (out.student_full_name) {
      const s = splitName(out.student_full_name);
      if (!out.student_first_name) out.student_first_name = s.first;
      if (!out.student_last_name) out.student_last_name = s.last;
      delete out.student_full_name;
    }
    if (out.parent_full_name) {
      const p = splitName(out.parent_full_name);
      if (!out.parent_first_name) out.parent_first_name = p.first;
      if (!out.parent_last_name) out.parent_last_name = p.last;
      delete out.parent_full_name;
    }
    return out;
  });
}

// Stringify one Excel cell for the review list. Date-typed cells (when the
// workbook is read with { cellDates: true }) arrive as JS Date objects — format
// those as YYYY-MM-DD using UTC parts so a birthdate stored as an Excel serial
// (e.g. 43777) doesn't reach the importer as a raw number misread as year 43777.
export function excelCellToString(c) {
  if (c == null) return "";
  if (c instanceof Date && !Number.isNaN(c.getTime())) {
    const y = String(c.getUTCFullYear()).padStart(4, "0");
    const m = String(c.getUTCMonth() + 1).padStart(2, "0");
    const d = String(c.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(c);
}

// Tiny CSV parser -> array-of-arrays (every row, header included). Handles
// quoted fields with embedded commas + newlines and escaped quotes (""),
// CRLF/LF row endings. Plenty for Squarespace / Google Sheets / camp-management
// exports. (Header detection is a separate step — see detectStructure.)
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  // Strip a trailing empty row a final newline produces.
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  return rows;
}

// One-call pipeline: raw array-of-arrays -> { headers, data, mapping, multi }.
// `data` is the cleaned, ready-to-map data rows; `mapping` is the auto-detected
// column mapping (operator can still override it in the UI).
export function parseSheet(aoa) {
  const { headers, dataRows, multi } = detectStructure(aoa);
  const mapping = autoMap(headers);
  const data = filterDataRows(dataRows, headers, mapping, multi);
  return { headers, data, mapping, multi };
}
