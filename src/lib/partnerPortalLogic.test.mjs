// Pins the partner portal access wording. Who may sign in is database policy,
// proven against staging.

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)})`); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); }
}

import { accessStatus, contactsWithoutAccess } from './partnerPortalLogic.js';

eq('signed in wins over link sent', accessStatus({ last_signed_in_at: '2026-10-29T17:00:00Z', last_link_sent_at: '2026-10-28T10:00:00Z' }).label, 'Signed in Oct 29, 2026');
eq('link sent, not yet signed in', accessStatus({ last_link_sent_at: '2026-10-28T10:00:00Z' }).label, 'Link sent Oct 28, 2026, not signed in yet');
eq('nothing sent', accessStatus({}).label, 'No sign-in link sent yet');
eq('null row', accessStatus(null).tone, 'neutral');

const contacts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
eq('already-granted contacts are not offered again', contactsWithoutAccess(contacts, [{ contact_id: 'b' }]).map((c) => c.id), ['a', 'c']);

// --- instructor checklist ----------------------------------------------------
{
  const { instructorChecklist, CHECK_STATUS } = await import('./partnerPortalLogic.js');
  const { readFileSync } = await import('node:fs');

  const ORG = 'Acme Kids';
  const TODAY = '2026-10-20';

  const pending = instructorChecklist({ shared: false, background_check_status: 'in_review' }, ORG, TODAY);
  eq('no permission = one In review line with the reason', pending.map((l) => [l.badge.label, l.detail]), [['In review', "Waiting on this instructor's consent"]]);

  const full = instructorChecklist({
    shared: true,
    background_check_status: 'current',
    background_check_completed_on: '2026-10-10',
    background_check_expires_on: '2027-10-10',
    background_check_vendor: 'Yardstik',
    background_check_as_of: '2026-10-12',
    training_completed_on: '2026-08-25',
    training_as_of: '2026-10-20',
    code_of_conduct_on: '2026-08-20',
    mandatory_reporter_on: '2026-08-20',
    agreement_signed_on: '2026-08-20',
  }, ORG, TODAY);
  eq('check line', [full[0].badge.label, full[0].detail], ['Current', 'Completed Oct 10, 2026 · Renews Oct 10, 2027']);
  eq('check as of + source', full[0].meta, 'as of Oct 12, 2026 · Source: entered by Acme Kids · Screening company: Yardstik');
  eq('training as of + source', full[1].meta, 'as of Oct 20, 2026 · Source: entered by Acme Kids');
  eq('signed item as of + source', full[2].meta, 'as of Aug 20, 2026 · Source: signed by the instructor in enrops');
  eq('five lines in order', full.map((l) => l.key), ['background_check', 'training', 'code_of_conduct', 'mandatory_reporter', 'agreement']);
  ok('every chip carries an as-of', full.every((l) => l.meta.startsWith('as of ')));

  const gaps = instructorChecklist({ shared: true, background_check_status: 'missing' }, ORG, TODAY);
  eq('missing check', [gaps[0].badge.label, gaps[0].detail, gaps[0].meta], ['Expired or Missing', '', 'as of Oct 20, 2026']);
  eq('missing training', gaps[1].badge.label, 'Expired or Missing');
  ok('missing chips still carry an as-of', gaps.every((l) => l.meta.startsWith('as of ')));

  const exp = instructorChecklist({ shared: true, background_check_status: 'expired', background_check_completed_on: '2025-01-02', background_check_expires_on: '2026-01-02' }, ORG, TODAY);
  eq('expired: one word, and the detail says Expired, not Renews', [exp[0].badge.label, exp[0].detail], ['Expired or Missing', 'Completed Jan 2, 2025 · Expired Jan 2, 2026']);

  const noDate = instructorChecklist({ shared: true, background_check_status: 'awaiting_date', background_check_vendor: 'Yardstik' }, ORG, TODAY);
  eq('cleared without a date: In review, says why, names no company', [noDate[0].badge.label, noDate[0].detail, noDate[0].meta], ['In review', 'Completed date not on file yet', 'Source: entered by Acme Kids']);
  const pendingCheck = instructorChecklist({ shared: true, background_check_status: 'in_review' }, ORG, TODAY);
  eq('a pending check is never told its date is missing', pendingCheck[0].detail, 'Check in progress');

  eq('unknown status never shows green', instructorChecklist({ shared: true, background_check_status: 'weird' }, ORG, TODAY)[0].badge.tone, 'review');

  // Spec v3: exactly these words, nothing else, can appear on a chip.
  const SIX = ['Current', 'Expiring in 30 days', 'Expired or Missing', 'In review', 'Host-run', 'Not required'];
  ok('only spec v3 chip words', Object.values(CHECK_STATUS).every((s) => SIX.includes(s.label)));

  // Every status the database function can return has words here.
  const sql = readFileSync(new URL('../../supabase/migrations/20261020a_partner_portal_oct30_finish.sql', import.meta.url), 'utf8');
  const fnBody = sql.slice(sql.indexOf('create function public.partner_portal_instructors'));
  const returned = [...fnBody.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]);
  ok('sql returns some statuses', returned.length >= 2);
  for (const s of returned) ok(`sql status ${s} has a label`, !!CHECK_STATUS[s]);

  // Copy rules (Arielle): never cleared / safe / enrops verifies or certifies.
  const words = JSON.stringify([CHECK_STATUS, full, gaps, pending, noDate]).toLowerCase();
  ok('no banned words', !/cleared|\bsafe\b|enrops verif|certif|verified/.test(words));
}

// --- partner home summary (spec v3 H1) ---------------------------------------
{
  const { providerSummary, worstBadge } = await import('./partnerPortalLogic.js');
  const P = 'p-hv';
  const current = (extra = {}) => ({
    shared: true, background_check_status: 'current', background_check_completed_on: '2026-10-10',
    background_check_expires_on: '2027-10-10', background_check_as_of: '2026-10-12', training_completed_on: '2026-08-25',
    training_as_of: '2026-10-20', code_of_conduct_on: '2026-08-20', mandatory_reporter_on: '2026-08-20', agreement_signed_on: '2026-08-20',
    sites: ['Happy Valley Library'], ...extra,
  });
  const docs = [
    { doc_type: 'insurance', partner_id: P, expiry_status: 'current', updated_at: '2026-10-12T00:00:00Z' },
    { doc_type: 'insurance', partner_id: null, expiry_status: 'expiring_soon', updated_at: '2026-10-01T00:00:00Z' },
    { doc_type: 'insurance', partner_id: 'p-vancouver', expiry_status: 'expired', updated_at: '2026-10-21T00:00:00Z' },
    { doc_type: 'agreement', partner_id: null, expiry_status: 'no_expiry', updated_at: '2026-10-12T00:00:00Z' },
  ];
  const s = providerSummary({ docs, instructors: [current(), current({ shared: false })], partnerId: P, orgName: 'Acme', today: '2026-10-20' });
  eq('insurance takes the worst of THIS partner\'s certificates (not another partner\'s)', s.insurance.label, 'Expiring in 30 days');
  eq('agreement on file', s.agreement.label, 'Current');
  eq('no license on file reads Expired or Missing', s.license.label, 'Expired or Missing');
  eq('instructors: 1 of 2 current (one has not consented)', [s.instructors.current, s.instructors.total], [1, 2]);
  eq('instructor chip is the worst line', s.instructors.badge.label, 'In review');
  eq('last change ignores another partner\'s document', s.lastChange, '2026-10-20');
  eq('sites collected', s.sites, ['Happy Valley Library']);

  const empty = providerSummary({ docs: [], instructors: [], partnerId: P, orgName: 'Acme', today: '2026-10-20' });
  eq('nothing on file: insurance missing, no instructor chip', [empty.insurance.label, empty.instructors.badge, empty.training], ['Expired or Missing', null, null]);
  ok('a missing item ranks a row first', empty.rank < s.rank || empty.rank === 0);
  eq('worst of none', worstBadge([]), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
