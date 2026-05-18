// test-extraction-regression.ts
//
// Quality gate for the curriculum-extraction prompt. Runs the three J2S test
// docs through the live extract-curriculum-details function (dev mode, no
// persistence) and asserts on the JSON shape. Run this BEFORE deploying any
// prompt change — it catches drift where the new prompt produces worse output
// than v1 did.
//
// We can't snapshot the raw JSON because the model has run-to-run variance.
// Instead we assert on structural and quality properties (session count,
// session structure, recap-template shape, no education jargon, etc.).
//
// PRE-REQS (do this once):
//   1. Upload the three J2S test docs into the curriculum-documents bucket.
//      Default paths (override via env vars if needed):
//        _test/lego-game-makers.pdf      → LEGO Game Makers (11 sessions, afterschool, ages 6-10)
//        _test/minecraft-makers.pdf      → Minecraft Makers (10 sessions, afterschool, ages 7-11)
//        _test/toy-designers.pdf         → Toy Designers Camp (5 sessions, summer_camp, ages 6-10)
//
//   2. Set env vars:
//        $env:SUPABASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co'
//        $env:SUPABASE_ANON_KEY = 'eyJ...'                       # public anon key (vite VITE_SUPABASE_ANON_KEY)
//        $env:ADMIN_EMAIL = 'jessica@journeytosteam.com'         # your platform-admin email
//        $env:ADMIN_PASSWORD = '<your password>'                  # platform-admin password
//      Optional overrides:
//        $env:DOC_PATH_LEGO       = '_test/lego-game-makers.pdf'
//        $env:DOC_PATH_MINECRAFT  = '_test/minecraft-makers.pdf'
//        $env:DOC_PATH_TOY        = '_test/toy-designers.pdf'
//        $env:PROMPT_VERSION      = 'v2'   # defaults to v2 (current production prompt)
//
//   3. Run:
//        deno run --allow-env --allow-net scripts/test-extraction-regression.ts
//
// Exit code 0 = all assertions pass; 1 = at least one failed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const EMAIL = Deno.env.get("ADMIN_EMAIL");
const PASSWORD = Deno.env.get("ADMIN_PASSWORD");
const PROMPT_VERSION = Deno.env.get("PROMPT_VERSION") ?? "v2";
if (!SUPABASE_URL || !ANON_KEY || !EMAIL || !PASSWORD) {
  console.error("Missing one of: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL, ADMIN_PASSWORD.");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log("Signing in as platform admin…");
const { data: signinData, error: signinErr } = await supabase.auth.signInWithPassword({
  email: EMAIL,
  password: PASSWORD,
});
if (signinErr || !signinData.session) {
  console.error("Sign-in failed:", signinErr?.message);
  Deno.exit(1);
}
const accessToken = signinData.session.access_token;

// --- Test cases ---

type TestCase = {
  slug: string;
  label: string;
  docPath: string;
  expected: {
    sessionCount: number;
    format: "afterschool" | "summer_camp" | "other";
    sessionTypes: string[]; // values that must be present
    ageRange: { min: number; max: number };
    themesInclude?: string[]; // any of these substrings (case-insensitive) must appear in the themes array
    titleIncludes?: string[]; // any of these substrings must appear in extracted name
  };
};

const TESTS: TestCase[] = [
  {
    slug: "lego",
    label: "LEGO Game Makers",
    docPath: Deno.env.get("DOC_PATH_LEGO") ?? "_test/lego-game-makers.pdf",
    expected: {
      sessionCount: 11,
      format: "afterschool",
      sessionTypes: ["afterschool"],
      ageRange: { min: 6, max: 10 },
      themesInclude: ["pokémon", "pokemon", "minecraft", "demon slayer", "lego"],
      titleIncludes: ["lego", "game", "maker"],
    },
  },
  {
    slug: "minecraft",
    label: "Minecraft Makers",
    docPath: Deno.env.get("DOC_PATH_MINECRAFT") ?? "_test/minecraft-makers.pdf",
    expected: {
      sessionCount: 10,
      format: "afterschool",
      sessionTypes: ["afterschool"],
      ageRange: { min: 7, max: 11 },
      themesInclude: ["minecraft"],
      titleIncludes: ["minecraft"],
    },
  },
  {
    slug: "toy",
    label: "Toy Designers Camp",
    docPath: Deno.env.get("DOC_PATH_TOY") ?? "_test/toy-designers.pdf",
    expected: {
      sessionCount: 5,
      format: "summer_camp",
      sessionTypes: ["full_day", "half_day_am", "half_day_pm"],
      ageRange: { min: 6, max: 10 },
      titleIncludes: ["toy", "designer"],
    },
  },
];

const JARGON_BLACKLIST = [
  "computational thinking",
  "21st century skills",
  "21st-century skills",
  "social-emotional learning",
  "fine motor skills",
  "boost confidence",
  "build self-esteem",
  "feel proud",
];

// --- Helpers ---

type Result = { case: string; passes: string[]; fails: string[] };

async function runOne(tc: TestCase): Promise<Result> {
  const result: Result = { case: tc.label, passes: [], fails: [] };

  // SSE call
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/extract-curriculum-details`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY!,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ document_path: tc.docPath, prompt_version: PROMPT_VERSION }),
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    result.fails.push(`Function call failed (${resp.status}): ${text}`);
    return result;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let extracted: unknown = null;
  let streamError: string | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      const lines = block.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        if (event === "done") extracted = payload.extracted;
        if (event === "error") streamError = payload?.message ?? "Unknown error";
      } catch { /* ignore */ }
    }
  }
  if (streamError) {
    result.fails.push(`Edge function reported error: ${streamError}`);
    return result;
  }
  if (!extracted) {
    result.fails.push("Stream closed without a 'done' event.");
    return result;
  }

  // ---- Assertions ----
  const e = extracted as Record<string, { value?: unknown; confidence?: number }>;

  // Curriculum-level
  const name = (e.name?.value ?? "") as string;
  if (typeof name === "string" && name.length > 0) {
    result.passes.push(`name present: "${name}"`);
    if (tc.expected.titleIncludes) {
      const lc = name.toLowerCase();
      const missing = tc.expected.titleIncludes.filter((t) => !lc.includes(t.toLowerCase()));
      if (missing.length === tc.expected.titleIncludes.length) {
        result.fails.push(`name "${name}" missing all expected tokens (${tc.expected.titleIncludes.join(", ")})`);
      } else {
        result.passes.push(`name contains at least one of: ${tc.expected.titleIncludes.join(", ")}`);
      }
    }
  } else {
    result.fails.push("name is missing");
  }

  const desc = (e.short_description?.value ?? "") as string;
  if (typeof desc === "string" && desc.length > 30) {
    result.passes.push(`short_description present (${desc.length} chars)`);
    const lc = desc.toLowerCase();
    const jargonHits = JARGON_BLACKLIST.filter((j) => lc.includes(j));
    if (jargonHits.length) {
      result.fails.push(`short_description contains jargon: ${jargonHits.join(", ")}`);
    } else {
      result.passes.push("short_description has no jargon blacklist hits");
    }
  } else {
    result.fails.push("short_description missing or too short");
  }

  const ar = e.age_range?.value as { min?: number; max?: number } | undefined;
  if (ar && typeof ar.min === "number" && typeof ar.max === "number") {
    const within = Math.abs(ar.min - tc.expected.ageRange.min) <= 1 && Math.abs(ar.max - tc.expected.ageRange.max) <= 1;
    if (within) {
      result.passes.push(`age_range ${ar.min}-${ar.max} ≈ expected ${tc.expected.ageRange.min}-${tc.expected.ageRange.max}`);
    } else {
      result.fails.push(`age_range ${ar.min}-${ar.max} differs from expected ${tc.expected.ageRange.min}-${tc.expected.ageRange.max}`);
    }
  } else {
    result.fails.push("age_range missing or malformed");
  }

  const fmt = e.format?.value as string | undefined;
  if (fmt === tc.expected.format) {
    result.passes.push(`format = "${fmt}"`);
  } else {
    result.fails.push(`format "${fmt}" ≠ expected "${tc.expected.format}"`);
  }

  const sts = (e.session_types_supported?.value ?? []) as string[];
  const missingSts = tc.expected.sessionTypes.filter((t) => !sts.includes(t));
  if (missingSts.length === 0) {
    result.passes.push(`session_types_supported includes all expected (${tc.expected.sessionTypes.join(", ")})`);
  } else {
    result.fails.push(`session_types_supported missing ${missingSts.join(", ")}; got ${sts.join(", ") || "(empty)"}`);
  }

  if (tc.expected.themesInclude) {
    const themes = ((e.themes?.value ?? []) as string[]).map((t) => t.toLowerCase());
    const themesStr = themes.join(" | ");
    const anyMatch = tc.expected.themesInclude.some((needle) => themesStr.includes(needle.toLowerCase()));
    if (anyMatch) {
      result.passes.push(`themes include at least one of: ${tc.expected.themesInclude.join(", ")}`);
    } else {
      result.fails.push(`themes missing all expected (${tc.expected.themesInclude.join(", ")}); got: ${themesStr || "(empty)"}`);
    }
  }

  // Sessions
  const sessions = (e.sessions?.value ?? []) as Array<Record<string, unknown>>;
  if (sessions.length === tc.expected.sessionCount) {
    result.passes.push(`session_count = ${sessions.length}`);
  } else {
    result.fails.push(`session_count ${sessions.length} ≠ expected ${tc.expected.sessionCount}`);
  }

  let sessionsWithoutPhotos = 0;
  let sessionsWithGenericRecap = 0;
  for (const s of sessions) {
    const recap = (s.recap_template ?? "") as string;
    if (typeof recap === "string") {
      if (!recap.includes("{photos}")) sessionsWithoutPhotos++;
      const lc = recap.toLowerCase();
      if (lc.includes("we had fun") || lc.includes("worked hard") || lc.includes("great teamwork")) {
        sessionsWithGenericRecap++;
      }
    }
    const peq = (s.parent_engagement_question ?? "") as string;
    if (typeof peq !== "string" || peq.length < 10) {
      result.fails.push(`session ${s.session_number}: parent_engagement_question missing or too short`);
    }
    const skills = s.skills_practiced;
    if (!Array.isArray(skills) || skills.length === 0) {
      result.fails.push(`session ${s.session_number}: skills_practiced missing or empty`);
    }
  }
  if (sessionsWithoutPhotos === 0) {
    result.passes.push(`all ${sessions.length} recap_templates contain {photos}`);
  } else {
    result.fails.push(`${sessionsWithoutPhotos} of ${sessions.length} recap_templates missing {photos}`);
  }
  if (sessionsWithGenericRecap === 0) {
    result.passes.push("no recap_template contains generic-tone hits");
  } else {
    result.fails.push(`${sessionsWithGenericRecap} recap_templates contain generic-tone hits ("we had fun", "worked hard", "great teamwork")`);
  }

  return result;
}

// --- Main ---

console.log(`Running ${TESTS.length} extraction regression tests against prompt ${PROMPT_VERSION}…\n`);
const results: Result[] = [];
for (const tc of TESTS) {
  console.log(`▶ ${tc.label} (${tc.docPath})…`);
  try {
    const r = await runOne(tc);
    results.push(r);
    console.log(`  ${r.passes.length} pass, ${r.fails.length} fail`);
  } catch (e) {
    results.push({ case: tc.label, passes: [], fails: [`Threw: ${e instanceof Error ? e.message : String(e)}`] });
    console.log(`  Threw an error.`);
  }
}

console.log("\n" + "═".repeat(70));
console.log("REGRESSION TEST REPORT");
console.log("═".repeat(70));
let totalFails = 0;
for (const r of results) {
  console.log(`\n  ${r.case}`);
  for (const p of r.passes) console.log(`    ✓ ${p}`);
  for (const f of r.fails) {
    console.log(`    ✗ ${f}`);
    totalFails++;
  }
}
console.log("\n" + "═".repeat(70));
if (totalFails === 0) {
  console.log("  ALL PASS — safe to deploy.");
  console.log("═".repeat(70));
  Deno.exit(0);
} else {
  console.log(`  ${totalFails} failures — investigate before deploying.`);
  console.log("═".repeat(70));
  Deno.exit(1);
}
