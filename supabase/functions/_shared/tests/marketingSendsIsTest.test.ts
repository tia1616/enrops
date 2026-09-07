// Every reader of marketing_sends either filters out test rows, or says out
// loud why it does not.
//
// marketing_sends is the campaign send log, and until 2026-09-07 it could hold
// at most ONE test row per touchpoint: the per-touchpoint dedup refused a second
// test send forever. That cap was removed the same day - Jeff could not
// re-preview the email he was editing - so an operator writing copy now produces
// a row per click, capped only by TEST_SEND_THROTTLE_PER_MINUTE = 30.
//
// The rows are indistinguishable from family sends except by `is_test`, and
// nothing about forgetting the filter fails: it type-checks, it builds, the
// screen renders, and the only symptom is a number quietly counting an
// operator's rehearsals as reach. The first pass of this fix filtered two of the
// THREE readers - the cron's analytics tally was missed - which is the exact
// shape this file exists to catch.
//
// Derived from SOURCE, never from a list retyped here: add a fourth reader and
// this test finds it and holds it to the same rule.

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

/** Files that touch the table at all. Globbing is deliberate - a new reader in
 *  any of these trees is caught without anybody remembering to add it here. */
const SEARCH_ROOTS = ["src", "supabase/functions"];

/** Strip comments so prose describing a query is never mistaken for one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) {
      yield p;
    }
  }
}

type Site = { file: string; statement: string; exempt: boolean };

/**
 * Find every `.from("marketing_sends")` chain that READS (has a .select), and
 * return the statement text plus whether an explicit exemption marker precedes
 * it. Statement boundary is the next `;` at chain depth zero, which is enough
 * for a PostgREST builder chain - these are never multi-statement expressions.
 */
function readSites(file: string, raw: string): Site[] {
  const src = stripComments(raw);
  const out: Site[] = [];
  const needle = `.from("marketing_sends")`;
  let i = src.indexOf(needle);
  while (i !== -1) {
    const end = src.indexOf(";", i);
    const statement = src.slice(i, end === -1 ? src.length : end);
    if (statement.includes(".select(")) {
      // The marker is a COMMENT, so look for it in the raw text (comments are
      // stripped above). Window is generous: the marker sits in the prose block
      // that explains the exemption, which can run several lines.
      const rawIdx = raw.indexOf(needle, Math.max(0, i - 2000));
      const before = raw.slice(Math.max(0, rawIdx - 1500), rawIdx);
      out.push({ file, statement, exempt: before.includes("is_test-exempt:") });
    }
    i = src.indexOf(needle, i + needle.length);
  }
  return out;
}

Deno.test("every marketing_sends read filters is_test, or is explicitly exempt", async () => {
  const sites: Site[] = [];
  for (const root of SEARCH_ROOTS) {
    for await (const file of walk(root)) {
      const raw = await Deno.readTextFile(file);
      if (!raw.includes(`.from("marketing_sends")`)) continue;
      sites.push(...readSites(file, raw));
    }
  }

  // If this drops to zero the test has stopped testing anything - most likely
  // the table was renamed and this file was not.
  assert(sites.length >= 4, `expected at least 4 marketing_sends reads, found ${sites.length}`);

  const offenders = sites.filter((s) => !s.exempt && !s.statement.includes("is_test"));
  assert(
    offenders.length === 0,
    `marketing_sends read without an is_test filter and without an "is_test-exempt:" note:\n` +
      offenders.map((o) => `  ${o.file}: ${o.statement.replace(/\s+/g, " ").slice(0, 160)}`).join("\n"),
  );
});

Deno.test("the sample child name is gated on the send MODE, not on a segment", async () => {
  const raw = await Deno.readTextFile("supabase/functions/marketing-touchpoint-send/index.ts");
  const src = stripComments(raw);

  // The invented name may only be reachable behind isTestSend. Gating on the
  // _internal_admin segment alone put "Nina" in a REAL send: resolveParents with
  // filter.type='master_list' selects every marketing_recipients row in the org
  // with no segment exclusion, so the operator's own bootstrapped admin row is
  // inside approved_recipient_ids on a real campaign.
  // Scoped to the TOKEN FALLBACK lines - the `r.child_*_name?.trim() || ...`
  // expressions that decide what a recipient actually reads. The banner copy
  // also names the constant, and it is gated one level up (usedSampleChild),
  // so matching every mention would flag correct code.
  const fallbackLines = src
    .split("\n")
    .filter((l) => /r\.child_(first|last)_name\?\.trim\(\)\s*\|\|/.test(l));
  assert(
    fallbackLines.length === 2,
    `expected 2 child-name token fallbacks, found ${fallbackLines.length} - has the token builder moved?`,
  );
  const ungated = fallbackLines.filter((l) => !l.includes("isTestSend"));
  assert(
    ungated.length === 0,
    `child-name token fallback reachable without isTestSend:\n` +
      ungated.map((l) => `  ${l.trim()}`).join("\n"),
  );
});
