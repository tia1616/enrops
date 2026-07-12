// Standalone check of the server pricing engine. Imported as .ts via a tiny
// inline transpile-free shim is awkward, so we run it with Deno (the edge runtime).
// Usage: deno run promoPricing.test.mjs  (from this dir)
import {
  priceCart,
  validatePromo,
} from './promoPricing.ts';

const money = (c) => `$${(c / 100).toFixed(2)}`;
let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

const prog = (id, price) => ({ id, price_cents: price, early_bird_price_cents: null, early_bird_deadline: null });
const pc = (over) => ({
  id: 'code1', organization_id: 'org1', code: 'X', discount_type: 'percent', discount_value: 10,
  active: true, starts_at: null, expires_at: null, max_uses: null, used_count: 0,
  per_family_limit: null, min_subtotal_cents: null, scope_program_ids: null, ...over,
});

// 1) One child $285, 10% promo -> charged $256.50, promo actually applied
{
  const r = priceCart(
    [{ program: prog('p1', 28500), child_index: 0 }],
    { siblingPct: 10, validatedPromo: pc({ discount_type: 'percent', discount_value: 10 }) },
  );
  const sum = r.lines.reduce((s, l) => s + l.amount_cents, 0);
  check('1-child 10% promo total', r.total_cents === 25650, money(r.total_cents));
  check('1-child invariant sum==total', sum === r.total_cents, `${money(sum)} vs ${money(r.total_cents)}`);
}

// 2) Two kids $285, sibling 10%, $25 fixed promo
{
  const r = priceCart(
    [
      { program: prog('p1', 28500), child_index: 0 },
      { program: prog('p2', 28500), child_index: 1 },
    ],
    { siblingPct: 10, validatedPromo: pc({ discount_type: 'fixed', discount_value: 25 }) },
  );
  const sum = r.lines.reduce((s, l) => s + l.amount_cents, 0);
  // base 28500+28500=57000; sibling child2 2850; afterSibling 54150; promo 2500; net 51650
  check('2-kid sibling+$25 total', r.total_cents === 51650, money(r.total_cents));
  check('2-kid invariant sum==total', sum === r.total_cents, `${money(sum)} vs ${money(r.total_cents)}`);
  check('2-kid gross preserved', r.subtotal_cents === 57000, money(r.subtotal_cents));
}

// 3) Control: no promo
{
  const r = priceCart(
    [
      { program: prog('p1', 28500), child_index: 0 },
      { program: prog('p2', 28500), child_index: 1 },
    ],
    { siblingPct: 10, validatedPromo: null },
  );
  check('control no-promo total', r.total_cents === 54150, money(r.total_cents));
}

// 4) Rounding: 3 different-priced lines, 10% promo -> per-line nets must sum EXACTLY
{
  const r = priceCart(
    [
      { program: prog('p1', 28500), child_index: 0 },
      { program: prog('p2', 29900), child_index: 0 },
      { program: prog('p3', 27333), child_index: 0 },
    ],
    { siblingPct: 0, validatedPromo: pc({ discount_type: 'percent', discount_value: 10 }) },
  );
  const sum = r.lines.reduce((s, l) => s + l.amount_cents, 0);
  check('rounding invariant sum==total', sum === r.total_cents, `${money(sum)} vs ${money(r.total_cents)}`);
  check('rounding promo==10% of subtotal', r.promo_discount_cents === Math.round((28500 + 29900 + 27333) * 0.1), money(r.promo_discount_cents));
}

// 5) $0 comp: 100% promo -> total 0
{
  const r = priceCart(
    [{ program: prog('p1', 28500), child_index: 0 }],
    { siblingPct: 0, validatedPromo: pc({ discount_type: 'percent', discount_value: 100 }) },
  );
  check('100% comp total is $0', r.total_cents === 0, money(r.total_cents));
}

// 6) validation: expired / wrong org / used up / per-family / scope / min
{
  const base = { orgId: 'org1', lineProgramIds: ['p1'], afterSiblingSubtotalCents: 28500, totalRedemptions: 0, familyRedemptions: 0 };
  check('valid passes', validatePromo(pc({}), base).valid === true);
  check('wrong org rejected', validatePromo(pc({ organization_id: 'org2' }), base).valid === false);
  check('inactive rejected', validatePromo(pc({ active: false }), base).valid === false);
  check('expired rejected', validatePromo(pc({ expires_at: '2000-01-01' }), base).valid === false);
  check('not-started rejected', validatePromo(pc({ starts_at: '2999-01-01' }), base).valid === false);
  check('max_uses rejected', validatePromo(pc({ max_uses: 5 }), { ...base, totalRedemptions: 5 }).valid === false);
  check('per_family rejected', validatePromo(pc({ per_family_limit: 1 }), { ...base, familyRedemptions: 1 }).valid === false);
  check('min_subtotal rejected', validatePromo(pc({ min_subtotal_cents: 30000 }), base).valid === false);
  check('out-of-scope rejected', validatePromo(pc({ scope_program_ids: ['pZ'] }), base).valid === false);
  check('in-scope passes', validatePromo(pc({ scope_program_ids: ['p1'] }), base).valid === true);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
