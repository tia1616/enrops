// Fee switchover rehearsal: does an org that has lapsed onto the platform
// default actually produce the money doc's published prices?
//
// This runs the doc's OWN worked-prices table (section 4) through the browser
// fee twin, src/lib/platformFee.js, using the config the LIVE staging
// org-fee-config endpoint returns for a lapsed org. The clamps have never
// bound in production - every org is on 1% with no floor and no real ceiling -
// so this is the first time the floor and the two ceilings do anything at all.
//
// Run: node scripts/fee-switchover-rehearsal.mjs <slug>
import { feeOnCents, totalWithFee } from '../src/lib/platformFee.js';

const SLUG = process.argv[2] ?? 'tenant-two-test';
const URL = 'https://mumfymlapolsfdnpewci.supabase.co/functions/v1/org-fee-config';

// Money doc section 4, "Worked prices". Dollars.
const TABLE = [
  { price: 25, card: 26.99, bank: 26.99, note: 'Minimum, no discount' },
  { price: 45, card: 46.99, bank: 46.99, note: 'Minimum, no discount' },
  { price: 80, card: 82.40, bank: 81.99, note: 'Save $0.41' },
  { price: 240, card: 247.20, bank: 244.80, note: 'Save $2.40' },
  { price: 299, card: 307.97, bank: 304.98, note: 'Save $2.99' },
  { price: 600, card: 614.99, bank: 609.99, note: 'Maximums, save $5.00' },
  { price: 1200, card: 1214.99, bank: 1209.99, note: 'Maximums, save $5.00' },
];

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: SLUG }),
});
const cfg = await res.json();

console.log(`resolved config for ${SLUG}:`);
console.log(`  card ${cfg.platform_fee_card_pct} | bank ${cfg.platform_fee_ach_pct}`
  + ` | floor ${cfg.platform_fee_floor_cents} | card cap ${cfg.platform_fee_cap_cents}`
  + ` | bank cap ${cfg.platform_fee_ach_cap_cents}`);
console.log('');
console.log('price    card (doc)   card (code)  |  bank (doc)   bank (code)  note');

let fails = 0;
for (const row of TABLE) {
  const cents = Math.round(row.price * 100);
  const gotCard = totalWithFee(cents, cfg) / 100;
  const gotBank = totalWithFee(cents, cfg, { isBank: true }) / 100;
  const okCard = Math.abs(gotCard - row.card) < 0.005;
  const okBank = Math.abs(gotBank - row.bank) < 0.005;
  if (!okCard || !okBank) fails++;
  const m = (ok) => (ok ? ' ' : 'X');
  console.log(
    `$${String(row.price).padEnd(6)} ${row.card.toFixed(2).padStart(10)}`
    + ` ${gotCard.toFixed(2).padStart(12)}${m(okCard)} |`
    + ` ${row.bank.toFixed(2).padStart(10)} ${gotBank.toFixed(2).padStart(12)}${m(okBank)}`
    + `  ${row.note}`,
  );
}

// The discount the doc says to SHOW: card fee minus bank fee.
console.log('');
const d240 = (feeOnCents(24000, cfg) - feeOnCents(24000, cfg, { isBank: true })) / 100;
console.log(`bank discount shown on a $240 session: $${d240.toFixed(2)} (doc says $2.40)`);

console.log('');
console.log(fails === 0
  ? `ALL ${TABLE.length} ROWS MATCH THE MONEY DOC`
  : `${fails} ROW(S) DISAGREE WITH THE MONEY DOC`);
// exitCode, NOT process.exit(): forcing exit while the fetch socket is still
// closing trips a libuv assertion on Windows ("!(handle->flags &
// UV_HANDLE_CLOSING)") and returns 127 on a run that actually passed. Setting
// the code lets node drain and exit on its own with the right status.
process.exitCode = fails === 0 ? 0 : 1;
