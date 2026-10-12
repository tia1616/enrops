// Pins when the registration page may OFFER a year bundle. Must match what
// create-registration will SELL, or a family fills in the whole form and is
// refused at submit. See vipOffering.js.

import { vipBundleAllowed } from './vipOffering.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, expected ${expected})`}`);
}

const J2S = { enabled: true, price_cents: 72000, excluded_location_ids: ['cascadia'] };

check('bundles on, priced, ordinary school: offered', vipBundleAllowed(J2S, 'bridger'), true);
check('excluded school: not offered', vipBundleAllowed(J2S, 'cascadia'), false);
check('bundles off (every business but J2S today): not offered',
  vipBundleAllowed({ enabled: false, price_cents: null, excluded_location_ids: [] }, 'x'), false);
check('on but no price: not offered (server refuses it too)',
  vipBundleAllowed({ enabled: true, price_cents: null, excluded_location_ids: [] }, 'x'), false);
check('price 0: not offered', vipBundleAllowed({ ...J2S, price_cents: 0 }, 'x'), false);
check('read failed (null): not offered', vipBundleAllowed(null, 'x'), false);
check('enabled as a string is not true: not offered', vipBundleAllowed({ ...J2S, enabled: 'true' }, 'x'), false);
check('excluded list missing: treated as none excluded', vipBundleAllowed({ enabled: true, price_cents: 72000 }, 'x'), true);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nALL PASS');
