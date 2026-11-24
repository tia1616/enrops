// A family joining a weekly class that has already started pays for the
// sessions left (Jessica 2026-11-24), and a later refund of our fee is measured
// against the sessions they bought. Pins:
//   - the charge rule (promoPricing.ts) and the on-screen rule (src/lib/pricing.js)
//     are the SAME numbers - the twin that sets the price and the one that charges;
//   - sibling and promo discounts stack on the prorated base;
//   - loadProration measures a late joiner against the sessions on or after the
//     day they registered.
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { proratedBaseCents as serverProrate, priceCart } from '../promoPricing.ts';
import { loadProration } from '../refundFeeProration.ts';
// deno-lint-ignore no-explicit-any
const client: any = await import('../../../../src/lib/pricing.js');

Deno.test('the screen and the charge prorate identically', () => {
  const cases: Array<[number, unknown, unknown]> = [
    [27500, 4, 8], [27500, 8, 8], [27500, 0, 8], [27500, 9, 8], [27500, null, 8],
    [27500, 4, null], [29900, 3, 7], [10001, 1, 3], [27500, 4.5, 8], [0, 2, 4],
  ];
  for (const [base, left, total] of cases) {
    assertEquals(
      client.proratedBaseCents(base, left, total),
      serverProrate(base, left as number, total as number),
      `twin mismatch for ${base} ${left}/${total}`,
    );
  }
});

Deno.test('price x sessions left / total, only for a class that has started', () => {
  assertEquals(serverProrate(27500, 4, 8), 13750); // the example Jessica approved
  assertEquals(serverProrate(29900, 3, 7), 12814); // 12814.28 -> rounded to the cent
  assertEquals(serverProrate(27500, 8, 8), 27500); // not started: full price
  assertEquals(serverProrate(27500, 0, 8), 27500); // nothing left (finished is refused elsewhere)
  assertEquals(serverProrate(27500, null, null), 27500); // unknown: full price
});

Deno.test('sibling and promo discounts apply to the prorated price', () => {
  const started = { id: 'p1', price_cents: 27500, early_bird_price_cents: null, early_bird_deadline: null, sessions_left: 4, sessions_total: 8 };
  const r = priceCart(
    [{ program: started, child_index: 0 }, { program: started, child_index: 1 }],
    { siblingPct: 10, validatedPromo: null },
  );
  assertEquals(r.lines[0].base_cents, 13750);
  assertEquals(r.lines[1].base_cents, 13750);
  assertEquals(r.lines[1].sibling_discount_cents, 1375); // 10% of the prorated price
  assertEquals(r.total_cents, 13750 + 12375);
});

Deno.test('the browser shows the same base and says how many sessions are left', () => {
  const p = { id: 'p1', price_cents: 27500, sessions_left: 4, sessions_total: 8 };
  const b = client.basePriceForItem({ program: p, isVip: false });
  assertEquals(b.base_cents, 13750);
  assertEquals(b.label, '4 of 8 sessions left');
  assertEquals(b.standard_cents, 27500);
  // A year bundle is never prorated.
  const vip = client.basePriceForItem({ program: p, isVip: true });
  assertEquals(vip.is_prorated, undefined);
});

// A fake supabase client: organizations -> timezone, rpc -> the 8 dates.
const EIGHT = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'];
// deno-lint-ignore no-explicit-any
const db: any = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { timezone: 'America/Los_Angeles' } }) }) }) }),
  rpc: async () => ({ data: EIGHT, error: null }),
};

Deno.test('a late joiner is refunded against the sessions they bought', async () => {
  const now = new Date('2026-12-02T20:00:00Z'); // Dec 2 local: 3 of 8 left
  const late = await loadProration(db, {
    organization_id: 'o', program_id: 'p', camp_session_id: null,
    registered_at: '2026-11-24T18:00:00Z', // joined Nov 24: bought Nov 30 .. Dec 21 = 4
  }, now);
  assertEquals(late.fraction, 3 / 4);
  const early = await loadProration(db, {
    organization_id: 'o', program_id: 'p', camp_session_id: null,
    registered_at: '2026-10-01T18:00:00Z', // joined before it started: all 8
  }, now);
  assertEquals(early.fraction, 3 / 8);
  const unknown = await loadProration(db, { organization_id: 'o', program_id: 'p', camp_session_id: null }, now);
  assertEquals(unknown.fraction, 3 / 8); // no registered_at: whole class, as before
});
