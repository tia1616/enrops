#!/usr/bin/env node
// scripts/check-select-grants.mjs
//
// WHAT THIS PREVENTS. On 7 Aug 2026 migration 20260806d replaced the table-level
// SELECT grant on `districts` with a COLUMN allowlist — (id, organization_id,
// name). CalendarsList asks for `calendar_key`, which was not in it. Postgres
// refuses the whole statement BEFORE RLS is consulted, so the page died with a
// flat `42501 permission denied for table districts`. It was reported by a live
// tenant on 14 Aug: seven days in production.
//
// No static gate could have caught it. The build was green, the types were fine,
// the migration was valid SQL, and the person who shipped it had access. The only
// thing that knows is the database.
//
// WHAT THIS DOES. Extracts every (table, columns) pair the frontend and the edge
// functions actually read, then emits SQL that answers two questions per column
// against a LIVE database:
//
//   1. does the column exist?                  (missing -> PostgREST fails the
//                                               whole query, not just the field)
//   2. is SELECT granted on it to `authenticated`? (not granted -> 42501)
//
// It deliberately does NOT connect to the database itself. Credentials for prod
// do not belong in a repo script, and the parity tooling already has a reviewed
// read-only path: run the emitted SQL through the Supabase MCP `execute_sql`
// against BOTH staging and prod. Prod is not staging in the same way — for
// districts, staging had three granted columns and prod had none.
//
// USAGE
//   node scripts/check-select-grants.mjs              # every read in the repo
//   node scripts/check-select-grants.mjs --diff       # only tables the diff touches
//   node scripts/check-select-grants.mjs --table districts
//
// WHY column_privileges AND NOT the two obvious tools. Both lied during the
// original diagnosis, in opposite directions:
//   - information_schema.role_table_grants shows NOTHING for a column-level
//     grant, so the table reads as having no SELECT whatsoever.
//   - has_table_privilege(...,'SELECT') returns FALSE when the privilege is held
//     per-column, so it disagrees with an API call that actually succeeds.
// information_schema.column_privileges is the one that reports both shapes. A
// table-level grant appears there as a row per column, which is what makes the
// single query below correct for either shape.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const onlyDiff = args.includes('--diff');
const onlyTable = args.includes('--table') ? args[args.indexOf('--table') + 1] : null;

// ---------------------------------------------------------------------------
// Collect source files.
// ---------------------------------------------------------------------------
const SCAN_DIRS = ['src', 'supabase/functions'];
const SCAN_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXT.some((e) => name.endsWith(e)) && !name.includes('.test.')) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(repoRoot, d)));

// ---------------------------------------------------------------------------
// Extract .from('table')...select('a, b, c') pairs.
//
// Deliberately conservative: it only reports pairs where BOTH the table name and
// the whole select list are literal strings, because anything else cannot be
// resolved without running the code. Unresolvable reads are counted and printed
// rather than silently dropped — a check that quietly covers 60% of the reads
// while reading as complete is the failure mode gate U is about.
// ---------------------------------------------------------------------------
const FROM_SELECT = /\.from\(\s*['"`]([a-zA-Z0-9_]+)['"`]\s*\)([\s\S]{0,400}?)\.select\(\s*(['"`])([\s\S]*?)\3/g;
const FROM_DYNAMIC = /\.from\(\s*[^'"`)]/g;
const SELECT_DYNAMIC = /\.select\(\s*[^'"`)]/g;

const reads = new Map();   // table -> Map(column -> Set(file:line))
let unresolved = 0;

function noteRead(table, column, where) {
  if (!reads.has(table)) reads.set(table, new Map());
  const cols = reads.get(table);
  if (!cols.has(column)) cols.set(column, new Set());
  cols.get(column).add(where);
}

// A select list may contain embedded resources — parents(name, email) — and
// modifiers like `count`. Take the top-level names plus the nested ones, since a
// nested resource is a read of ANOTHER table and its own grant applies there.
function topLevelColumns(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(repoRoot, file).replace(/\\/g, '/');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  for (const m of src.matchAll(FROM_SELECT)) {
    const [table, , , list] = [m[1], m[2], m[3], m[4]];
    const where = `${rel}:${lineOf(m.index)}`;
    if (list.trim() === '*') { noteRead(table, '*', where); continue; }
    for (const entry of topLevelColumns(list)) {
      // embedded resource:  parents(name, email)   or   parents!inner(name)
      const nested = entry.match(/^([a-zA-Z0-9_]+)(?:![a-zA-Z]+)?\s*\(([\s\S]*)\)$/);
      if (nested) {
        for (const c of topLevelColumns(nested[2])) {
          noteRead(nested[1], c.replace(/^.*:/, '').trim(), where);
        }
        continue;
      }
      // alias:real_column  ->  the grant applies to the real column
      const col = entry.includes(':') ? entry.split(':').pop().trim() : entry;
      // strip ->>'json' accessors and ::casts, keep the base column
      const base = col.replace(/(->>?|::).*$/, '').trim();
      if (base && /^[a-zA-Z0-9_]+$/.test(base)) noteRead(table, base, where);
    }
  }

  unresolved += [...src.matchAll(FROM_DYNAMIC)].length + [...src.matchAll(SELECT_DYNAMIC)].length;
}

// ---------------------------------------------------------------------------
// Optional narrowing.
// ---------------------------------------------------------------------------
let tables = [...reads.keys()].sort();

if (onlyTable) tables = tables.filter((t) => t === onlyTable);

if (onlyDiff) {
  let changed = '';
  try {
    const base = execSync('git merge-base HEAD origin/staging', { cwd: repoRoot }).toString().trim();
    changed = execSync(`git diff ${base}..HEAD --name-only`, { cwd: repoRoot }).toString();
  } catch {
    console.error('--diff: could not resolve a merge-base against origin/staging; scanning everything instead.');
  }
  if (changed) {
    // A table is in scope if a changed file reads it, or a changed migration names it.
    const changedFiles = new Set(changed.split('\n').map((s) => s.trim()).filter(Boolean));
    const migrationText = [...changedFiles]
      .filter((f) => f.startsWith('supabase/migrations/'))
      .map((f) => { try { return readFileSync(join(repoRoot, f), 'utf8'); } catch { return ''; } })
      .join('\n');
    tables = tables.filter((t) => {
      const readByChanged = [...reads.get(t).values()]
        .some((set) => [...set].some((w) => changedFiles.has(w.split(':')[0])));
      return readByChanged || new RegExp(`\\b${t}\\b`).test(migrationText);
    });
  }
}

if (tables.length === 0) {
  console.log('No literal (table, column) reads in scope. Nothing to check.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Report + emit SQL.
// ---------------------------------------------------------------------------
const starTables = tables.filter((t) => reads.get(t).has('*'));

console.log(`# Column reads to verify — ${tables.length} tables\n`);
for (const t of tables) {
  const cols = [...reads.get(t).keys()].filter((c) => c !== '*').sort();
  const star = reads.get(t).has('*') ? '  [also read with select(*)]' : '';
  console.log(`${t}${star}`);
  if (cols.length) console.log(`  ${cols.join(', ')}`);
}

if (starTables.length) {
  console.log(`\n# NOTE: select('*') cannot be column-checked — a column allowlist grant`);
  console.log(`# breaks it as soon as the table gains an ungranted column. Tables: ${starTables.join(', ')}`);
}
console.log(`\n# NOTE: ${unresolved} dynamic .from()/.select() call sites were NOT resolved`);
console.log(`# (computed table or column list). This check does not cover them.`);

const values = tables
  .flatMap((t) => [...reads.get(t).keys()].filter((c) => c !== '*').map((c) => `('${t}','${c}')`))
  .join(',\n    ');

console.log(`
-- ===========================================================================
-- Run against STAGING and PROD via the Supabase MCP execute_sql (read-only).
-- Any row returned is a broken read: the column is missing, or SELECT is not
-- granted to authenticated and PostgREST will 42501 the whole statement.
--
-- column_privileges is used on purpose. role_table_grants shows nothing for a
-- column-level grant and has_table_privilege() returns false for one, so both
-- report a working read as broken. See scripts header.
-- ===========================================================================
WITH wanted(table_name, column_name) AS (
  VALUES
    ${values}
)
SELECT
  w.table_name,
  w.column_name,
  CASE WHEN c.column_name IS NULL THEN 'COLUMN MISSING'
       WHEN p.column_name IS NULL THEN 'SELECT NOT GRANTED to authenticated'
  END AS problem
FROM wanted w
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name   = w.table_name
 AND c.column_name  = w.column_name
LEFT JOIN information_schema.column_privileges p
  ON p.table_schema = 'public'
 AND p.table_name   = w.table_name
 AND p.column_name  = w.column_name
 AND p.privilege_type = 'SELECT'
 AND p.grantee IN ('authenticated', 'PUBLIC')
WHERE c.column_name IS NULL OR p.column_name IS NULL
ORDER BY w.table_name, w.column_name;
`);
