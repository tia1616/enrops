# Handoff — Marketing & Communications (Don) build

**Date:** 2026-05-19
**Session length:** ~all day
**Working dir:** `C:\Users\JVorster\Desktop\Projects\enrops`
**Supabase project:** `iuasfpztkmrtagivlhtj`
**J2S `organization_id`:** `1adf10ad-d091-4aa0-82e3-af331468ea2b`

If you're picking this up, read this first. It mirrors `MEMORY.md` but is dated and complete for this build.

---

## TL;DR

We built the AI Campaign Builder ("Don") — a 4-question flow that drafts a multi-touchpoint email campaign for parents, partners, or instructors. Today shipped:

- **Backend**: 2 migrations applied, 2 edge functions deployed/extended, mechanical-check validator written.
- **Front-end**: full Q1–Q4 flow at `/admin/marketing-v2` with real DB-backed dropdowns, editable touchpoint cards, send-test/approve stubs, celebration screen.
- **Docs**: Don system prompt, mechanical checks, notes template, merge tokens reference, mockup with wire-up map.

What's NOT done: real fetch wiring (still uses a `setTimeout` mock), token replacement in send pipeline, scheduled-touchpoint cron, J2S string cleanup in `marketing-send`, route swap, smoke test.

**To pick up: start at "Critical path for tomorrow" below.**

---

## What is live vs. local

### Live on Supabase (`iuasfpztkmrtagivlhtj`)

| Thing | Status | Where |
|---|---|---|
| Chunk 01 migration (brand_voice, draft_source, segments, name_aliases, J2S seed) | ✅ Applied | `supabase/migrations/20260519_marketing_ai_draft_and_tenant_config.sql` |
| Chunk 01b migration (touchpoints, throttle, promo, timezone, programs.active_promo_code_id) | ✅ Applied | `supabase/migrations/20260519_marketing_touchpoints_throttle_promo.sql` |
| GRANT SELECT on marketing_recipients to authenticated | ✅ Applied | `supabase/migrations/20260519_grant_marketing_recipients_select.sql` |
| `marketing-send` edge function | ✅ v17 deployed (chunk 02: ad_hoc_recipient_ids support) | `supabase/functions/marketing-send/index.ts` |
| `marketing-draft-campaign` edge function | ✅ v3 deployed (multi-touchpoint, Opus 4.6, anti-hallucination v1) | `supabase/functions/marketing-draft-campaign/index.ts` |

### Local only (NOT deployed)

- **`marketing-draft-campaign` v4** in `supabase/functions/marketing-draft-campaign/index.ts`. Adds:
  - The full Don persona from `docs/agents/don/system-prompt.md` (warm/positive/smart/casual, never claims "selling fast"/"award-winning"/specific outcomes, addresses parent not kid, one exclamation max).
  - Mechanical-check validator (`validateTouchpoint`, `validateSchedule`) with hard rejections (inline `$N`, unknown `{{tokens}}`, banned phrases from `brand_voice.do_not_use`) and soft warnings (bare dates, exclamation overflow, all-caps non-acronyms, emoji overflow, unverifiable claims like "most popular", "award-winning", "selling fast").
  - `notes_to_operator` field in output schema (Don flags ambiguity instead of guessing).
  - Auto-retry on hard failure (keeps retry only if fewer hard fails).
  - `mechanical_checks` array in response so the UI can surface warnings per touchpoint.

  **Deploy this in chunk 07 step 1.**

- **Front-end** (Vite hot-reloads local; production at enrops.com hasn't redeployed yet — Netlify or whatever should pick it up from `main`):
  - `src/pages/admin/marketing-v2/AICampaignBuilder.jsx` — top-level + useReducer state
  - `src/pages/admin/marketing-v2/QuestionStep.jsx` — shared chrome + sticky action bar
  - `src/pages/admin/marketing-v2/questions/Q1_What.jsx` — multi-topic chips
  - `src/pages/admin/marketing-v2/questions/Q2_Who.jsx` — audience radios + **real multi-select dropdowns** for schools/areas/segments/person (DB-backed)
  - `src/pages/admin/marketing-v2/questions/Q3_Duration.jsx` — radio cards
  - `src/pages/admin/marketing-v2/questions/Q4_Channels.jsx` — checkboxes + "Remind me later"
  - `src/pages/admin/marketing-v2/ScheduleReview.jsx` — schedule view with plan summary, recipient list, touchpoint cards, sticky action bar
  - `src/pages/admin/marketing-v2/TouchpointCard.jsx` — editable per-touchpoint card
  - `src/pages/admin/marketing-v2/EditableField.jsx` — click-to-edit primitive
  - `AICampaignBuilder.jsx` also contains `CelebrationScreen` (post-approve)
  - Route `/admin/marketing-v2` added in `src/App.jsx`; nav entry in `src/layouts/AdminLayout.jsx`

### Mock vs real today

- The UI **uses a `setTimeout` mock** in `AICampaignBuilder.jsx:startDrafting`. It builds a multi-touchpoint schedule with realistic subjects per label (kickoff / mid-window / 48h-promo / 24h-promo / 48h-reg-close / 24h-reg-close).
- The real `marketing-draft-campaign` edge function works (you can curl it), but the UI doesn't call it yet. That's chunk 07 step 1.

---

## Critical path for tomorrow (chunk 07)

In order. Each is a separate commit-able unit.

### 1. Wire real draft fetch (replaces the chunk-05 setTimeout)
- In `AICampaignBuilder.jsx`, replace the `setTimeout` mock in `startDrafting()` with a real call to `marketing-draft-campaign`. Pattern (from chunk-07 spec):
  ```js
  const { data, error } = await supabase.functions.invoke('marketing-draft-campaign', {
    body: { organization_id: org.id, inputs: state.inputs }
  });
  ```
- Map the response into the shape the reducer expects (already designed for it — `schedule.summary`, `schedule.touchpoints`, `recipients`, `sender`).
- Handle error states: zero-recipient warning, org-not-configured, draft_timeout.
- **Also deploy v4** of the edge function (the local file has the new persona + mechanical checks + notes_to_operator).

### 2. Token replacement pass in `marketing-send`
- Without this, recipients literally receive emails saying `Hi {{first_name}},`.
- Per `docs/specs/marketing-merge-tokens.md`: load each recipient's row, build a tokens map (`first_name`, `school`, `savings`, `early_bird_deadline`, etc.), then `text.replace(/{{(\w+)}}/g, (_, k) => tokens[k] ?? FALLBACKS[k] ?? '')`.
- Pricing data comes from `programs.early_bird_price_cents` joined via `program_locations.name`/`name_aliases` to the recipient's `school_name`. The newly-refactored `src/lib/pricing.js` has the helpers (`basePriceForItem`, `formatEarlyBirdDate`).
- Touchpoints' subject + body_html + body_text all need token replacement.

### 3. Wire "Send test to me"
- In `ScheduleReview.jsx` → `onSendTest`, call `marketing-send` with `mode: 'test'`, `campaign_id`, `ad_hoc_recipient_ids: [adminAsRecipient.id]`.
- Bootstrap pattern (per chunk-06 spec): look up `marketing_recipients` for `email = currentUser.email` + `organization_id = currentOrg.id`. If not found, INSERT one with `source: 'manual'`, `segments: ['_internal_admin']`. Use that id.
- Toast on success: `"Test sent to ${currentUser.email}"`.

### 4. Wire "Approve & schedule"
- PATCH `marketing_campaigns` row: set `approved_at`, `approved_by`, `status: 'sending'`.
- For each touchpoint: it's already in `marketing_campaign_touchpoints` with status='queued'. The cron picks them up (next item).
- For an immediate send (touchpoint with `scheduled_at` in the past or `null`), call `marketing-send` directly with `ad_hoc_recipient_ids`.

### 5. `marketing-touchpoint-cron` edge function (NEW)
- Polls `marketing_campaign_touchpoints WHERE scheduled_at <= now() AND status='queued'`.
- For each: call `marketing-send` with `mode: 'send'`, `campaign_id`, `ad_hoc_recipient_ids` (load from the campaign's draft).
- Set touchpoint `status = 'sent'` on success, `'failed'` on error.
- Fire via pg_cron every 5 minutes. Pattern matches `marketing-automations-cron` (which uses pg_cron + net.http_post).

### 6. Multi-tenant cleanup of `marketing-send`
- Strip hardcoded J2S strings: `FROM_EMAIL`, `REPLY_TO`, `REGISTER_URL`, footer "Jessica Vorster · Journey to STEAM" + phone, closer line.
- Load them per-org from `organizations.default_sender_name/email`, `organizations.slug` → `enrops.com/${slug}`, `organizations.brand_voice.closer`.
- This is the chunk-07 grep check requirement.

### 7. Route swap + smoke test
- Move `AICampaignBuilder` from `/admin/marketing-v2` → `/admin/marketing`. Old `MarketingShell` → `/admin/marketing-legacy`. Both kept for a couple weeks.
- Grep check from chunk-07 spec:
  ```bash
  grep -ri "1adf10ad-d091" src/ supabase/functions/
  grep -ri "Journey to STEAM" src/admin/marketing/ supabase/functions/marketing-draft-campaign/
  grep -ri "journeytosteam.com" src/admin/marketing/ supabase/functions/marketing-draft-campaign/
  grep -ri "Future-ready skills" src/ supabase/functions/
  ```
  Expected: zero hits in src/ and supabase/functions/. Acceptable hits are in `mockups/`, `supabase/migrations/` (J2S seed), `docs/`.
- Smoke test with 2-3 test recipients tagged `'smoke_test_chunk_3_6'`. Send via Don end-to-end.

### 8. Mechanical-check warning UI (polish)
- The `mechanical_checks` array in chunk-03 v4's response has per-touchpoint hard/warning data. Surface on `TouchpointCard` as a yellow pill or expandable note.

---

## Open issues / flagged for later

| Issue | Notes |
|---|---|
| Mobile sign-in returns to enrops.com homepage | `AdminLayout.jsx:123` redirects unauthorized users to `/`. Auth session not persisting on mobile across different origins (192.168.0.5:5173 vs localhost). Defer until chunk 07 done. |
| Partners + Instructors audiences | Backend returns 501. UI shows "Coming soon." Implement when the Partner Hat / Instructor Hat chunks land. |
| Flyer + social channel generation | Q4 checkboxes are disabled ("Coming soon"). Schema (`marketing_campaign_touchpoints.type IN ('email','flyer','social')`) is ready. Future chunk. |
| Promo codes | Table exists at `promo_codes` (existing) — extended with `scope_program_ids`, `starts_at`, `stripe_coupon_id`, `created_by`. UI for "suggest a promo code" not built. |
| `parent_notifications` | Not built — Jessica has a spec for the parent portal push, will hook up later. |
| `programs.price_cents` editor in admin | Currently set via direct DB. A parallel chat refactored `src/lib/pricing.js` to read per-row early-bird from `programs.early_bird_price_cents` + `early_bird_deadline` — the schema and front-end are ready; an admin form to edit prices needs to land. |
| Don's notes per-org | Template lives at `docs/agents/don/notes-template.md`. Storage column on `organizations` (probably as `dons_notes text` or extend `brand_voice` JSON) — defer; load into Don's prompt when it exists. |

---

## Standing rules baked into Don (in deployed v3 + local v4)

These are in `marketing-draft-campaign`'s system prompt. They apply for every tenant.

- Throttle: 1 email per parent per 10 days (configurable via `organizations.email_throttle_days`). Don plans 6-10 day spacing.
- Send times: Tue/Thu 10am PT; deadline 7am PT; welcome Mon 9am PT; NEVER Fri afternoons/weekends. Renders in `organizations.timezone` (default `America/Los_Angeles`).
- 48h + 24h reminders before any deadline.
- No cancel language with parents.
- One exclamation max. Subject ≤ 60 chars. No all-caps. No clickbait. No emoji rows.
- Pop-culture themes (Pokémon, Minecraft, LEGO, Mario) welcome when they fit.
- Address the parent, not the kid.

v4 adds the persona block and the anti-hallucination rules from `docs/agents/don/system-prompt.md`.

---

## Merge tokens

Source of truth: `docs/specs/marketing-merge-tokens.md`. Approved set (also embedded in Don's prompt):

- Per-recipient: `first_name`, `parent_name`, `child_first_name`, `child_last_name`, `school`, `city`, `zip`, `geo_segment`, `unsubscribe_url`
- Per-org: `org_name`, `sender_name`, `sender_email`, `register_url`, `reply_to`, `logo_url`, `closer`, `phone`, `website`
- Per-program (computed from this recipient's school): `savings`, `early_bird_price`, `regular_price`, `early_bird_deadline`, `first_session_date`, `session_count`, `day_of_week`, `curriculum`, `vip_price`
- Per-campaign: `topic`, `topics_list`, `promo_code`, `promo_amount`

Chunk 07 step 2 wires the replacement pass in `marketing-send`.

---

## Mechanical checks (already in local v4, not yet deployed)

Source of truth: `docs/agents/don/mechanical-checks.md`. Implemented in `supabase/functions/marketing-draft-campaign/index.ts` as `validateTouchpoint`/`validateSchedule`.

**Hard rejections** (regenerate):
- Inline `$N` dollar amount
- Unknown `{{token}}` not in `APPROVED_TOKENS`
- Banned phrase from `organizations.brand_voice.do_not_use`

**Soft warnings** (allow but flag):
- Bare date pattern (`January 5`, `1/5`, etc.) outside a token
- >1 exclamation in subject, >2 in body
- All-caps words >3 letters not in `KNOWN_ACRONYMS`
- >3 emojis total
- Unverifiable claim phrases: "most popular", "award-winning", "best in", "top-rated", "voted #1", "selling fast", "going fast", "almost full", "filling up", "back by popular demand"

Retry strategy: if any hard fails, call Claude once more; keep retry only if it has fewer hard fails. Report all in `mechanical_checks` response field.

**Chunk 07 step 8** surfaces these in the UI.

---

## Reference docs

| Path | Purpose |
|---|---|
| `docs/agents/don/system-prompt.md` | Don's persona — verbatim what goes into the edge function prompt |
| `docs/agents/don/mechanical-checks.md` | Regex-layer validation rules |
| `docs/agents/don/notes-template.md` | Per-provider tuning file (when we wire it up) |
| `docs/specs/marketing-merge-tokens.md` | Authoritative list of `{{token}}` names, sources, fallbacks, status |
| `mockups/marketing-ai-builder.html` | Approved chunk-04 mockup (`Chunk 3.6.04`) |
| `mockups/WIRE_UP_MAP.md` | Maps every interactive element to its backend connection |
| Downloads — Jessica's plan PDFs / .docx | Build briefs, J2S marketing schedule v2.1, chunks 00–07, etc. (in `C:\Users\JVorster\Downloads\`) |

---

## Existing memory entries to consult

(Pulled from `MEMORY.md` — auto-loaded into new sessions, but worth knowing about explicitly.)

- `project_enrops.md` — repo paths, J2S org_id, branding architecture
- `project_enrops_platform_vision.md` — Director + Hats model, 3-question pattern, free vs Boss Mode
- `project_enrops_marketing_hat_scope.md` — full vision: multi-channel campaign plan, "Marketing & Communications" tab
- `project_enrops_marketing_standing_rules.md` — throttle, send times, copy rules
- `feedback_workflow.md` — Jessica's collaboration preferences
- `feedback_verify_db_not_specs.md` — query Supabase directly before proposing data fixes (we did this today for pricing + merge tokens)
- `feedback_copy_redundancy.md` — audit adjacent UI copy for repeated closers
- `feedback_one_place_to_edit.md` — one field = one editable surface
- `reference_enrops_specs.md` — Drive fileIds for build briefs and chunked specs

---

## Recent commits (most recent first)

```
a1f4571 — Grant SELECT on marketing_recipients to authenticated (fixes 403 on Q2)
4ed6253 — (previous, see git log)
f1dec52 — Chunk 3.6.06b: Q2 real multi-select for schools/areas/segments + person typeahead
5350962 — Chunk 3.6.06b: Don persona v4 + mechanical checks + notes_to_operator
441f878 — Chunk 3.6.06 polish: celebration screen after approve, realistic mock subjects, anti-hallucination prompt rules
300bcef — Chunk 3.6.06: real schedule review (TouchpointCard, EditableField, ScheduleReview)
9d2ca0b — Chunk 3.6.05b: back button on review screen + Edit answers
120ef25 — Chunk 3.6.05b: Don plans multi-touchpoint schedules (deployed v2)
c6cf218 — Chunk 3.6.05: AI Campaign Builder Q-flow at /admin/marketing-v2
99daf32 — Marketing merge tokens reference (derived from live Supabase schema)
```

---

## How to test the current state

1. Start Vite: `cd C:\Users\JVorster\Desktop\Projects\enrops; node node_modules/vite/bin/vite.js --host`
2. Open http://localhost:5173/admin/marketing-v2 (sign in if needed).
3. Q1 → type a topic, press Enter (or click a preset). Add multiple topics.
4. Q2 → pick "Parents." Try each scope:
   - **Master list** — no detail UI
   - **A specific school…** — searchable checkbox list of `program_locations` for J2S
   - **An area…** — radio list of distinct `geo_segment` (8 areas, sorted by parent count)
   - **A saved segment…** — currently empty (no `segments` tagged on recipients yet, but no error)
   - **Just one person…** — typeahead, type "ma" or any name
5. Q3 → pick a duration.
6. Q4 → confirm Email is checked. Try "Remind me later" (returns to /admin/marketing). Try "Draft it ✨".
7. After ~2s the schedule review renders. Click any touchpoint to expand. Edit subject/send-time/body. Click Send test → stub alert. Click Approve & schedule → confirm → celebration screen.

All edits are local-only (chunk 07 wires real persistence).

---

## What Jessica wants out of this build

(From conversation, repeated for emphasis — these are the values Don exists to deliver.)

- **Operators are non-developers.** They want enrichment that's fun first, educational second. Don writes like a thoughtful friend, not a marketer.
- **Time-saved is the headline.** Every campaign should claim multiple hours saved vs manual.
- **One approval moment.** The whole campaign goes in one click; admin doesn't have to schedule emails one at a time.
- **"Remind me later" is the escape hatch.** When admin doesn't have the energy, the system parks the work and resurfaces it.
- **Multi-tenant from day one.** Nothing hardcoded for J2S anywhere except `supabase/migrations/` (the seed) and the mockup. Chunk 07's grep check enforces this.
- **No fear/FOMO/scarcity.** Don leans into possibility and joy. "Selling fast!" is banned by mechanical checks.

If anything in the build drifts from these values, fix the build.
