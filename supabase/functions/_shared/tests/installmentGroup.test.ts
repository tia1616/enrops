import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { installmentGroupKey, INSTALLMENT_GROUP_SELECT } from '../installmentGroup.ts';

const row = (over: Record<string, unknown> = {}) => ({
  organization_id: 'org-1',
  stripe_customer_id: 'cus_1',
  installment_number: 2,
  registration_id: 'reg-1',
  registrations: { stripe_checkout_session_id: 'cs_A' },
  ...over,
});

Deno.test('two lines of ONE checkout still charge together (v5 earliest-date grouping)', () => {
  assertEquals(
    installmentGroupKey(row({ registration_id: 'reg-1' })),
    installmentGroupKey(row({ registration_id: 'reg-2' })),
  );
});

Deno.test('two checkouts for one customer never merge - the 2026-10-27 Chiriac charge', () => {
  // Minecraft (own checkout, due 10/27) and the year bundle's Pokemon leg
  // (different checkout, due 2027-01-05): same org, customer, installment number.
  const minecraft = row({ registration_id: 'reg-mc', registrations: { stripe_checkout_session_id: 'cs_mc' } });
  const pokemon = row({ registration_id: 'reg-pk', registrations: { stripe_checkout_session_id: 'cs_bundle' } });
  assertNotEquals(installmentGroupKey(minecraft), installmentGroupKey(pokemon));
});

Deno.test('a row with no recorded checkout never merges with anything', () => {
  const a = row({ registration_id: 'reg-1', registrations: { stripe_checkout_session_id: null } });
  const b = row({ registration_id: 'reg-2', registrations: { stripe_checkout_session_id: null } });
  assertNotEquals(installmentGroupKey(a), installmentGroupKey(b));
  // nor with a checkout-keyed row of the same registration's customer
  assertNotEquals(installmentGroupKey(a), installmentGroupKey(row()));
  // a missing embed fails the same safe way: it keys on the registration, never
  // on a shared constant that would merge two registrations' rows
  const noEmbedA = row({ registration_id: 'reg-1', registrations: null });
  const noEmbedB = row({ registration_id: 'reg-2', registrations: undefined });
  assertNotEquals(installmentGroupKey(noEmbedA), installmentGroupKey(noEmbedB));
  assertEquals(installmentGroupKey(noEmbedA), installmentGroupKey(row({ registration_id: 'reg-1', registrations: null })));
});

Deno.test('org, customer and installment number still split groups (v8 unchanged)', () => {
  assertNotEquals(installmentGroupKey(row()), installmentGroupKey(row({ organization_id: 'org-2' })));
  assertNotEquals(installmentGroupKey(row()), installmentGroupKey(row({ stripe_customer_id: 'cus_2' })));
  assertNotEquals(installmentGroupKey(row()), installmentGroupKey(row({ installment_number: 3 })));
});

Deno.test('the select embeds the checkout the key reads', () => {
  assertEquals(INSTALLMENT_GROUP_SELECT.includes('registrations(stripe_checkout_session_id)'), true);
});
