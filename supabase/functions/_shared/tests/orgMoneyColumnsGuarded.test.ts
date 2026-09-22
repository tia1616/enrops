// Every money column on `organizations` must be locked against operator edits,
// recorded in the audit trail, or deliberately neither with a written reason.
// `members_update_own_org` is `FOR UPDATE USING (...)` with NO WITH CHECK, so an
// org admin can write any column the guard does not refuse.
//
// ── WHY THIS FILE NO LONGER READS SQL ────────────────────────────────────────
//
// Three previous versions parsed the migration text with regexes. ALL THREE
// reported green while every money column was unlocked. The holes, in order:
// a `--` in front of a lock clause; a later migration that merely QUOTED the
// function in a comment; whole-body matching, so a column moved into a harmless
// IF still read as locked; then, after those were fixed, the same bugs again one
// level down - a NESTED IF, the words RAISE EXCEPTION inside a STRING, an
// `ELSIF`, `DISABLE TRIGGER ALL`, a semicolon inside a string DEFAULT, a money
// column whose name the pattern did not cover.
//
// Each fix was correct and each one grew a new hole, because the approach was
// wrong: TEXT CANNOT ANSWER "IS THIS COLUMN PROTECTED". Only running the guard
// can. So the facts in moneyGuard.snapshot.json are MEASURED - each column was
// actually changed, as a real org admin against a QA fixture, and the database's
// answer recorded. A comment cannot fool that. Neither can a nested IF, a
// string, a disabled trigger, or a column nobody thought to name: a disabled
// trigger refuses nothing, and the probe sees exactly that.
//
// WHAT THIS FILE IS NOW: the place the measured facts are checked against what
// we INTEND. It is deliberately dumb. If it ever needs a regex over SQL again,
// that is the signal the check has drifted back to the wrong altitude.
//
// THE TRADE, STATED PLAINLY: the probe needs a database, so it cannot run in CI.
// CI checks the recorded facts and screams if a migration has touched the guard
// since they were recorded. That is weaker than measuring on every push, and it
// is the honest ceiling for a hermetic test suite. See the snapshot's header for
// how to re-measure; it is one query.

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);
const SNAPSHOT_FILE = new URL('./moneyGuard.snapshot.json', import.meta.url);

type Snapshot = {
  refused: string[];
  audited: string[];
  unprobeable: string[];
  all_columns: string[];
  newest_migration_at_probe_time: string;
  guard_md5: string;
  audit_md5: string;
  enabled_triggers_on_organizations: number;
};

const SNAP: Snapshot = JSON.parse(Deno.readTextFileSync(SNAPSHOT_FILE));
const refused = new Set(SNAP.refused);
const audited = new Set(SNAP.audited);

// ── What we INTEND. Explicit, because an inference cannot notice a removal. ───

/** Platform-admin-only. An operator changing any of these moves real money. */
const MUST_BE_LOCKED = [
  'stripe_account_id', // the payout destination - "payout-theft prevention", 20260527
  'platform_fee_card_pct',
  'platform_fee_ach_pct',
  'platform_fee_cap_cents',
  'platform_fee_ach_cap_cents',
  'platform_fee_floor_cents',
  'platform_fee_override_until',
  'platform_fee_cents',
  'platform_monthly_cents',
  'platform_plan',
  'stripe_fee_payer', // who bears Stripe's processing cost
  'stripe_charge_model', // whose Stripe balance it comes out of
  'instructor_pay_enabled',
  'instructor_pay_model',
  'sending_domain', // Resend-verified; its own refusal, not the platform-admin one
];

/** A change to these must leave a record of who made it. */
const MUST_BE_AUDITED = [
  'fee_pass_through',
  'platform_fee_card_pct',
  'platform_fee_ach_pct',
  'platform_fee_cap_cents',
  'platform_fee_ach_cap_cents',
  'platform_fee_floor_cents',
  'platform_fee_override_until',
  'platform_fee_cents',
  'platform_monthly_cents',
  'stripe_fee_payer',
  'stripe_charge_model',
  'withdrawal_admin_fee_cents',
];

/**
 * Operator controls. Asserted in the NEGATIVE so the "fix" the next person
 * reaches for - locking them - fails loudly instead of quietly removing a
 * documented setting.
 */
const MUST_NOT_BE_LOCKED: Record<string, string> = {
  fee_pass_through: 'money layer section 4: "the business can turn on cover the fee"',
  withdrawal_admin_fee_cents: "the provider's own deduction on a refund, typed on Finances",
};

/**
 * Money-named columns deliberately neither locked nor audited. Deliberately
 * expensive: the reason must be a real sentence and the key must still be a live
 * column, so this cannot rot into excuses for things nobody remembers.
 */
const DELIBERATELY_UNCLASSIFIED: Record<string, string> = {
  sibling_discount_pct:
    'the provider discounting their own price to their own families - their promotion, not a platform term',
  stripe_payouts_enabled:
    "a MIRROR of Stripe's own account capability, not a setting anyone types - written only by " +
    'stripe-webhook and refresh-stripe-status from what Stripe reports. Locking it would guard a ' +
    'cache; auditing it would record Stripe events as if a person had made them.',
  stripe_charges_enabled:
    "the twin of stripe_payouts_enabled and the same thing: a MIRROR of Stripe's account " +
    'capability, written by stripe-webhook from what Stripe reports, never typed by anyone. ' +
    'Editing it changes nothing about whether Stripe will actually take a payment.',
};

/**
 * Names that mean money. Deliberately generous - a false positive costs one line
 * in the map above, a false negative is the 2026-09-18 incident. Widened on
 * 2026-09-22 after a review proved `revenue_share_bps` could be added unlocked
 * and unaudited with the whole suite green.
 */
const MONEY_NAME =
  /(fee|price|pct|cents|amount|rate|charge|payer|discount|plan|surcharge|markup|commission|deposit|tax|payout|balance|tier|minimum|refund|credit|bps|currency|tuition|cost|margin|split|installment|wage|revenue|invoice|billing)/;

// ── The tests ────────────────────────────────────────────────────────────────

Deno.test('the snapshot is real and not vacuous', () => {
  assert(SNAP.all_columns.length >= 60, `snapshot looks truncated: ${SNAP.all_columns.length} columns`);
  assert(refused.size >= 10, `only ${refused.size} refused columns - did the probe run as a platform admin?`);
  assert(audited.size >= 8, `only ${audited.size} audited columns`);
  assert(SNAP.enabled_triggers_on_organizations >= 2, 'organizations has fewer than two enabled triggers');
});

Deno.test('every column that must be locked, is - measured, not parsed', () => {
  const missing = MUST_BE_LOCKED.filter((c) => !refused.has(c)).sort();
  assertEquals(
    missing,
    [],
    'the guard did NOT refuse these when an org admin actually tried to change them, so they are ' +
      'writable on their own organisation via members_update_own_org, which has no WITH CHECK.',
  );
});

Deno.test('every column that must be audited, is - measured, not parsed', () => {
  const missing = MUST_BE_AUDITED.filter((c) => !audited.has(c)).sort();
  assertEquals(
    missing,
    [],
    'changing these wrote NO row to organization_money_audit, so they would change what a family ' +
      'pays or gets back with no record of who did it.',
  );
});

Deno.test('the operator controls are audited and deliberately NOT locked', () => {
  for (const [col, why] of Object.entries(MUST_NOT_BE_LOCKED)) {
    assert(audited.has(col), `${col} changes what families pay and must stay in the audit`);
    assert(
      !refused.has(col),
      `${col} is now locked, which takes away a documented operator setting (${why}). ` +
        'If that is intended, change the doc first.',
    );
  }
});

Deno.test('no money-named column is left unclassified', () => {
  const unclassified = SNAP.all_columns
    .filter((c) => MONEY_NAME.test(c))
    .filter((c) => !refused.has(c) && !audited.has(c) && !(c in DELIBERATELY_UNCLASSIFIED))
    .sort();
  assertEquals(
    unclassified,
    [],
    'these money-named columns are neither refused nor audited by the live guard. Lock it, audit ' +
      'it, or add it to DELIBERATELY_UNCLASSIFIED with the reason.',
  );
});

Deno.test('every money-named column was actually probed', () => {
  // An untested column is not a protected column. If the probe could not find a
  // legal value for one (a CHECK constraint it could not satisfy), that is a gap
  // in the measurement and must be fixed in the probe, not waved through here.
  const moneyUnprobed = SNAP.unprobeable.filter((c) => MONEY_NAME.test(c)).sort();
  assertEquals(
    moneyUnprobed,
    [],
    'the probe could not test these money columns, so the snapshot says nothing about them. ' +
      'Give them a legal alternative value in scripts/probe-money-guard.sql and re-measure.',
  );
});

Deno.test('the escape hatch cannot rot', () => {
  const live = new Set(SNAP.all_columns);
  for (const [col, reason] of Object.entries(DELIBERATELY_UNCLASSIFIED)) {
    assert(
      live.has(col),
      `DELIBERATELY_UNCLASSIFIED names ${col}, which is not a column on organizations any more. ` +
        'Remove the entry rather than leaving a justification for something that does not exist.',
    );
    assert(
      reason.trim().length >= 20,
      `DELIBERATELY_UNCLASSIFIED["${col}"] needs a real reason, not "${reason}".`,
    );
  }
});

Deno.test('the snapshot has not been outrun by a migration', () => {
  // THE TRIPWIRE, and the only text matching left in this file. Deliberately
  // coarse: a plain substring search over the raw source of every migration
  // newer than the one the probe ran against. It over-matches on purpose - the
  // cost of a false hit is re-running one query, and the cost of a miss is a
  // snapshot that quietly describes a guard nobody has since. No parsing, no
  // dollar-quotes, no comment handling, nothing that has fooled this file before.
  const newer = [...Deno.readDirSync(MIGRATIONS)]
    .filter((e) => e.isFile && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .filter((n) => n > SNAP.newest_migration_at_probe_time)
    .sort();

  const touched = newer.filter((name) => {
    const src = Deno.readTextFileSync(new URL(name, MIGRATIONS)).toLowerCase();
    return (
      src.includes('guard_organizations_locked_columns') ||
      src.includes('audit_organization_money') ||
      src.includes('organization_money_audit') ||
      (src.includes('trigger') && src.includes('organizations'))
    );
  });

  assertEquals(
    touched,
    [],
    `these migrations landed after the money guard was last measured and touch it or a trigger on ` +
      `organizations, so moneyGuard.snapshot.json may describe a guard that no longer exists. ` +
      `Re-run scripts/probe-money-guard.sql against staging, update the snapshot (including ` +
      `newest_migration_at_probe_time), and re-check parity against prod.`,
  );
});
