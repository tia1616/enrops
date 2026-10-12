// Pins the partner portal access wording. Who may sign in is database policy,
// proven against staging.

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)})`); }
}

import { accessStatus, contactsWithoutAccess } from './partnerPortalLogic.js';

eq('signed in wins over link sent', accessStatus({ last_signed_in_at: '2026-10-29T17:00:00Z', last_link_sent_at: '2026-10-28T10:00:00Z' }).label, 'Signed in Oct 29, 2026');
eq('link sent, not yet signed in', accessStatus({ last_link_sent_at: '2026-10-28T10:00:00Z' }).label, 'Link sent Oct 28, 2026, not signed in yet');
eq('nothing sent', accessStatus({}).label, 'No sign-in link sent yet');
eq('null row', accessStatus(null).tone, 'neutral');

const contacts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
eq('already-granted contacts are not offered again', contactsWithoutAccess(contacts, [{ contact_id: 'b' }]).map((c) => c.id), ['a', 'c']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
