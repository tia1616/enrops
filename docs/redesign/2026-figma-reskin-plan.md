# Enrops Figma reskin — build plan & checklist

**Status:** planning (no code yet) · **Started:** 2026-06-08 · **Branch:** `staging`
**Owner:** Jessica (product) + Claude (build) · **Source of truth for the reskin effort.**

This is a tight checklist, not a spec. Decisions were made in conversation 2026-06-08; this records them so the work survives across sessions.

---

## Source assets
- Figma file: `enrops platform | Public` (file key `sVkglkH2rQAMFeqJVwDkSC`). Jessica's seat is **View / free Starter** → Figma Dev-Mode MCP extraction is **blocked**. We build from **exported PNGs**, not the MCP.
- Exported PNGs: `C:\Users\JVorster\Downloads\enrops platform _ Public\` (80 files).
  - `NN-NN-NN(-N).png` = real screens + state variants (~20 base screens, ~47 state images).
  - `1.png`–`27.png`, `admin/instructor/parent.png` = section dividers (a table of contents), not screens.
- Designs contain typos and some logic mistakes — treat as **visual target only**. Our built functions + data model win on logic.

## Screen inventory (8 sections, ~11 distinct surfaces)
| Section | Surface | Persona | Complexity |
|---|---|---|---|
| 01 | Marketing campaign builder (drawer: topics → channels → review) | Admin | Medium |
| 02 | Curricula library (card grid) | Admin | Medium |
| 03 | Curriculum detail / edit (AI-extracted, source docs, flagged fields) | Admin | Complex |
| 04 | Scheduled programs (by-school + calendar) | Admin | Medium |
| 04 | Instructor/contractor onboarding wizard (steps 4–7) | Instructor | Complex |
| 04 | Documents (instructor app view) | Instructor | Minor |
| 05 | Locations list + Edit venue drawer | Admin | Medium |
| 06 | Instructor schedule / offer board (Kanban + Calendar, empty + filled) | Admin | Complex |
| 07 | Add-curriculum drawer (upload + AI extract) | Admin | Minor |
| 08 | Time-saved breakdown page | Admin | Minor |

Parent-facing = **registration only** (no parent portal). No parent screens in the export beyond a divider.

---

## "Ours wins over Figma" rules (apply automatically, every screen)
1. **Agent name = `Enni`** (one agent). Figma still shows Don / Dora / "enni · Your director" → swap all to **Enni**.
2. **No J2S hardcoding.** Admin/platform shell is **Enrops-branded**. Tenant branding (J2S, etc.) appears ONLY on the 3 outward surfaces: **registration pages, instructor portal, parent (reg) pages**. Onboarding-wizard legal entity / address / ORS statute / "Gusto" / consent entity → **tenant config**, never hardcoded.
3. **Nav / IA = ours** (see below), not Figma's flat nav.
4. **Wordmark = existing `EnropsWordmark` component**, not the Figma render (their signature 'e' is wrong).

## Metric / copy corrections (don't replicate the design's mistakes)
- Marketing drawer field mislabeled "Venue name" → it collects campaign **topics**.
- Curriculum detail: **Sessions** + **Class size** dropdowns wrongly show "Summer camp" (leftover from Format).
- Scheduled programs "Enrolled 8 / 434 seats paid" → nonsensical; use a metric that parses (confirm intended meaning at build).
- Offer board "Assigned 0 / Accepted 8" → contradictory; use **our** offer/acceptance model.
- Curricula card "6 of 8 unlocked" → it's the **capability-unlock** communication (what you can do after uploading a curriculum). Reuse/clean up existing implementation, don't invent.
- Time-saved "+1 hour per row" → use **our real baselines**, not placeholder.
- Typos to fix: "platfrom", "ourney to STEAM", "registartion".

---

## Target navigation — flat sidebar, single-page-with-tabs (uniform)
Replace the current mixed model (some expandable groups, some single items) with **8 flat sidebar items**; multi-facet pages use an in-page tab strip. Removes the accordion group logic in `AdminLayout`.

| Sidebar (flat) | In-page tabs | Notes |
|---|---|---|
| Overview | — | |
| Programs | Curricula · Scheduled programs · Class rosters | keep existing routes |
| Partners | Schools & partners · Locations · Calendars | relabel nav to "Partners" but **KEEP `/admin/schools` URL** (4 internal `?tab=` deep links + edge-fn refs depend on it); already merges Partners+Locations — add Calendars tab |
| Instructors | Roster · Schedule | Roster = existing `InstructorsTab` (full contact roster, already top-level) |
| Money | Receivables · Payouts | `/admin/finances` URL stays (Stripe return_url depends on it) |
| Family Comms | Marketing · Automations | |
| Community | — | "soon" |
| Settings | (tabs later — post-Italy architecture) | |

**Retire** the standalone `/admin/contacts` page: its Partners tab is already duplicated in `/admin/schools`; its Parents tab is a "soon" placeholder (parents = registration, nothing to build). Add redirect `/admin/contacts` → `/admin/schools?tab=partners` for stale links.

### Blast radius for Unit 1 (verified 2026-06-08)
- `/admin/schools` referenced by 4 files (AdminOverview, ImportContactsModal, ProgramPrereqEmptyState, ProgramWizardNew) via `?tab=` deep links → **keeping the URL** means zero churn here.
- `/admin/contacts` referenced only by App.jsx route + a comment → retire + redirect.
- **Backend touch:** `supabase/functions/_shared/gateCheck.ts:159` emails `https://enrops.com/admin/contacts` ("View their record") for a ready instructor → repoint to `/admin/instructors`; redeploy edge fn to **both** staging + prod.
- `/admin/finances` URL must NOT change (Stripe `return_url` hardcoded in stripe-connect-onboard).

**Differentiation:** Programs = *what you run*; Partners = *who you run it with & where*.

### Current-state facts (verified in code 2026-06-08)
- `AdminLayout.jsx` → `NAV` constant drives the sidebar (expandable groups today).
- `App.jsx` routes: curricula, programs, rosters, schools, locations, calendars, contacts, instructors, finances, payouts, schedule, family-comms/*, settings, etc.
- `/admin/schools` (`SchoolsLocations.jsx`) already = tabbed Partners + Locations.
- `/admin/instructors` (`InstructorsPage.jsx`) already renders the full `InstructorsTab` (roster + contacts).
- `EnropsWordmark.jsx` exists = the logo asset to reuse.

---

## Build sequence (per-feature units)
1. **Nav/IA shell** — flatten sidebar to 8 items, add per-section tab strips, add Calendars tab to Partners, rename `/admin/schools` → "Partners", retire `/admin/contacts` (+redirect). Mostly rewiring already-built pages.
2. **Curricula cluster** (keystone — unlocks the most): Add-curriculum drawer → Curricula library → Curriculum detail/extraction.
3. Remaining admin screens in waves (Scheduled programs, Locations/Partners, Offer board, Marketing builder, Time-saved page).
4. Instructor-side (onboarding wizard, documents).

**Launch-critical cut for July 3 alpha:** curricula cluster + scheduled programs + partners + home/time-saved. Marketing builder + instructor onboarding follow. (Confirm against the white-glove founder flow.)

## Per-unit rules gauntlet (run BEFORE saying "ready")
- [ ] **Multi-tenant:** run `tenant-rls-audit` skill — no hardcoded J2S slug/UUID/branding; admin = Enrops-branded; tenant brand only on reg/instructor/parent.
- [ ] **RLS:** every query org-scoped; no service-role bypass on read paths.
- [ ] **8 pressure-tests:** underspecified / inconsistent / security / errors / clickability / what-this-touches / artifact-column / parallel-schema.
- [ ] **"Ours wins" 4:** Enni, no J2S strings, our IA, existing wordmark.
- [ ] **Standing UX:** AI wait UI (recommended duration + live m:ss elapsed) on any extraction/generation; time-saved pills on real baselines; one-place-to-edit; no tech jargon; `derive_program_session_dates()` for any session dates.
- [ ] **Build hygiene:** `npm run build` locally before push; commit per feature; push `staging` → Jessica reviews → `main` on her go; deploy-verify on enrops.com.
- [ ] **Parity:** mirror any DB/migration/edge-fn/config change to BOTH staging and prod (structural only, never data/secrets).

## Resolved (2026-06-08)
- **Overview/home screen:** IN scope. No Figma frame → style with the reskin's new design language (cards/colors/spacing derived from the system); keep current bits that already match their ideas. Home stays **phase-aware**.
- **Scheduled-programs metric (keep ours):** `31 programs` · `28 enrolled / 428 seats (28 paid)` · `+15 pending`. Current impl is correct — do NOT use the Figma "8/434".
- **No fixed launch cut — phase-dependent.** Operators live in different screens by term-cycle phase (now = instructor schedule; ~1 month pre-term = enrollment numbers). So prioritize **instructor schedule + scheduled programs** alongside the curricula keystone, and keep the home screen phase-aware.

## Open questions (resolve at build time)
- Does `PartnersTab` already surface partner contacts, or add a contacts view?

## Design tokens (sampled from Figma PNGs via System.Drawing, 2026-06-08)
- **`#1C004F`** deep plum — wordmark, headings, body text accents (keep)
- **`#6857E1`** bright indigo — primary buttons, active nav, active tabs (NEW; replaces plum on actions)
- **`#F2F0FF`** lavender — sidebar background (NEW; was white)
- App-wide button-color sweep to `#6857E1` is pending — done so far in AdminLayout chrome + CurriculaList; other screens still use plum until swept (ideally via a shared token module).

## Decisions log
- 2026-06-08: Build from PNGs (Figma seat blocks MCP). Enni spelling confirmed. Branding split confirmed (Enrops shell / tenant outward surfaces). Flat single-page-with-tabs nav adopted. Partners (rename of Schools) gains Calendars tab + absorbs partner contacts; Contacts page retired. Start: nav shell → curricula cluster.
