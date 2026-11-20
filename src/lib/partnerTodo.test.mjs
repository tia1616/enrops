// The provider's to-do list for one partner (2026-11-20).
import { partnerTodo } from './partnerTodo.js';
import { providerSummary, requiredKeys } from './partnerPortalLogic.js';
import { formatDate } from './providerDocumentLogic.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)})`); }
}

const TODAY = '2026-11-20';
const P = 'hv';
const shared = (over) => ({
  instructor_id: over.id, first_name: over.first, last_name: 'Test', sites: ['Library'], shared: true,
  background_check_status: 'current', background_check_completed_on: '2026-10-10', background_check_expires_on: '2027-10-10', background_check_as_of: '2026-10-10',
  training_completed_on: '2026-08-25', training_as_of: '2026-08-25',
  code_of_conduct_on: '2026-08-20', mandatory_reporter_on: '2026-08-20', agreement_signed_on: '2026-08-20',
  clearances: [], ...over,
});

const docs = [
  { id: 'cert', doc_type: 'insurance', partner_id: P, expires_on: '2026-12-01', expiry_status: 'expiring_soon' },
  { id: 'agr', doc_type: 'agreement', partner_id: P, expires_on: null, expiry_status: 'no_expiry' },
];
const instructors = [
  shared({ id: 'riley', first: 'Riley' }),
  shared({ id: 'ricky', first: 'Ricky', background_check_status: 'expired', background_check_expires_on: '2026-08-20' }),
  shared({ id: 'kyle', first: 'Kyle', training_completed_on: null, code_of_conduct_on: null }),
  shared({ id: 'ana', first: 'Ana', background_check_status: 'awaiting_date', background_check_completed_on: null, background_check_expires_on: null }),
  { instructor_id: 'lukas', first_name: 'Lukas', last_name: 'Test', sites: ['Library'], shared: false, clearances: [] },
];
const required = requiredKeys([
  { requirement_key: 'insurance', required: true }, { requirement_key: 'partner_agreement', required: true },
  { requirement_key: 'business_license', required: true },
  { requirement_key: 'background_check', required: true }, { requirement_key: 'training', required: true },
  { requirement_key: 'code_of_conduct', required: true }, { requirement_key: 'mandatory_reporter', required: false },
  { requirement_key: 'contractor_agreement', required: false },
]);
const s = providerSummary({ docs, instructors, partnerId: P, orgName: 'J2S', today: TODAY, required });
const todo = partnerTodo({ s, instructors, orgName: 'J2S', today: TODAY });
const byKey = Object.fromEntries(todo.map((t) => [t.key, t]));

eq('missing required document: upload', byKey['doc:business_license']?.action, { type: 'upload', requirementKey: 'business_license' });
eq('expiring certificate: renew that file', byKey['doc:insurance:cert']?.action.doc.id, 'cert');
eq('expiring is amber', byKey['doc:insurance:cert']?.tone, 'warn');
eq('a current document is not listed', Object.keys(byKey).some((k) => k.startsWith('doc:partner_agreement')), false);
eq('expired check: upload for that instructor', byKey['bgc:ricky']?.action, { type: 'instructor', instructorId: 'ricky', upload: 'background-check' });
eq('missing training', byKey['training:kyle']?.text, 'Add Kyle Test\'s training date.');
eq('missing signature, required', !!byKey['code_of_conduct:kyle'], true);
eq('missing signature: opens the paper form for that form', byKey['code_of_conduct:kyle']?.action, { type: 'instructor', instructorId: 'kyle', paper: 'code_of_conduct' });
eq('not-required item is never listed', Object.keys(byKey).some((k) => k.startsWith('mandatory_reporter')), false);
eq('cleared but no date: ask for the report with its date', byKey['bgc:ana']?.text, 'Ana Test\'s background check is cleared but has no completed date. Upload the report again with its date.');
eq('not shared: one share item, nothing else about them', todo.filter((t) => t.key.endsWith(':lukas')).map((t) => t.action.type), ['share']);
eq('a fully current instructor has nothing', todo.some((t) => t.key.endsWith(':riley')), false);
eq('red before amber', todo.findIndex((t) => t.tone === 'warn') > todo.findLastIndex((t) => t.tone === 'bad'), true);

// A check from another agency standing in clears the item.
{
  const withStandIn = [shared({
    id: 'sam', first: 'Sam', background_check_status: 'awaiting_date', background_check_completed_on: null, background_check_expires_on: null,
    clearances: [{ id: 'c1', clearance_body: 'district_fingerprint', check_type: 'background_check', completed_on: '2026-09-01', expires_on: '2028-09-01', entered_at: '2026-09-02T00:00:00Z', status: 'current' }],
  })];
  const s2 = providerSummary({ docs, instructors: withStandIn, partnerId: P, orgName: 'J2S', today: TODAY, required });
  const t2 = partnerTodo({ s: s2, instructors: withStandIn, orgName: 'J2S', today: TODAY });
  eq('another agency\'s current check: no background-check item', t2.some((t) => t.key === 'bgc:sam'), false);
  // Control: the same instructor WITHOUT that clearance is asked for the date.
  const without = [{ ...withStandIn[0], clearances: [] }];
  const s3 = providerSummary({ docs, instructors: without, partnerId: P, orgName: 'J2S', today: TODAY, required });
  eq('control: without it, the date is asked for', partnerTodo({ s: s3, instructors: without, orgName: 'J2S', today: TODAY }).some((t) => t.key === 'bgc:sam'), true);
}

// The stand-in itself is renewing: date and action come from IT, not the
// expired enrops check (which would read "renews <a past date>").
{
  const renewing = [shared({
    id: 'jo', first: 'Jo', background_check_status: 'expired', background_check_expires_on: '2026-08-01',
    clearances: [{ id: 'c2', clearance_body: 'wa_dcyf', check_type: 'background_check', completed_on: '2024-12-01', expires_on: '2026-12-01', entered_at: '2024-12-02T00:00:00Z', status: 'expiring_soon' }],
  })];
  const s4 = providerSummary({ docs, instructors: renewing, partnerId: P, orgName: 'J2S', today: TODAY, required });
  const jo = partnerTodo({ s: s4, instructors: renewing, orgName: 'J2S', today: TODAY }).find((t) => t.key === 'bgc:jo');
  eq('stand-in renewing: amber', jo?.tone, 'warn');
  eq('stand-in renewing: its own date', jo?.text.includes(formatDate('2026-12-01')), true);
  eq('stand-in renewing: opens the record, not the enrops upload', jo?.action, { type: 'instructor', instructorId: 'jo' });
}

eq('nothing loaded: empty', partnerTodo({ s: null, instructors: [], orgName: '', today: TODAY }), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
