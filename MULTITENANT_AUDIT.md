# Enrops Multi-Tenant Audit

Running list of hardcoded J2S references that need extraction to config/DB before tenant 2 onboards (target: July 31, 2026).

## Frontend
- [ ] Home.jsx has J2S-hardcoded copy, hero, tagline
- [ ] Home page term filter is FA26-only
- [ ] tenants.js district map is J2S-only

## Pricing & terms
- [ ] Term codes (FA26, SP26, WI27) are J2S-specific naming conventions
- [ ] VIP $240/term pricing hardcoded
- [ ] Distance bonus amount `5000` cents hardcoded in DB trigger — should be `organizations.default_distance_bonus_cents`
- [ ] Cycle naming logic (`SU26` → "Summer 2026") works for J2S's quarter system, may break for tenants on different cadences

## Email & comms
- [ ] Email templates name J2S explicitly in body copy
- [ ] Resend send domain `updates.journeytosteam.com` — needs `org_branding.send_domain` per-tenant

## Cron & scheduling
- [ ] Reminder cron deadline (3 days) hardcoded — fine for v1, revisit before tenant 2

## Curricula Onboarding — Chunk 2 (2026-05-14 → 2026-05-16)
- No new hardcoded J2S references introduced. New pages (CurriculumNew, CurriculumExtracting, CurriculumReviewPlaceholder) read `org` from `AdminLayout` outlet context and write `organization_id` per row. Storage paths start with `${org.id}/`.
- `scripts/backfill-curricula.ts` is org-agnostic — clusters distinct (organization_id, curriculum) pairs across all orgs. Safe for multi-tenant.
- `scripts/test-extraction-regression.ts` uses dev-mode (no DB writes) and is platform-admin gated; tenant-agnostic.
- `extract-curriculum-details` edge function v3 auth: platform_admin OR org owner/admin of the doc's organization. Service-role used only for downstream writes inside the function — never bypasses org scoping on lookup.
- Drift risk to revisit: the edge function source lives only on Supabase (deployed via MCP, no local mirror under `supabase/functions/extract-curriculum-details/`). Mirroring locally as source of truth would let the regression test import the exact deployed prompt instead of round-tripping through SSE. Not multi-tenant per se but worth flagging.

## Curricula Onboarding — Chunk 3 (2026-05-16)
- No new hardcoded J2S references. `CurriculumReview.jsx` reads `org` from outlet context; every query filters by `organization_id` (curricula, curriculum_sessions, curriculum_extracted_fields, curriculum_documents, programs match query). Dora persona copy is generic — no J2S branding.
- Title-match logic compares the new curriculum name against `programs.curriculum` rows where `organization_id = current org AND curriculum_id IS NULL` — tenant-isolated. The match algorithm is generic (lowercase + tokenize + stop-word filter + word-overlap ≥ 0.5).
- Class size norms in Section A's helper copy ("4–20 for camps, 5–14 for afterschool") are J2S-flavored hints — generic enough to read fine for other providers, but consider replacing with org-derived defaults once tenant 2 onboards (compute distinct min/max class sizes from that tenant's existing `programs`).
- Title-match extension (2026-05-16): added `camp_sessions.curriculum_id` and now query both `programs` (afterschool, FA/WI/SP) AND `camp_sessions` (camps) for match candidates. Both queries filter by `organization_id` — tenant-isolated. Worth noting: the programs-vs-camps split is currently J2S-shaped; other tenants may not use a separate camp_sessions table, but the dual-source query is harmless either way (camp_sessions returns nothing for tenants that don't populate it).

## Curricula Onboarding — Chunk 3 follow-up (2026-05-18)
- Drift fix complete: `supabase/functions/extract-curriculum-details/` is now the source of truth for the deployed edge function. Repo had the Chunk 1 dev-only SSE version; deployed v3 had the Chunk 2 prod+dev hybrid. Reconciled into v4 with prompt v2 + org-context preload.
- New prompt `v2` lives in `prompts.ts` alongside `v1` (per the "add as siblings" convention). v2 hardens rule #9 (impressive + specific skills, BAD/GOOD examples), caps per-session `skills_practiced` at 3-4, adds 5 new top-level fields (`class_size`, `prerequisites`, `mid_term_skills`, `final_recap_skills`, `final_showcase`), and accepts an `<organization-context>` block. `DEFAULT_PROMPT_VERSION = "v2"` so all new extractions use it.
- `buildOrgContext(admin, organizationId)` in `index.ts` pulls DISTINCT age ranges from `programs.{age_min,age_max}` + `camp_sessions.{ages_min,ages_max}` + `curricula.{age_range_min,age_range_max}`; DISTINCT class sizes from `curricula.{class_size_min,class_size_max}`; DISTINCT formats from `programs.program_type` + `camp_sessions.session_type` + `curricula.format`. All scoped to `organization_id` — tenant-isolated by design. Empty for any org with no historical data (no leakage, no fabrication).
- Org-context is multi-tenant-safe: each tenant only ever sees its own patterns; the prompt instructs the model to use them as a soft sanity-check (rule 14), never to fabricate to match.
- Persistence of the 5 new fields writes to existing curricula columns (`class_size_min/max`, `prerequisites`, `mid_term_skills`, `final_recap_skills`, `final_showcase`) — all already RLS-protected via the `curricula` table policies. Field-level audit rows go into `curriculum_extracted_fields` with `organization_id` set.
- Regression test (`scripts/test-extraction-regression.ts`) now defaults to `PROMPT_VERSION=v2`; runs against the live deployed function in dev mode (platform_admin only, no DB persistence).
