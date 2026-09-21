// Every money column on `organizations` must be BOTH locked against operator
// edits and written to the audit trail. Neither list fails when you forget it,
// which is exactly how two columns went unprotected for three days.
//
// WHAT HAPPENED, 2026-09-18 to 2026-09-21. platform_fee_ach_cap_cents and
// platform_fee_override_until shipped, and neither was added to
// guard_organizations_locked_columns or audit_organization_money. Because
// members_update_own_org lets any org ADMIN update their own row, that made
// them the only money columns an operator could change on their own
// organisation, and the only ones that could change with no record of who did
// it. The end date IS the negotiated agreement - an operator who can move their
// own expiry keeps a negotiated rate forever - and a bank ceiling of 1c means
// Enrops collects nothing on bank payments. Neither was reachable by a family
// and nothing had actually been changed, but nothing had stopped it either.
//
// THE SOURCE OF TRUTH IS ORG_FEE_COLUMNS, deliberately. A new fee column has to
// be added there or resolveFeeConfig cannot read it, so nobody can add one and
// skip this test by forgetting a list. That is the whole design: the list that
// is impossible to forget drives the two lists that are easy to forget.
//
// SCOPE, honestly. This reads the MIGRATIONS - the repo's intent - not the live
// databases. A function edited directly in a database would not be caught here.
// Both databases were read back and confirmed to match on 2026-09-21; the
// standing way to re-check is `select prosrc from pg_proc` on each.

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { ORG_FEE_COLUMNS } from '../feeConfig.ts';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

/**
 * The body of JUST `fnName`, from the LAST migration that defines it.
 *
 * Last by filename, because migration filenames are date-ordered and the newest
 * definition is the one the database ends up with. Reading an earlier one would
 * let a column that was since removed still satisfy this test.
 *
 * THE SLICE MATTERS, and the first version of this test got it wrong. Searching
 * the whole FILE passes for the wrong reason: the 2026-09-21 migration defines
 * BOTH functions, so "is this column locked?" was satisfied by the column
 * appearing in the AUDIT function sitting below it in the same file. The test
 * told me so by failing on the one case where the two lists legitimately
 * differ. Only the function's own body counts.
 */
function latestDefinitionOf(fnName: string): { file: string; body: string } {
  const files = [...Deno.readDirSync(MIGRATIONS)]
    .filter((e) => e.isFile && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();

  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fnName}\\s*\\(`, 'i');

  // Find the LAST file that defines it before extracting anything. Extracting
  // inside the loop made the test fail on a July migration that quotes its body
  // differently - a definition that has since been replaced and is nobody's
  // business here. Only the newest definition is the one the database has.
  let latest: { name: string; src: string; at: number } | null = null;
  for (const name of files) {
    const src = Deno.readTextFileSync(new URL(name, MIGRATIONS));
    const m = re.exec(src);
    if (m) latest = { name, src, at: m.index };
  }
  assert(
    latest,
    `no migration defines ${fnName} any more. If it was renamed, this test needs the new name - do not delete the test.`,
  );

  // From the CREATE to the end of its dollar-quoted body.
  const { name, src, at } = latest!;
  const open = src.indexOf('$$', at);
  assert(open !== -1, `the newest ${fnName} (${name}) is not quoted with $$; this test needs updating`);
  const close = src.indexOf('$$', open + 2);
  assert(close !== -1, `the newest ${fnName} (${name}) has an unterminated $$ body`);
  return { file: name, body: src.slice(at, close + 2) };
}

/** The fee columns, from the one list a new column cannot avoid being added to. */
const FEE_COLUMNS = ORG_FEE_COLUMNS.split(',').map((c) => c.trim()).filter(Boolean);

Deno.test('the fee column list is actually populated (this test must not pass vacuously)', () => {
  // If ORG_FEE_COLUMNS were ever emptied or reshaped, every assertion below
  // would iterate nothing and pass. Pin the shape first.
  assert(FEE_COLUMNS.length >= 6, `expected the fee columns, got ${JSON.stringify(FEE_COLUMNS)}`);
  for (const c of FEE_COLUMNS) {
    assert(/^platform_fee_[a-z_]+$/.test(c), `unexpected entry in ORG_FEE_COLUMNS: ${c}`);
  }
});

Deno.test('every fee column is LOCKED against operator edits', () => {
  const { file, body } = latestDefinitionOf('guard_organizations_locked_columns');
  const missing = FEE_COLUMNS.filter((c) => !body.includes(c));
  assertEquals(
    missing,
    [],
    `these fee columns are not locked in ${file}, so an org admin can change them on their own ` +
      `organisation via members_update_own_org. Add them to the guard.`,
  );
});

Deno.test('every fee column is WRITTEN TO THE AUDIT when it changes', () => {
  const { file, body } = latestDefinitionOf('audit_organization_money');
  const missing = FEE_COLUMNS.filter((c) => !body.includes(c));
  assertEquals(
    missing,
    [],
    `these fee columns change what a family is charged and leave no record in ${file}. ` +
      `Add an IF block for each.`,
  );
});

// The two money columns that are NOT in ORG_FEE_COLUMNS, because the fee
// resolver does not read them - so they have to be named here or nothing covers
// them. They are NOT treated the same, and the difference is deliberate.
Deno.test('stripe_fee_payer is both locked and audited', () => {
  // Who bears Stripe's processing cost. An operator moving this to 'absorb'
  // would silently shift real money onto the Enrops balance.
  assert(
    latestDefinitionOf('guard_organizations_locked_columns').body.includes('stripe_fee_payer'),
  );
  assert(latestDefinitionOf('audit_organization_money').body.includes('stripe_fee_payer'));
});

Deno.test('fee_pass_through is audited but deliberately NOT locked', () => {
  // Money layer section 4: "The business can turn on cover the fee." That is
  // the operator's own decision to make, so locking it would break a documented
  // setting - but it changes what every family is charged, so it is recorded.
  // Asserted in BOTH directions so that "fix" the next person reaches for
  // (locking it) fails loudly instead of quietly removing an operator control.
  assert(
    latestDefinitionOf('audit_organization_money').body.includes('fee_pass_through'),
    'fee_pass_through changes what families pay and must stay in the audit',
  );
  assert(
    !latestDefinitionOf('guard_organizations_locked_columns').body.includes('fee_pass_through'),
    'fee_pass_through is now locked, which takes away the documented "cover the fee" setting ' +
      '(money layer section 4). If that is intended, change the doc first.',
  );
});
