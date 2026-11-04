// "Already registered" is a question about a HOUSEHOLD. The latest definition of
// marketing_recipient_already_enrolled must match a registration's guardian
// contact and the child's own parent, never just registrations.parent_id's
// address (the hole that mailed nhoxmeier@gmail.com "register now" on 2026-11-04),
// and must NOT count pickup/do-not-release contacts (they are not the family).
//
// Derived from the newest migration that defines the function, so a later
// CREATE OR REPLACE that drops the rule is caught here.

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const DIR = "supabase/migrations";
const FN = "marketing_recipient_already_enrolled";

function latestDefinition(): { file: string; sql: string } {
  const files = [...Deno.readDirSync(DIR)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  let found: { file: string; sql: string } | null = null;
  for (const f of files) {
    const sql = Deno.readTextFileSync(`${DIR}/${f}`);
    if (new RegExp(`create or replace function public\\.${FN}\\(`, "i").test(sql)) found = { file: f, sql };
  }
  assert(found, "no migration defines the function");
  return found!;
}

Deno.test("the newest definition matches the whole household", () => {
  const { file, sql } = latestDefinition();
  const body = sql.replace(/^\s*--.*$/gm, ""); // comments say what the code must not
  assert(/from student_contacts sc/.test(body), `${file}: must read student_contacts`);
  assert(/sc\.role = 'guardian'/.test(body), `${file}: guardian contacts only`);
  assert(/join parents pa2 on pa2\.id = st\.parent_id/.test(body), `${file}: the child's own parent too`);
  assert(/pa\.id = rg\.parent_id/.test(body), `${file}: the registration's parent still counts`);
});

Deno.test("pickup and do-not-release contacts never count as the family", () => {
  const { file, sql } = latestDefinition();
  const body = sql.replace(/^\s*--.*$/gm, "");
  assert(!/authorized_pickup|do_not_release/.test(body), `${file}: must not match pickup/DNR contacts`);
});

Deno.test("exact_only switches off ONLY the same-site-same-term widening, and only for JSON true", () => {
  const { file, sql } = latestDefinition();
  const body = sql.replace(/^\s*--.*$/gm, "");
  // Parsed as the JSON boolean true - a string "true" or any malformed value must
  // leave the widening ON (it is the narrower, more-sending behaviour).
  assert(/'skip_if_registered' -> 'exact_only'\) = 'true'::jsonb/.test(body), `${file}: exact_only must compare to jsonb true`);
  assert(/not ids\.exact_only/.test(body), `${file}: the widening must be gated on not exact_only`);
  // The exact matches stay outside the gate, so an exact registration always counts.
  assert(/rg\.program_id = any \(ids\.program_ids\)\s+or rg\.camp_session_id = any \(ids\.camp_ids\)\s+or \(\s+not ids\.exact_only/.test(body),
    `${file}: exact program/camp matches must not be behind the exact_only gate`);
});

Deno.test("the household match stays tenant-scoped and service_role-only", () => {
  const { file, sql } = latestDefinition();
  const body = sql.replace(/^\s*--.*$/gm, "");
  assert(/sc\.organization_id = rg\.organization_id/.test(body), `${file}: contacts must be org-scoped`);
  assert(/revoke all on function public\.marketing_recipient_already_enrolled\(uuid, text, jsonb\) from public, anon, authenticated/.test(body));
  assert(/grant execute on function public\.marketing_recipient_already_enrolled\(uuid, text, jsonb\) to service_role/.test(body));
});
