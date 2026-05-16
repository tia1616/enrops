// backfill-curricula.ts
//
// One-time backfill: for every existing `programs.curriculum` text value that
// doesn't yet have a `programs.curriculum_id`, create a draft `curricula` row
// and link the programs to it. Dedupes by normalized title (case + whitespace).
//
// Two modes, both safe by default:
//
//   Dry run (default): writes nothing; produces a preview CSV at
//     scripts/backfill-curricula-preview.csv with one row per proposed
//     curriculum cluster. Open it in Excel, eyeball the variants, then re-run
//     with --apply to actually create the rows.
//
//   Apply: pass --apply to perform the writes. Idempotent: if a curriculum
//     row already exists at the canonical title (case-insensitive match), the
//     programs link to it instead of creating a duplicate.
//
// USAGE (PowerShell):
//   $env:SUPABASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co'
//   $env:SUPABASE_SERVICE_ROLE_KEY = 'eyJ...'    # Supabase Dashboard → Settings → API
//   deno run --allow-env --allow-net --allow-write scripts/backfill-curricula.ts
//   # then review scripts/backfill-curricula-preview.csv
//   deno run --allow-env --allow-net scripts/backfill-curricula.ts --apply

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Set them in PowerShell:");
  console.error("  $env:SUPABASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co'");
  console.error("  $env:SUPABASE_SERVICE_ROLE_KEY = 'eyJ...'");
  Deno.exit(1);
}

const APPLY = Deno.args.includes("--apply");
const PREVIEW_PATH = "scripts/backfill-curricula-preview.csv";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- Normalization & clustering ---

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:.,;()\[\]"']+|[\s\-–—:.,;()\[\]"']+$/g, "")
    .trim();
}

type Program = { id: string; organization_id: string; curriculum: string };
type Cluster = {
  organization_id: string;
  normalized_key: string;
  canonical_title: string;
  variants: Map<string, number>; // spelling → count
  program_ids: string[];
};

function clusterPrograms(programs: Program[]): Cluster[] {
  const byKey = new Map<string, Cluster>();
  for (const p of programs) {
    if (!p.curriculum || !p.curriculum.trim()) continue;
    const norm = normalize(p.curriculum);
    if (!norm) continue;
    const compositeKey = `${p.organization_id}::${norm}`;
    let cluster = byKey.get(compositeKey);
    if (!cluster) {
      cluster = {
        organization_id: p.organization_id,
        normalized_key: norm,
        canonical_title: p.curriculum.trim(),
        variants: new Map(),
        program_ids: [],
      };
      byKey.set(compositeKey, cluster);
    }
    const variantKey = p.curriculum.trim();
    cluster.variants.set(variantKey, (cluster.variants.get(variantKey) ?? 0) + 1);
    cluster.program_ids.push(p.id);
  }
  // Pick canonical title: most common spelling; ties → alphabetical first.
  for (const c of byKey.values()) {
    const sorted = [...c.variants.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    c.canonical_title = sorted[0][0];
  }
  return [...byKey.values()].sort((a, b) =>
    a.organization_id.localeCompare(b.organization_id) || a.canonical_title.localeCompare(b.canonical_title),
  );
}

// --- Pull programs ---

console.log("Querying programs that don't yet have a curriculum_id…");
const { data: progRows, error: progErr } = await admin
  .from("programs")
  .select("id, organization_id, curriculum")
  .is("curriculum_id", null);
if (progErr) {
  console.error("Failed to query programs:", progErr.message);
  Deno.exit(1);
}
const programs = (progRows ?? []) as Program[];
console.log(`  Found ${programs.length} programs needing backfill.`);
if (programs.length === 0) {
  console.log("Nothing to do — all programs already linked.");
  Deno.exit(0);
}

const skippedNoOrg = programs.filter((p) => !p.organization_id);
if (skippedNoOrg.length) {
  console.warn(`  Skipping ${skippedNoOrg.length} programs with NULL organization_id (data quality issue — investigate).`);
}
const validPrograms = programs.filter((p) => p.organization_id);

const clusters = clusterPrograms(validPrograms);
console.log(`  Clustered into ${clusters.length} curricula across ${new Set(clusters.map((c) => c.organization_id)).size} orgs.`);

// --- Preview CSV ---

function csvEscape(v: string | number): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

if (!APPLY) {
  const lines = ["organization_id,canonical_title,normalized_key,total_programs,variant_count,variants"];
  for (const c of clusters) {
    const variantsBlob = [...c.variants.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([spelling, count]) => `${spelling} (${count})`)
      .join(" ; ");
    lines.push([
      csvEscape(c.organization_id),
      csvEscape(c.canonical_title),
      csvEscape(c.normalized_key),
      csvEscape(c.program_ids.length),
      csvEscape(c.variants.size),
      csvEscape(variantsBlob),
    ].join(","));
  }
  await Deno.writeTextFile(PREVIEW_PATH, lines.join("\n") + "\n");
  console.log(`\nDry-run complete. Preview written to ${PREVIEW_PATH}`);
  console.log("Open it in Excel. If it looks right, re-run with --apply.");
  Deno.exit(0);
}

// --- Apply ---

console.log("\nApplying (--apply flag set)…");
let created = 0;
let reused = 0;
let linked = 0;
const failures: Array<{ cluster: string; error: string }> = [];

for (const cluster of clusters) {
  // 1. Find or create the curriculum row (case-insensitive match on existing rows)
  const { data: existing, error: lookupErr } = await admin
    .from("curricula")
    .select("id, name")
    .eq("organization_id", cluster.organization_id)
    .ilike("name", cluster.canonical_title);
  if (lookupErr) {
    failures.push({ cluster: cluster.canonical_title, error: `Lookup failed: ${lookupErr.message}` });
    continue;
  }

  let curriculumId: string | null = null;
  if (existing && existing.length > 0) {
    curriculumId = existing[0].id;
    reused++;
  } else {
    const { data: insertedRow, error: insErr } = await admin
      .from("curricula")
      .insert({
        organization_id: cluster.organization_id,
        name: cluster.canonical_title,
        status: "draft",
      })
      .select("id")
      .single();
    if (insErr || !insertedRow) {
      failures.push({ cluster: cluster.canonical_title, error: `Insert failed: ${insErr?.message ?? "no row"}` });
      continue;
    }
    curriculumId = insertedRow.id;
    created++;
  }

  // 2. Link all programs in this cluster to that curriculum
  const { error: updErr } = await admin
    .from("programs")
    .update({ curriculum_id: curriculumId })
    .in("id", cluster.program_ids);
  if (updErr) {
    failures.push({ cluster: cluster.canonical_title, error: `Link failed: ${updErr.message}` });
    continue;
  }
  linked += cluster.program_ids.length;
}

console.log("\nDone.");
console.log(`  Curricula created:  ${created}`);
console.log(`  Curricula reused:   ${reused}`);
console.log(`  Programs linked:    ${linked}`);
if (failures.length) {
  console.log(`  Failures:           ${failures.length}`);
  for (const f of failures) console.log(`    - ${f.cluster}: ${f.error}`);
}
