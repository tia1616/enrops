// Pins the pure rules for provider documents. Who may read or write a document,
// and its expiry status, are database decisions proven against staging.

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, JSON.stringify(actual) === JSON.stringify(expected));
}

import {
  blankDraft, draftFromRow, draftProblem, rowFromDraft, fileProblem,
  storagePathFor, storedExtension, groupByAudience, formatDate, EXPIRY_STATUS, DOC_TYPES,
} from './providerDocumentLogic.js';

// --- files ------------------------------------------------------------------
const pdf = { name: 'COI.pdf', type: 'application/pdf', size: 200_000 };
eq('pdf accepted', fileProblem(pdf), null);
eq('png accepted', fileProblem({ name: 'scan.png', type: 'image/png', size: 10 }), null);
eq('pdf with empty mime accepted by name', storedExtension({ name: 'a.PDF', type: '', size: 1 }), 'pdf');
ok('word doc refused', fileProblem({ name: 'a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1 }) !== null);
ok('over 10 MB refused', fileProblem({ ...pdf, size: 10 * 1024 * 1024 + 1 }) !== null);
eq('exactly 10 MB accepted', fileProblem({ ...pdf, size: 10 * 1024 * 1024 }), null);

// --- the path's first folder is the provider (bucket policy + table CHECK) ---
eq('path', storagePathFor('org-1', { name: 'x.jpeg', type: 'image/jpeg' }, 'doc-9'), 'org-1/doc-9.jpg');

// --- the form ---------------------------------------------------------------
const ins = { ...blankDraft('insurance'), expires_on: '2027-01-17' };
eq('insurance with expiry + file is valid', draftProblem(ins, { hasFile: true }), null);
ok('no file refused', draftProblem(ins, { hasFile: false }) !== null);
ok('insurance without expiry refused', draftProblem({ ...ins, expires_on: '' }, { hasFile: true }) !== null);
ok('insurance cannot opt out of expiry', draftProblem({ ...ins, expires_on: '', no_expiry: true }, { hasFile: true }) !== null);
ok('blank title refused', draftProblem({ ...ins, title: '   ' }, { hasFile: true }) !== null);

const agr = blankDraft('agreement');
ok('agreement needs expiry OR the no-expiry tick', draftProblem(agr, { hasFile: true }) !== null);
eq('agreement with no-expiry tick is valid', draftProblem({ ...agr, no_expiry: true }, { hasFile: true }), null);
ok('expiry before start refused', draftProblem({ ...agr, effective_on: '2026-05-01', expires_on: '2026-04-01' }, { hasFile: true }) !== null);

// --- what gets written --------------------------------------------------------
const insRow = rowFromDraft({ ...ins, insurer: ' Western National ', abuse_coverage: true, partner_id: 'p1' });
eq('insurance row keeps details', [insRow.insurer, insRow.abuse_coverage, insRow.partner_id], ['Western National', true, 'p1']);
eq('every-partner is null', rowFromDraft(ins).partner_id, null);

const agrRow = rowFromDraft({ ...agr, no_expiry: true, expires_on: '2027-01-01', insurer: 'stale', abuse_coverage: true });
eq('no-expiry tick wins over a leftover date', agrRow.expires_on, null);
eq('insurance fields cleared on other types', [agrRow.insurer, agrRow.abuse_coverage], [null, null]);

// switching insurance -> agreement in the form must not keep the abuse flag
eq('round trip from a saved agreement', draftFromRow({ doc_type: 'agreement', title: 'A', expires_on: null }).no_expiry, true);
eq('a saved insurance row is never "no expiry"', draftFromRow({ doc_type: 'insurance', title: 'C', expires_on: '2027-01-17' }).no_expiry, false);

// --- grouping -------------------------------------------------------------------
const partners = [{ id: 'hv', partner_name: 'Happy Valley Parks and Rec' }, { id: 'van', partner_name: 'Vancouver Parks and Rec' }];
const rows = [
  { id: 1, partner_id: 'van', expires_on: '2027-01-17' },
  { id: 2, partner_id: null, expires_on: null },
  { id: 3, partner_id: 'hv', expires_on: '2026-11-14' },
  { id: 4, partner_id: 'hv', expires_on: '2026-10-01' },
  { id: 5, partner_id: 'gone', expires_on: '2026-12-01' },
];
const g = groupByAudience(rows, partners);
eq('every partner first, then by name, orphan kept', g.map((x) => x.label), ['Every partner', 'A partner no longer in your list', 'Happy Valley Parks and Rec', 'Vancouver Parks and Rec']);
eq('soonest expiry first within a group', g.find((x) => x.key === 'hv').rows.map((r) => r.id), [4, 3]);
eq('no rows, no groups', groupByAudience([], partners), []);

// --- words for every status the database can return ---------------------------
eq('status keys match private.document_expiry_status()', Object.keys(EXPIRY_STATUS).sort(), ['current', 'expired', 'expiring_soon', 'no_expiry']);
eq('expired reads as spec v3 says', EXPIRY_STATUS.expired.label, 'Expired or Missing');

// --- business license + additional insured (20261020a) ----------------------
eq('business license is a type', blankDraft('business_license').title, 'Business license');
eq('license with an expiry is valid', draftProblem({ ...blankDraft('business_license'), expires_on: '2027-08-07' }, { hasFile: true }), null);
eq('additional insured round trip', draftFromRow({ doc_type: 'insurance', title: 'C', expires_on: '2027-01-17', additional_insured: true }).additional_insured, true);
eq('additional insured saved for insurance', rowFromDraft({ ...blankDraft('insurance'), expires_on: '2027-01-17', additional_insured: true }).additional_insured, true);
eq('additional insured cleared for other types', rowFromDraft({ ...blankDraft('agreement'), no_expiry: true, additional_insured: true }).additional_insured, null);
{
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../supabase/migrations/20261020a_partner_portal_oct30_finish.sql', import.meta.url), 'utf8');
  const check = sql.match(/provider_documents_doc_type_check\s+check \(doc_type = any \(array\[([^\]]+)\]/);
  const dbTypes = check ? [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort() : [];
  eq('every document type the form offers is allowed by the table', DOC_TYPES.map((t) => t.key).sort(), dbTypes);
}
eq('date has no timezone shift', formatDate('2027-01-17'), 'Jan 17, 2027');

// --- insurance limits (20261026b) -------------------------------------------
{
  const { parseLimit, formatLimit, limitLines, LIMIT_FIELDS } = await import('./providerDocumentLogic.js');
  eq('reads 1,000,000', parseLimit('1,000,000'), 1000000);
  eq('reads $3,000,000', parseLimit('$3,000,000'), 3000000);
  eq('blank is not entered', parseLimit('  '), null);
  ok('words are not a number', Number.isNaN(parseLimit('1M')));
  eq('formats with commas', formatLimit(1000000), '$1,000,000');

  const ins2 = { ...blankDraft('insurance'), expires_on: '2027-01-17', title: 'COI' };
  eq('limits are optional', draftProblem(ins2, { hasFile: true }), null);
  ok('a non-number limit is refused', draftProblem({ ...ins2, gl_occurrence_limit: '1M' }, { hasFile: true }) !== null);
  ok('aggregate below per-occurrence is refused', draftProblem({ ...ins2, gl_occurrence_limit: '3,000,000', gl_aggregate_limit: '1,000,000' }, { hasFile: true }) !== null);
  ok('a limit past the column size is refused', draftProblem({ ...ins2, abuse_aggregate_limit: '30,000,000,000' }, { hasFile: true }) !== null);

  const row = rowFromDraft({ ...ins2, gl_occurrence_limit: '1,000,000', gl_aggregate_limit: '3,000,000', abuse_occurrence_limit: '1,000,000' });
  eq('limits saved as whole dollars', [row.gl_occurrence_limit, row.gl_aggregate_limit, row.abuse_occurrence_limit, row.abuse_aggregate_limit], [1000000, 3000000, 1000000, null]);
  eq('an abuse amount means abuse coverage', row.abuse_coverage, true);
  const agr2 = rowFromDraft({ ...blankDraft('agreement'), title: 'A', no_expiry: true, gl_occurrence_limit: '5' });
  ok('limits are cleared on a non-insurance document', LIMIT_FIELDS.every((k) => agr2[k] === null));

  eq('round trip: a saved row edits back as typed', draftFromRow({ doc_type: 'insurance', gl_aggregate_limit: 3000000 }).gl_aggregate_limit, '3,000,000');
  eq('host-facing lines', limitLines({ gl_occurrence_limit: 1000000, gl_aggregate_limit: 3000000, abuse_occurrence_limit: 1000000 }),
    ['General liability: $1,000,000 per occurrence, $3,000,000 aggregate', 'Abuse and molestation: $1,000,000 per occurrence']);
  eq('nothing entered, nothing said', limitLines({}), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
