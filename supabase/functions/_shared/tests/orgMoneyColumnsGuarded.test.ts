// Every money column on `organizations` must be classified: locked against
// operator edits, written to the audit trail, or deliberately neither WITH A
// WRITTEN REASON. Nothing fails when you forget one, which is exactly how two
// columns went unprotected for three days.
//
// WHAT HAPPENED, 2026-09-18 to 2026-09-21. platform_fee_ach_cap_cents and
// platform_fee_override_until shipped, and neither was added to
// guard_organizations_locked_columns or audit_organization_money. Because
// members_update_own_org lets any org ADMIN update their own row - it is
// `FOR UPDATE USING (...)` with NO WITH CHECK - that made them the only money
// columns an operator could change on their own organisation, and the only ones
// that could change with no record of who did it.
//
// AND THEN, 2026-09-22, THIS TEST FAILED TO CATCH TWO MORE. stripe_charge_model
// and withdrawal_admin_fee_cents were in the same position and this file said
// nothing, because of three defects fixed in this rewrite:
//
//   1. IT READ A LIST NOTHING MAINTAINS. The old version drove itself from
//      ORG_FEE_COLUMNS in feeConfig.ts and claimed "a new column has to be added
//      there or resolveFeeConfig cannot read it". That is FALSE: that constant
//      is exported and read by NOTHING in production - every caller hand-writes
//      its own select list - so it cannot grow when the schema does. It now
//      drives itself from THE MIGRATIONS THEMSELVES, so a money column added by
//      any migration is in scope automatically, whether or not anybody
//      remembered this file.
//
//   2. IT MATCHED BARE COLUMN NAMES. `body.includes('stripe_fee_payer')` is
//      satisfied by the column's name appearing in the guard's RAISE message, so
//      deleting the real lock while leaving the prose behind read as green.
//      Proved by deleting it. It now matches the FUNCTIONAL clause,
//      `NEW.<col> IS DISTINCT FROM OLD.<col>`, which is the thing that actually
//      does the work.
//
//   3. IT ASSUMED $$ QUOTING. 32 migration files use `AS $function$` against 29
//      using `AS $$`, and both previous definitions of the guard used
//      $function$ - it is what pg_get_functiondef emits. Taking the first `$$`
//      after the CREATE then ran the slice past the end of the function and into
//      unrelated statements, so columns matched text belonging to other code. It
//      now reads the actual dollar-quote tag and finds its true partner.
//
// SCOPE, honestly. This reads the MIGRATIONS - the repo's intent - not the live
// databases. A function edited directly in a database would not be caught here,
// and neither would a trigger dropped by hand. Both databases were read back and
// confirmed to match on 2026-09-22; the standing way to re-check is
// `select md5(prosrc) from pg_proc` on each.

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { ORG_FEE_COLUMNS } from '../feeConfig.ts';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

/**
 * Migration filenames in apply order, newest last.
 *
 * Plain lexicographic sort is NOT apply order when two migrations share a
 * version prefix - and five groups already do (20260810f, 20260810g, 20260907b,
 * 20260908a, 20260921a). Within a tie the topic name silently decides, so a
 * same-day corrective migration named `20260921a_fix_org_guard.sql` would sort
 * BEFORE `20260921a_guard_and_audit_...` and this file would keep reading the
 * superseded definition while the database had the corrected one.
 *
 * Ties are allowed - they exist and are harmless in general - but a tie BETWEEN
 * TWO FILES THAT BOTH DEFINE THE SAME FUNCTION is not, because then nobody can
 * say which one the database ended up with. That case fails loudly below.
 */
function migrationFiles(): string[] {
  return [...Deno.readDirSync(MIGRATIONS)]
    .filter((e) => e.isFile && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
}

const VERSION_PREFIX = /^([0-9]{8}[a-z]?)/;

/**
 * The body of JUST `fnName`, from the LAST migration that defines it.
 *
 * THE DOLLAR QUOTE IS READ, NOT ASSUMED. `AS $$`, `AS $function$` and `AS $_$`
 * are all legal and all appear in this repo. Taking `indexOf('$$')` on a
 * $function$-quoted body skips the whole function and lands on some later `$$`,
 * producing a slice that spans unrelated statements - which passes, wrongly.
 *
 * THE SLICE MATTERS, and the first version of this test got it wrong the other
 * way too: searching the whole FILE passes for the wrong reason, because the
 * 2026-09-21 migration defines BOTH functions and "is this column locked?" was
 * satisfied by the column appearing in the AUDIT function below it. Only the
 * function's own body counts.
 */
function latestDefinitionOf(fnName: string): { file: string; body: string } {
  const files = migrationFiles();
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fnName}\\s*\\(`,
    'i',
  );

  // Find the LAST file that defines it before extracting anything. Extracting
  // inside the loop made the test fail on a July migration that quotes its body
  // differently - a definition that has since been replaced and is nobody's
  // business here.
  const definers: { name: string; src: string; at: number }[] = [];
  for (const name of files) {
    const src = Deno.readTextFileSync(new URL(name, MIGRATIONS));
    const m = re.exec(src);
    if (m) definers.push({ name, src, at: m.index });
  }
  assert(
    definers.length > 0,
    `no migration defines ${fnName} any more. If it was renamed, this test needs the new name - do not delete the test.`,
  );

  // A prefix tie between two definers of the SAME function means apply order is
  // unknowable from the filenames. Refuse to guess.
  const last = definers[definers.length - 1];
  if (definers.length > 1) {
    const prev = definers[definers.length - 2];
    const pa = VERSION_PREFIX.exec(last.name)?.[1];
    const pb = VERSION_PREFIX.exec(prev.name)?.[1];
    assert(
      !pa || !pb || pa !== pb,
      `${last.name} and ${prev.name} share the version prefix "${pa}" and BOTH define ${fnName}, ` +
        `so which one the database applied last cannot be read off the filenames. Rename one.`,
    );
  }

  const { name, src, at } = last;

  // Read the dollar-quote tag the function actually uses, then find ITS partner.
  const tagMatch = /\bAS\s+(\$[A-Za-z_0-9]*\$)/i.exec(src.slice(at));
  assert(
    tagMatch,
    `the newest ${fnName} (${name}) has no "AS $tag$" body; this test needs updating`,
  );
  const tag = tagMatch![1];
  const open = at + tagMatch!.index + tagMatch![0].length - tag.length;
  const close = src.indexOf(tag, open + tag.length);
  assert(close !== -1, `the newest ${fnName} (${name}) has an unterminated ${tag} body`);
  return { file: name, body: src.slice(at, close + tag.length) };
}

/**
 * The columns a function actually gates on, read from the clause that does the
 * work rather than from the column's name appearing somewhere in the text.
 *
 * `NEW.x IS DISTINCT FROM OLD.x` is the predicate in both functions: in the
 * guard it is what triggers the refusal, in the audit it is what triggers the
 * INSERT. A name in a RAISE message, a quoted 'label' in an INSERT, or a comment
 * does not match - which is the entire point.
 */
function gatedColumns(body: string): Set<string> {
  const out = new Set<string>();
  const re = /NEW\.([a-z_][a-z0-9_]*)\s+IS\s+DISTINCT\s+FROM\s+OLD\.\1\b/gi;
  for (const m of body.matchAll(re)) out.add(m[1].toLowerCase());
  return out;
}

/**
 * Every column ever added to `organizations` whose name says it carries money.
 *
 * THIS IS THE LIST THAT CANNOT BE FORGOTTEN, because it is the schema itself. A
 * new money column reaches it the moment its migration lands, with nobody having
 * to remember this file exists. That is what the old ORG_FEE_COLUMNS comment
 * claimed and did not deliver.
 *
 * Deliberately name-based and deliberately generous: a false positive costs one
 * line in the classification below, a false negative is the 2026-09-18 incident.
 */
const MONEY_NAME = /(fee|price|pct|cents|amount|rate|charge_model|payer|discount|plan)/;

/**
 * Money columns that are ON THE DATABASE but in NO MIGRATION.
 *
 * THE LIMIT OF A FILE-BASED CHECK, found 2026-09-22 by comparing this scan
 * against information_schema on both databases. `platform_fee_cents` and
 * `platform_monthly_cents` exist on staging AND prod and appear in no migration
 * anywhere - they were applied straight to the database - so no amount of
 * parsing can discover them. A scan of the repo is a scan of the repo.
 *
 * They are listed here so they are still CLASSIFIED. When one of these is
 * finally written into a migration the scan finds it anyway and the duplicate is
 * harmless. Re-check the list with, on each database:
 *
 *   select column_name from information_schema.columns
 *    where table_schema='public' and table_name='organizations'
 *      and column_name ~ '(fee|price|pct|cents|amount|rate|charge_model|payer|discount|plan)';
 */
const ON_DB_BUT_NOT_IN_ANY_MIGRATION = ['platform_fee_cents', 'platform_monthly_cents'];

function moneyColumnsOnOrganizations(): Set<string> {
  const out = new Set<string>();
  // ALTER TABLE ... organizations ... up to the statement's terminating ;
  // `ONLY` is accepted because ALTER TABLE ONLY is what pg_dump emits, even
  // though no migration currently uses it - a form this missed would be a
  // silent false negative, which is the one direction that matters here.
  const stmtRe =
    /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?organizations\b([\s\S]*?);/gi;
  const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
  // A column that was later DROPPED is not on the table and must not be
  // reported - the pay_* rate columns were added in May and dropped in June, and
  // reporting them means carrying classifications for columns nobody can change
  // because they do not exist.
  const dropRe = /drop\s+column\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;

  for (const name of migrationFiles()) {
    const src = Deno.readTextFileSync(new URL(name, MIGRATIONS));
    for (const stmt of src.matchAll(stmtRe)) {
      for (const col of stmt[1].matchAll(addRe)) {
        const c = col[1].toLowerCase();
        if (MONEY_NAME.test(c)) out.add(c);
      }
      // Applied after the adds in the same statement, and in file order across
      // migrations, so a drop-then-re-add still ends up present.
      for (const col of stmt[1].matchAll(dropRe)) out.delete(col[1].toLowerCase());
    }
  }
  for (const c of ON_DB_BUT_NOT_IN_ANY_MIGRATION) out.add(c);
  return out;
}

/**
 * Money columns that are deliberately NEITHER locked NOR audited, each with the
 * reason. This is the escape hatch, and it is deliberately noisy: adding a line
 * here is a decision somebody made on purpose, which is the whole difference
 * between this and the silence that let two columns through.
 */
const DELIBERATELY_UNCLASSIFIED: Record<string, string> = {
  // Sibling discount is the provider's own promotion on their own prices.
  sibling_discount_pct: 'the provider discounting their own price to their own families',
};

Deno.test('the money-column list is derived from the schema and is not empty', () => {
  // If the discovery above ever breaks - a migration style it cannot parse, a
  // renamed table - every assertion below would iterate nothing and pass. Pin
  // the shape first, and pin the specific columns whose absence would be silent.
  const found = moneyColumnsOnOrganizations();
  assert(found.size >= 8, `expected the money columns, got ${JSON.stringify([...found])}`);
  for (
    const must of [
      'platform_fee_card_pct',
      'platform_fee_ach_cap_cents',
      'platform_fee_override_until',
      'stripe_fee_payer',
      'stripe_charge_model',
      'withdrawal_admin_fee_cents',
    ]
  ) {
    assert(found.has(must), `schema scan lost ${must}; the ADD COLUMN parser has drifted`);
  }
});

Deno.test('every money column on organizations is locked, audited, or deliberately neither', () => {
  const locked = gatedColumns(latestDefinitionOf('guard_organizations_locked_columns').body);
  const audited = gatedColumns(latestDefinitionOf('audit_organization_money').body);

  const unclassified = [...moneyColumnsOnOrganizations()]
    .filter((c) => !locked.has(c) && !audited.has(c) && !(c in DELIBERATELY_UNCLASSIFIED))
    .sort();

  assertEquals(
    unclassified,
    [],
    'these money columns on `organizations` are neither locked nor audited, and members_update_own_org ' +
      'has no WITH CHECK - so an org admin can change them on their own organisation with no record. ' +
      'Lock it, audit it, or add it to DELIBERATELY_UNCLASSIFIED with the reason.',
  );
});

Deno.test('the fee columns the resolver reads are all locked', () => {
  // ORG_FEE_COLUMNS is no longer the source of truth - it is read by nothing in
  // production, so it cannot be trusted to grow. It is still worth asserting:
  // anything the fee resolver DOES read is a platform term and must be locked.
  const locked = gatedColumns(latestDefinitionOf('guard_organizations_locked_columns').body);
  const missing = ORG_FEE_COLUMNS.split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .filter((c) => !locked.has(c));
  assertEquals(
    missing,
    [],
    'these columns feed resolveFeeConfig but an org admin can change them on their own organisation.',
  );
});

Deno.test('stripe_fee_payer and stripe_charge_model are both locked and audited', () => {
  // Who bears Stripe's processing cost, and whose balance it comes out of. An
  // operator moving either would shift real money onto the Enrops balance.
  const locked = gatedColumns(latestDefinitionOf('guard_organizations_locked_columns').body);
  const audited = gatedColumns(latestDefinitionOf('audit_organization_money').body);
  for (const col of ['stripe_fee_payer', 'stripe_charge_model']) {
    assert(locked.has(col), `${col} decides where real money goes and must be platform-admin only`);
    assert(audited.has(col), `${col} must leave a record of who changed it`);
  }
});

Deno.test('fee_pass_through and withdrawal_admin_fee_cents are audited but deliberately NOT locked', () => {
  // Money layer section 4: "The business can turn on cover the fee." And the
  // withdrawal admin fee is the provider's own deduction on a refund. Both are
  // the operator's decisions to make, so locking them would break a documented
  // setting - but both change what a family pays or gets back, so both are
  // recorded. Asserted in BOTH directions so the "fix" the next person reaches
  // for (locking them) fails loudly instead of quietly removing an operator
  // control.
  const locked = gatedColumns(latestDefinitionOf('guard_organizations_locked_columns').body);
  const audited = gatedColumns(latestDefinitionOf('audit_organization_money').body);
  for (const col of ['fee_pass_through', 'withdrawal_admin_fee_cents']) {
    assert(audited.has(col), `${col} changes what families pay and must stay in the audit`);
    assert(
      !locked.has(col),
      `${col} is now locked, which takes away a documented operator setting. ` +
        'If that is intended, change the doc first.',
    );
  }
});

Deno.test('both functions are actually bound to organizations by a trigger', () => {
  // The whole file checks function TEXT. A function nothing calls locks nothing,
  // and the guard trigger is created in exactly one migration from May - so a
  // later `drop trigger` would unlock every column above with every test here
  // still green. Assert the binding exists, and that nothing drops it afterwards.
  for (const fn of ['guard_organizations_locked_columns', 'audit_organization_money']) {
    // MATCH THE DROP ON THE TRIGGER'S OWN NAME, NOT THE FUNCTION'S. The two
    // differ: prod and staging carry `guard_organizations_locked_columns` and
    // `trg_audit_organization_money`. A `DROP TRIGGER trg_audit_organization_money`
    // does not contain `\baudit_organization_money\b` at a word boundary, so
    // matching on the function name silently misses the drop that matters. Found
    // by mutating this very test - which is the only reason it is right.
    const createRe = new RegExp(
      `CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([a-z_][a-z0-9_]*)[\\s\\S]{0,400}?` +
        `ON\\s+(?:public\\.)?organizations[\\s\\S]{0,200}?` +
        `EXECUTE\\s+(?:PROCEDURE|FUNCTION)\\s+(?:public\\.)?${fn}\\s*\\(`,
      'i',
    );

    let createdIn: string | null = null;
    let triggerName: string | null = null;
    let droppedAfter: string | null = null;

    for (const name of migrationFiles()) {
      const src = Deno.readTextFileSync(new URL(name, MIGRATIONS));

      // A DROP followed by its own CREATE in the same file is the ordinary
      // idempotent re-bind, not a removal - so check CREATE first and let it
      // clear any drop seen earlier.
      const created = createRe.exec(src);
      if (created) {
        createdIn = name;
        triggerName = created[1];
        droppedAfter = null;
        continue;
      }
      if (triggerName) {
        const dropRe = new RegExp(
          `DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${triggerName}\\s+ON\\s+(?:public\\.)?organizations`,
          'i',
        );
        if (dropRe.test(src)) droppedAfter = name;
      }
    }

    assert(createdIn, `nothing binds ${fn} to organizations, so it gates nothing`);
    assertEquals(
      droppedAfter,
      null,
      `${droppedAfter} drops the ${triggerName} trigger and no later migration re-creates it, ` +
        'so every column this file checks is unguarded on the database.',
    );
  }
});
