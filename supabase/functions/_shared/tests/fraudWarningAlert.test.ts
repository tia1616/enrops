import { assertEquals, assert, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  resolveChargeOwner,
  renderFraudWarningAlert,
  describeFraudType,
  formatPaidOn,
} from '../fraudWarningAlert.ts';

// ── resolveChargeOwner ──────────────────────────────────────────────────────

type Row = Record<string, unknown> | null;
type Result = { data: Row; error: { message: string } | null };

// Minimal stand-in for supabase-js: one canned result per table.
function fakeAdmin(results: Record<string, Result>) {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      calls.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(results[table] ?? { data: null, error: null }),
      };
      return chain;
    },
  };
}

Deno.test('instalment charge resolves through installments first', async () => {
  const admin = fakeAdmin({ installments: { data: { organization_id: 'org1', registration_id: 'reg1' }, error: null } });
  assertEquals(await resolveChargeOwner(admin, 'pi_1', null), { organizationId: 'org1', registrationId: 'reg1', lookupFailed: false });
  assertEquals(admin.calls, ['installments']);
});

Deno.test('pay-in-full charge resolves through registrations', async () => {
  const admin = fakeAdmin({ registrations: { data: { id: 'reg2', organization_id: 'org2' }, error: null } });
  assertEquals(await resolveChargeOwner(admin, 'pi_2', null), { organizationId: 'org2', registrationId: 'reg2', lookupFailed: false });
});

Deno.test('unknown charge falls back to the connected account', async () => {
  const admin = fakeAdmin({ organizations: { data: { id: 'org3' }, error: null } });
  assertEquals(await resolveChargeOwner(admin, 'pi_3', 'acct_x'), { organizationId: 'org3', registrationId: null, lookupFailed: false });
});

Deno.test('an installments row with a NULL org keeps its registration and still falls back to the account', async () => {
  // installments.organization_id is nullable (20260806b). handleDispute always
  // handled this: registration from the row, org from event.account, and the
  // registrations table never consulted.
  const admin = fakeAdmin({
    installments: { data: { organization_id: null, registration_id: 'reg9' }, error: null },
    organizations: { data: { id: 'org9' }, error: null },
  });
  assertEquals(await resolveChargeOwner(admin, 'pi_9', 'acct_9'), { organizationId: 'org9', registrationId: 'reg9', lookupFailed: false });
  assertEquals(admin.calls, ['installments', 'organizations']);
});

Deno.test('nothing found and no account = no owner, NOT a lookup failure', async () => {
  const admin = fakeAdmin({});
  assertEquals(await resolveChargeOwner(admin, 'pi_4', null), { organizationId: null, registrationId: null, lookupFailed: false });
});

Deno.test('a database error is reported as lookupFailed, not as "no such charge"', async () => {
  const admin = fakeAdmin({
    installments: { data: null, error: { message: 'timeout' } },
    registrations: { data: null, error: null },
  });
  const r = await resolveChargeOwner(admin, 'pi_5', null);
  assertEquals(r.organizationId, null);
  assertEquals(r.lookupFailed, true);
});

// ── renderFraudWarningAlert ─────────────────────────────────────────────────

const PETERSON = {
  parentName: 'Carrie Peterson',
  parentEmail: 'carrie@example.com',
  parentPhone: '5415550100',
  children: [
    { childFirstName: 'Clark', programName: 'LEGO Architects', siteName: 'Happy Valley Library' },
    { childFirstName: 'Graham', programName: 'LEGO Architects', siteName: 'Happy Valley Library' },
  ],
  amountCents: 50882,
  paidOn: 'November 2, 2026',
  statementDescriptor: 'ENROPS* JOURNEYTOSTEAM',
  fraudType: 'unauthorized_use_of_card',
};

Deno.test('full alert names the family, both children, amount and what to do', () => {
  const { subject, body } = renderFraudWarningAlert(PETERSON);
  assertEquals(subject, 'Fraud warning on a payment from Carrie Peterson: contact them today');
  assertStringIncludes(body, 'a charge the cardholder did not authorize');
  assertStringIncludes(body, 'Phone: 5415550100');
  assertStringIncludes(body, 'Email: carrie@example.com');
  assertStringIncludes(body, '$508.82, paid November 2, 2026');
  assertStringIncludes(body, 'On their card statement: ENROPS* JOURNEYTOSTEAM');
  assertStringIncludes(body, 'Clark: LEGO Architects at Happy Valley Library');
  assertStringIncludes(body, 'Graham: LEGO Architects at Happy Valley Library');
  assertStringIncludes(body, 'can no longer be refunded');
});

Deno.test('no em dashes in operator-facing copy', () => {
  const { subject, body } = renderFraudWarningAlert(PETERSON);
  assert(!subject.includes('—') && !body.includes('—'));
});

Deno.test('with nothing loaded the alert still sends, says it is unmatched, and never says "refund it in enrops"', () => {
  const { subject, body } = renderFraudWarningAlert({
    parentName: null, parentEmail: null, parentPhone: null, children: [],
    amountCents: null, paidOn: null, statementDescriptor: null, fraudType: null,
  });
  assertEquals(subject, 'Fraud warning on a payment from a family: contact them today');
  assertStringIncludes(body, 'Name not on file');
  assertStringIncludes(body, 'could not match this payment to a registration');
  assertStringIncludes(body, 'contact enrops support');
  assertStringIncludes(body, 'a fraudulent charge');
  assert(!body.includes('Phone:') && !body.includes('$') && !body.includes('refund it in enrops'));
});

Deno.test('unmatched but amount loaded: still says unmatched (the refund advice depends on it)', () => {
  const { body } = renderFraudWarningAlert({ ...PETERSON, children: [] });
  assertStringIncludes(body, '$508.82');
  assertStringIncludes(body, 'could not match this payment');
  assert(!body.includes('refund it in enrops'));
});

Deno.test('matched: no "could not match" line, refund in enrops', () => {
  const { body } = renderFraudWarningAlert(PETERSON);
  assert(!body.includes('could not match'));
  assertStringIncludes(body, 'refund it in enrops right away');
});

Deno.test('not actionable (already refunded or disputed): no action asked, no refund advice', () => {
  const { subject, body } = renderFraudWarningAlert({ ...PETERSON, actionable: false });
  assertEquals(subject, 'Fraud warning on a payment from Carrie Peterson: no action needed');
  assertStringIncludes(body, 'already been refunded or disputed');
  assert(!body.includes('WHAT TO DO') && !body.includes('refund it') && !body.includes('contact the family today'));
});

Deno.test('stolen card: does not claim the family failed to recognize it, does not ask them to call their bank', () => {
  const { body } = renderFraudWarningAlert({ ...PETERSON, fraudType: 'made_with_stolen_card' });
  assertStringIncludes(body, 'a charge made with a stolen card');
  assertStringIncludes(body, 'may not be the cardholder');
  assert(!body.includes('did not recognize') && !body.includes('tell their bank'));
  assertStringIncludes(body, 'refund it in enrops right away');
});

Deno.test('unknown fraud type falls back to plain words, never the code', () => {
  assertEquals(describeFraudType('misc'), 'a fraudulent charge');
  assertEquals(describeFraudType(undefined), 'a fraudulent charge');
});

// ── formatPaidOn ────────────────────────────────────────────────────────────

Deno.test('date is the org-local day, not the UTC day', () => {
  // 2026-11-03 01:03 UTC = the evening of Nov 2 in Oregon.
  assertEquals(formatPaidOn(1793667791, 'America/Los_Angeles'), 'November 2, 2026');
  assertEquals(formatPaidOn(1793667791, 'UTC'), 'November 3, 2026');
});

Deno.test('a bad timezone does not lose the date', () => {
  assertEquals(formatPaidOn(1793667791, 'Not/AZone'), 'November 3, 2026');
  assertEquals(formatPaidOn(null, 'UTC'), null);
});
