// Every money column on `organizations` must be locked against operator edits,
// written to the audit trail, or deliberately neither WITH A WRITTEN REASON.
// `members_update_own_org` is `FOR UPDATE USING (...)` with NO WITH CHECK, so an
// org admin can write any column the trigger does not name.
//
// WHAT HAPPENED, 2026-09-18 to 2026-09-22. Four money columns went unprotected:
// platform_fee_ach_cap_cents, platform_fee_override_until, stripe_charge_model
// and withdrawal_admin_fee_cents. This file existed the whole time and said
// nothing, in three separate versions.
//
// THIS IS THE THIRD VERSION, AND THE FIRST TWO BOTH REPORTED GREEN OVER A
// COMPLETELY UNLOCKED TABLE. A max-effort review proved it by mutation. Read the
// three ways they failed before changing anything here, because each one looked
// obviously correct when written:
//
//   1. COMMENT BLINDNESS. Matching ran over the raw SQL text, so `-- ` in front
//      of a lock clause left it reading as locked, and a LATER migration that
//      merely QUOTED the function in a documentation comment was selected as its
//      definition - after which the entire lock chain could be deleted from the
//      real migration with this file still green. The previous version's header
//      claimed "a comment does not match - which is the entire point". It did.
//
//   2. WHOLE-BODY MATCHING. `NEW.x IS DISTINCT FROM OLD.x` was counted anywhere
//      in the guard, so moving a column out of the refusing IF and into a
//      harmless one (`... THEN NEW.updated_at := now()`) still read as locked.
//      Only the condition of an IF that RAISEs actually refuses anything.
//
//   3. THE COLUMN LIST CAME FROM THE MIGRATIONS. That misses a column created in
//      a CREATE TABLE (platform_plan), a column applied straight to the database
//      (platform_fee_cents, platform_monthly_cents - two real examples), a
//      RENAME, an `ADD` without the COLUMN keyword, and everything after a
//      semicolon that appears inside a comment in a multi-column ALTER. The list
//      now comes from a checked-in snapshot of the LIVE schema, unioned with the
//      migration scan so a column added but not yet snapshotted is still caught.
//
// AND THE OTHER HALF, WHICH ALL THREE VERSIONS MISSED ENTIRELY: inferring the
// expected set from column NAMES cannot notice a lock being REMOVED from a
// column whose name does not look like money. `stripe_account_id` - the Stripe
// payout destination - is locked by the guard and matched no money pattern, so
// deleting its lock passed. The expectations below are therefore EXPLICIT lists,
// not inferences. A name pattern finds columns nobody classified; only a list
// can notice a protection disappearing.
//
// SCOPE, honestly. This reads migration TEXT plus a snapshot. It cannot see a
// function edited directly in a database. Both databases were read back and
// confirmed identical on 2026-09-22 (guard ebdd8d26, audit 32ade279); the
// standing re-check is `select md5(prosrc) from pg_proc` on each.

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);
const SNAPSHOT_FILE = new URL('./organizationsColumns.snapshot.json', import.meta.url);

// ── Expectations. Explicit, because an inference cannot notice a removal. ─────

/**
 * Columns only an Enrops platform admin may change. Removing any lock below
 * fails this file, which is the entire point of stating them rather than
 * deriving them.
 */
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
  'sending_domain', // Resend-verified; its own RAISE, not the platform-admin one
];

/** Columns whose change must leave a record of who made it. */
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
 * Operator controls. Asserted in the NEGATIVE so that the "fix" the next person
 * reaches for - locking them - fails loudly instead of quietly removing a
 * documented setting.
 */
const MUST_NOT_BE_LOCKED: Record<string, string> = {
  fee_pass_through: 'money layer section 4: "the business can turn on cover the fee"',
  withdrawal_admin_fee_cents: "the provider's own deduction on a refund, typed on Finances",
};

/**
 * Money-ish columns deliberately neither locked nor audited. The escape hatch,
 * kept deliberately expensive: the reason is asserted to be a real sentence, and
 * a key for a column that no longer exists fails, so this cannot silently rot
 * into a list of excuses for columns nobody remembers.
 */
const DELIBERATELY_UNCLASSIFIED: Record<string, string> = {
  sibling_discount_pct:
    'the provider discounting their own price to their own families - their promotion, not a platform term',
  stripe_payouts_enabled:
    "a MIRROR of Stripe's own account capability, not a setting anyone types. Written only by " +
    'stripe-webhook and refresh-stripe-status from what Stripe reports; an operator editing it changes ' +
    'nothing about whether Stripe will actually pay them, so locking it would guard a cache, and ' +
    'auditing it would record Stripe account events as if a person had made them. Matched only ' +
    'because "payout" is in the money-name pattern, which is the pattern doing its job.',
};

// ── Reading SQL, which is where the last two versions went wrong ─────────────

/**
 * SQL with comments removed, honouring string and dollar-quoted literals.
 *
 * EVERY match in this file runs on stripped text. Both proven false passes came
 * from matching raw SQL: `-- ` in front of a lock clause read as a lock, and a
 * migration that merely quoted the function in a comment was chosen as its
 * definition.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      out += '\n'; // keep line structure so nothing merges across lines
      i = nl + 1;
      continue;
    }

    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }

    if (sql[i] === "'") {
      // Single-quoted literal; '' is an escaped quote inside it.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }

    const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
    if (tag) {
      // RECURSE INTO THE BODY. A plpgsql function body IS a dollar-quoted
      // literal, so copying it verbatim - the obvious reading of "preserve
      // string literals" - leaves every comment in the function unstripped, and
      // comment blindness is exactly what this function exists to fix. The first
      // attempt at this rewrite did precisely that and a commented-out lock
      // clause still read as a lock. Caught by re-running the mutation.
      const inner = i + tag[0].length;
      const close = sql.indexOf(tag[0], inner);
      const end = close === -1 ? sql.length : close;
      out += tag[0] + stripSqlComments(sql.slice(inner, end)) + (close === -1 ? '' : tag[0]);
      i = close === -1 ? sql.length : close + tag[0].length;
      continue;
    }

    out += sql[i];
    i++;
  }
  return out;
}

function migrationFiles(): string[] {
  return [...Deno.readDirSync(MIGRATIONS)]
    .filter((e) => e.isFile && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
}

const VERSION_PREFIX = /^([0-9]{8}[a-z]?)/;

/** Every migration's source, comments stripped, in filename order. */
function strippedMigrations(): { name: string; src: string }[] {
  return migrationFiles().map((name) => ({
    name,
    src: stripSqlComments(Deno.readTextFileSync(new URL(name, MIGRATIONS))),
  }));
}

/**
 * The body of JUST `fnName`, from the LAST migration that really defines it.
 *
 * Comments are stripped first, so a file that only MENTIONS the function in
 * prose cannot be selected. The dollar-quote tag is read rather than assumed:
 * `AS $$`, `AS $function$` and `AS $_$` are all legal and all appear here, and
 * $function$ is what pg_get_functiondef emits.
 */
function latestDefinitionOf(fnName: string): { file: string; body: string } {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fnName}\\s*\\(`,
    'i',
  );

  const definers = strippedMigrations()
    .map(({ name, src }) => ({ name, src, m: re.exec(src) }))
    .filter((d) => d.m !== null) as { name: string; src: string; m: RegExpExecArray }[];

  assert(
    definers.length > 0,
    `no migration defines ${fnName} any more. If it was renamed, this test needs the new name - do not delete the test.`,
  );

  const last = definers[definers.length - 1];
  if (definers.length > 1) {
    const prev = definers[definers.length - 2];
    const pa = VERSION_PREFIX.exec(last.name)?.[1];
    const pb = VERSION_PREFIX.exec(prev.name)?.[1];
    assert(
      !pa || !pb || pa !== pb,
      `${last.name} and ${prev.name} share the version prefix "${pa}" and BOTH define ${fnName}, ` +
        'so which one the database applied last cannot be read off the filenames. Rename one.',
    );
  }

  const { name, src, m } = last;
  const at = m.index;
  const tagMatch = /\bAS\s+(\$[A-Za-z_0-9]*\$)/i.exec(src.slice(at));
  assert(tagMatch, `the newest ${fnName} (${name}) has no "AS $tag$" body; this test needs updating`);
  const tag = tagMatch![1];
  const open = at + tagMatch!.index + tagMatch![0].length - tag.length;
  const close = src.indexOf(tag, open + tag.length);
  assert(close !== -1, `the newest ${fnName} (${name}) has an unterminated ${tag} body`);
  return { file: name, body: src.slice(at, close + tag.length) };
}

const GATE = /NEW\.([a-z_][a-z0-9_]*)\s+IS\s+DISTINCT\s+FROM\s+OLD\.\1\b/gi;

function columnsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(GATE)) out.add(m[1].toLowerCase());
  return out;
}

/**
 * The columns the guard actually REFUSES on.
 *
 * Only the condition of an IF whose body raises counts. Matching the whole body
 * was proven wrong: moving a column into an IF that merely sets `updated_at`
 * left it reading as locked while the guard refused nothing for it.
 */
function refusedColumns(guardBody: string): Set<string> {
  const out = new Set<string>();
  const ifRe = /\bIF\b([\s\S]*?)\bTHEN\b([\s\S]*?)(?=\bEND\s+IF\b)/gi;
  for (const m of guardBody.matchAll(ifRe)) {
    if (!/\bRAISE\s+EXCEPTION\b/i.test(m[2])) continue;
    for (const c of columnsIn(m[1])) out.add(c);
  }
  return out;
}

/**
 * The columns the audit function actually WRITES A ROW for. Same rule: the
 * condition of an IF whose body inserts, not the whole body - each block also
 * names its column as a quoted label, which is text, not a gate.
 */
function auditedColumns(auditBody: string): Set<string> {
  const out = new Set<string>();
  const ifRe = /\bIF\b([\s\S]*?)\bTHEN\b([\s\S]*?)(?=\bEND\s+IF\b)/gi;
  for (const m of auditBody.matchAll(ifRe)) {
    if (!/\bINSERT\s+INTO\b/i.test(m[2])) continue;
    for (const c of columnsIn(m[1])) out.add(c);
  }
  return out;
}

// ── Discovering columns nobody has classified ────────────────────────────────

const SNAPSHOT: { columns: string[]; column_count: number } = JSON.parse(
  Deno.readTextFileSync(SNAPSHOT_FILE),
);

const MONEY_NAME =
  /(fee|price|pct|cents|amount|rate|charge_model|payer|discount|plan|surcharge|markup|commission|deposit|tax|payout|balance|tier|minimum)/;

/** Columns on `organizations` added by a migration, as a second source. */
function migrationAddedColumns(): Set<string> {
  const out = new Set<string>();
  const stmtRe =
    /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?organizations"?\b([\s\S]*?);/gi;
  const addRe = /add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
  const dropRe = /drop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
  const renameRe = /rename\s+(?:column\s+)?"?([a-z_][a-z0-9_]*)"?\s+to\s+"?([a-z_][a-z0-9_]*)"?/gi;

  for (const { src } of strippedMigrations()) {
    for (const stmt of src.matchAll(stmtRe)) {
      for (const c of stmt[1].matchAll(addRe)) out.add(c[1].toLowerCase());
      for (const c of stmt[1].matchAll(renameRe)) {
        out.delete(c[1].toLowerCase());
        out.add(c[2].toLowerCase());
      }
      for (const c of stmt[1].matchAll(dropRe)) out.delete(c[1].toLowerCase());
    }
  }
  return out;
}

/**
 * The candidate set: the live snapshot UNION what the migrations add.
 *
 * The union matters in both directions. The snapshot cannot see a column added
 * by a migration that has not been re-snapshotted; the migration scan cannot see
 * a column that reached the table without one. Each covers the other's blind
 * spot, and neither is trusted alone.
 */
function moneyColumnsOnOrganizations(): Set<string> {
  const all = new Set<string>([...SNAPSHOT.columns, ...migrationAddedColumns()]);
  return new Set([...all].filter((c) => MONEY_NAME.test(c)));
}

// ── The tests ────────────────────────────────────────────────────────────────

Deno.test('the snapshot is real and the discovery is not vacuous', () => {
  assertEquals(SNAPSHOT.columns.length, SNAPSHOT.column_count, 'snapshot column_count disagrees with its own list');
  assert(SNAPSHOT.columns.length >= 60, `snapshot looks truncated: ${SNAPSHOT.columns.length} columns`);
  const found = moneyColumnsOnOrganizations();
  assert(found.size >= 12, `expected the money columns, got ${JSON.stringify([...found])}`);
});

Deno.test('the snapshot still covers every column the guard and audit name', () => {
  // THE TRIPWIRE FOR A STALE SNAPSHOT. If a migration renames or drops a column
  // and nobody re-runs the query in the snapshot's header, the guard will name a
  // column the snapshot does not list - and that is the moment to notice, not
  // months later when somebody wonders why the list looks short.
  const known = new Set(SNAPSHOT.columns);
  const named = new Set([
    ...refusedColumns(latestDefinitionOf('guard_organizations_locked_columns').body),
    ...auditedColumns(latestDefinitionOf('audit_organization_money').body),
  ]);
  const missing = [...named].filter((c) => !known.has(c)).sort();
  assertEquals(
    missing,
    [],
    'the guard or audit names columns the snapshot does not list. Either the snapshot is stale ' +
      '(re-run the query in its header against BOTH databases) or a trigger references a column ' +
      'that no longer exists.',
  );
});

Deno.test('every column that must be locked, is', () => {
  const refused = refusedColumns(latestDefinitionOf('guard_organizations_locked_columns').body);
  const missing = MUST_BE_LOCKED.filter((c) => !refused.has(c)).sort();
  assertEquals(
    missing,
    [],
    'these columns are no longer refused by guard_organizations_locked_columns, so an org admin can ' +
      'change them on their own organisation via members_update_own_org, which has no WITH CHECK.',
  );
});

Deno.test('every column that must be audited, is', () => {
  const audited = auditedColumns(latestDefinitionOf('audit_organization_money').body);
  const missing = MUST_BE_AUDITED.filter((c) => !audited.has(c)).sort();
  assertEquals(
    missing,
    [],
    'these columns change what a family pays or gets back and would now change with no record of who did it.',
  );
});

Deno.test('the operator controls are audited and deliberately NOT locked', () => {
  const refused = refusedColumns(latestDefinitionOf('guard_organizations_locked_columns').body);
  const audited = auditedColumns(latestDefinitionOf('audit_organization_money').body);
  for (const [col, why] of Object.entries(MUST_NOT_BE_LOCKED)) {
    assert(audited.has(col), `${col} changes what families pay and must stay in the audit`);
    assert(
      !refused.has(col),
      `${col} is now locked, which takes away a documented operator setting (${why}). ` +
        'If that is intended, change the doc first.',
    );
  }
});

Deno.test('no money column is left unclassified', () => {
  const refused = refusedColumns(latestDefinitionOf('guard_organizations_locked_columns').body);
  const audited = auditedColumns(latestDefinitionOf('audit_organization_money').body);
  const unclassified = [...moneyColumnsOnOrganizations()]
    .filter((c) => !refused.has(c) && !audited.has(c) && !(c in DELIBERATELY_UNCLASSIFIED))
    .sort();
  assertEquals(
    unclassified,
    [],
    'these money columns on `organizations` are neither locked nor audited. Lock it, audit it, or add ' +
      'it to DELIBERATELY_UNCLASSIFIED with the reason.',
  );
});

Deno.test('the escape hatch cannot rot', () => {
  const found = moneyColumnsOnOrganizations();
  for (const [col, reason] of Object.entries(DELIBERATELY_UNCLASSIFIED)) {
    assert(
      found.has(col),
      `DELIBERATELY_UNCLASSIFIED names ${col}, which is not a money column on organizations any more. ` +
        'Remove the entry rather than leaving a justification for something that does not exist.',
    );
    assert(
      reason.trim().length >= 20,
      `DELIBERATELY_UNCLASSIFIED["${col}"] needs a real reason, not "${reason}". ` +
        'This is the one place a money column can be left unprotected on purpose; say why.',
    );
  }
});

Deno.test('both functions are bound to organizations, and nothing later unbinds them', () => {
  // The whole file checks function TEXT. A function nothing calls locks nothing.
  // DISABLE is checked as well as DROP: `ALTER TABLE ... DISABLE TRIGGER` turns
  // the guard off just as completely, and tgenabled is the real switch.
  for (const fn of ['guard_organizations_locked_columns', 'audit_organization_money']) {
    const createRe = new RegExp(
      `CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?([a-z_][a-z0-9_]*)"?[\\s\\S]{0,400}?` +
        `ON\\s+(?:public\\.)?"?organizations"?[\\s\\S]{0,200}?` +
        `EXECUTE\\s+(?:PROCEDURE|FUNCTION)\\s+(?:public\\.)?${fn}\\s*\\(`,
      'i',
    );

    let createdIn: string | null = null;
    let triggerName: string | null = null;
    let disarmedBy: string | null = null;

    for (const { name, src } of strippedMigrations()) {
      const created = createRe.exec(src);
      if (created) {
        createdIn = name;
        triggerName = created[1];
        disarmedBy = null; // a DROP followed by its own CREATE is an idempotent re-bind
        continue;
      }
      if (!triggerName) continue;
      // Match the TRIGGER's own name, not the function's: the audit trigger is
      // `trg_audit_organization_money`, and `\baudit_organization_money\b` does
      // not match inside it. Found by mutating this test.
      const disarmRe = new RegExp(
        `(?:DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+(?:public\\.)?"?organizations"?\\s+DISABLE\\s+TRIGGER\\s+)` +
          `"?${triggerName}"?\\b`,
        'i',
      );
      if (disarmRe.test(src)) disarmedBy = name;
    }

    assert(createdIn, `nothing binds ${fn} to organizations, so it gates nothing`);
    assertEquals(
      disarmedBy,
      null,
      `${disarmedBy} drops or disables the ${triggerName} trigger and no later migration re-creates it, ` +
        'so every column this file checks is unguarded on the database.',
    );
  }
});
