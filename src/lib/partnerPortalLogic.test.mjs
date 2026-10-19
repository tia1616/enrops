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

  eq('no permission = no lines', instructorChecklist({ shared: false, background_check_status: null }), []);

  const full = instructorChecklist({
    shared: true,
    background_check_status: 'current',
    background_check_completed_on: '2026-10-10',
    background_check_expires_on: '2027-10-10',
    background_check_vendor: 'Yardstik',
    training_completed_on: '2026-08-25',
    code_of_conduct_on: '2026-08-20',
    mandatory_reporter_on: '2026-08-20',
    agreement_signed_on: '2026-08-20',
  });
  eq('check line', [full[0].badge.label, full[0].detail], ['Current', 'Completed Oct 10, 2026 · Renews Oct 10, 2027 · Yardstik-verified']);
  eq('five lines in order', full.map((l) => l.key), ['background_check', 'training', 'code_of_conduct', 'mandatory_reporter', 'agreement']);

  const gaps = instructorChecklist({ shared: true, background_check_status: 'missing' });
  eq('missing check', [gaps[0].badge.label, gaps[0].detail], ['Missing', '']);
  eq('missing training', gaps[1].badge.label, 'Missing');

  const exp = instructorChecklist({ shared: true, background_check_status: 'expired', background_check_completed_on: '2025-01-02', background_check_expires_on: '2026-01-02' });
  eq('expired says Expired, not Renews', exp[0].detail, 'Completed Jan 2, 2025 · Expired Jan 2, 2026');

  const vendorNoDate = instructorChecklist({ shared: true, background_check_status: 'in_review', background_check_vendor: 'Yardstik' });
  eq('no "verified" claim without a completed check', [vendorNoDate[0].badge.label, vendorNoDate[0].detail], ['In review', '']);

  eq('unknown status never shows green', instructorChecklist({ shared: true, background_check_status: 'weird' })[0].badge.tone, 'neutral');

  // Every status the database function can return has words here.
  const sql = readFileSync(new URL('../../supabase/migrations/20261019b_partner_portal_instructors.sql', import.meta.url), 'utf8');
  for (const s of ['missing', 'in_review', 'date_missing']) ok(`sql status ${s} has a label`, sql.includes(`'${s}'`) && !!CHECK_STATUS[s]);

  // Copy rules (Arielle, Oct 16): never cleared / safe / enrops verifies.
  const words = JSON.stringify([CHECK_STATUS, full, gaps]).toLowerCase();
  ok('no banned words', !/cleared|\bsafe\b|enrops verif|certif/.test(words));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
