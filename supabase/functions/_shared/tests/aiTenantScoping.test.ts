// Drift guard: every AI (Anthropic-calling) edge function must only read
// tenant-content tables in an org-scoped or id-keyed way, so one tenant's
// content can never be pulled into another tenant's model context.
//
// Why this test exists: on 2026-07-09 we audited every LLM call site and
// confirmed each grounds its prompt only on the caller's own organization.
// This test freezes that invariant so a future edit that adds an UNSCOPED
// read (e.g. `.from("curricula").select("*")` with no org filter) into an
// AI function fails CI instead of silently leaking across tenants.
//
// The rule: in any function whose source imports "@anthropic-ai/sdk", every
// pure READ (`.select(...)`) from a tenant-content table must reference
// `organization_id` OR be keyed by an id column (`.eq/.in("id"|"*_id", …)`).
// A read that scans a whole tenant table with neither is the drift we forbid.
//
// If this test fails on a legitimately-safe new read, don't just delete the
// assertion: either add the org filter, or (if the read is genuinely scoped
// some other way) document it and widen the SAFE_SCOPE check deliberately.

import { assertEquals, assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";

// Tables that hold tenant content (each carries organization_id). Reads of
// these inside an AI function are what could leak into a prompt. Auth/infra
// tables (org_members, platform_admins, organizations) are excluded — they
// gate access rather than supply prompt content. Grow this list if a new
// tenant-content table starts feeding AI prompts.
const TENANT_CONTENT_TABLES = new Set([
  "curricula",
  "curriculum_documents",
  "curriculum_extracted_fields",
  "curriculum_sessions",
  "programs",
  "camp_sessions",
  "program_locations",
  "class_schedule",
  "marketing_recipients",
  "registrations",
  "parents",
  "partners",
  "contacts",
]);

const FUNCTIONS_ROOT = new URL("../../", import.meta.url);

async function listFunctionDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for await (const entry of Deno.readDir(FUNCTIONS_ROOT)) {
    if (entry.isDirectory && entry.name !== "_shared") dirs.push(entry.name);
  }
  return dirs;
}

async function readIndex(dir: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(new URL(`./${dir}/index.ts`, FUNCTIONS_ROOT));
  } catch {
    return null; // some functions have no index.ts (skip)
  }
}

function isAiFunction(src: string): boolean {
  return src.includes("@anthropic-ai/sdk");
}

// A `.from("table")…` statement, sliced to the next `;`.
type Stmt = { table: string; text: string };

function extractFromStatements(src: string): Stmt[] {
  const out: Stmt[] = [];
  const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const semi = src.indexOf(";", start);
    const text = src.slice(start, semi === -1 ? start + 600 : semi);
    out.push({ table: m[1], text });
  }
  return out;
}

// A pure read: selects rows and is not an insert/update/upsert/delete (those
// are writes; an insert-with-returning `.select()` doesn't pull other rows).
function isPureRead(text: string): boolean {
  if (!text.includes(".select(")) return false;
  return !/\.(insert|update|upsert|delete)\(/.test(text);
}

// Scoped = mentions organization_id, or is keyed by an id / *_id column.
function isOrgScopedOrIdKeyed(text: string): boolean {
  if (text.includes("organization_id")) return true;
  return /\.(eq|in)\(\s*["'`](id|[a-z_]+_id)["'`]/.test(text);
}

Deno.test("AI edge functions only read tenant tables org-scoped or id-keyed", async () => {
  const dirs = await listFunctionDirs();
  const violations: string[] = [];
  let aiFnCount = 0;
  let tenantReadCount = 0;

  for (const dir of dirs) {
    const src = await readIndex(dir);
    if (!src || !isAiFunction(src)) continue;
    aiFnCount++;

    for (const stmt of extractFromStatements(src)) {
      if (!TENANT_CONTENT_TABLES.has(stmt.table)) continue;
      if (!isPureRead(stmt.text)) continue;
      tenantReadCount++;
      if (!isOrgScopedOrIdKeyed(stmt.text)) {
        const preview = stmt.text.replace(/\s+/g, " ").slice(0, 120);
        violations.push(`${dir}: unscoped read of "${stmt.table}" → ${preview}…`);
      }
    }
  }

  // Sanity: prove the scanner actually found AI functions and tenant reads,
  // so a broken path/regex can't produce a falsely-green pass.
  assert(aiFnCount >= 6, `expected to scan >=6 AI functions, saw ${aiFnCount}`);
  assert(tenantReadCount >= 5, `expected to find >=5 tenant reads, saw ${tenantReadCount}`);

  assertEquals(violations, []);
});
