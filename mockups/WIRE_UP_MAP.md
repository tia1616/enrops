# Marketing & Communications — Wire-up Map

Companion to `marketing-ai-builder.html`. Every interactive element in the mockup is listed below with the database table, edge function, or third-party service it connects to in the React build. The mockup's toast messages on each button mirror this map, so clicking around the mockup is the fastest way to read it.

## Conventions
- **Edge function** = Supabase function, called from the React app with the user's JWT.
- **RLS** = row-level security policy enforces tenant isolation; service-role only used inside edge functions after explicit auth gate.
- **Resend** = existing transactional email provider, called only from `marketing-send`.
- All queries filtered by `organization_id` unless noted.

---

## Tab navigation

| Element | Wires to |
|---|---|
| Top tabs (Campaigns / Contacts / Automations) | Pure client routing. State lives in the React Router URL (`/admin/comms`, `/admin/comms/contacts`, `/admin/comms/automations`). |

## Campaigns home — Recent list

| Element | Wires to |
|---|---|
| Recent campaign row click | Query `marketing_campaigns` where `organization_id = current` order by `updated_at desc` limit 20. Click opens schedule review pre-loaded by `campaign_id`. |
| Status pill (Sent / Awaiting approval / Draft) | Derived from `marketing_campaigns.status` + `approved_at`. |
| "View all" | Full paginated list view, same query. |
| "Start a campaign" / "Send a quick message" | Navigates to Q1. No DB write yet. |

## Q1 — What

| Element | Wires to |
|---|---|
| Multi-topic input (chips + Enter to add) | Local form state. Flows into `inputs.what` as a **`string[]`** in the chunk 3.6.03 `DraftRequest` (the spec'd `what: string` shape needs to be widened to `string[]` — one campaign can promote multiple things at once, e.g., Fall + Summer). The edge function passes all topics to Claude and asks it to weave them into a single coherent schedule with topic-tagged touchpoints. |
| Chip presets | Add to the chip list (no longer overwrite). Stored as a static list; future: per-org "recent topics". |
| Topic color | Each topic gets a rotating color from a fixed palette (brand / accent / emerald / pink / sky). Re-used in the schedule view to tag each touchpoint with the topic(s) it covers. |
| Marketing-data hint | Hardcoded copy for v1. Future: pull from a curated `marketing_insights` table keyed by campaign type. |

## Q2 — Who

| Element | Wires to |
|---|---|
| Audience radios (Parents / Partners / Instructors) | Sets `inputs.who.audience` per chunk 3.6.03 spec. **UI shows all three as first-class choices** with their own sub-filter panes. Backend: parents fully wired in `marketing-draft-campaign` v1; partners + instructors return 501 until their respective Hat chunks (Partner Hat + Instructor Hat) land. |
| Partners sub-filter — type + role + specific-orgs | Type select maps to a `partner_orgs.type` column (school / parks_rec / church / library / community). Role select maps to `partner_org_contacts.role`. Both tables are TBD — they ship with the Partner Hat. |
| Instructors sub-filter — tier + status + specific | Existing `instructors` table already has tier and status columns. Joins to `auth.users` for email. |
| Status select (All / Current / Past / Prospect) | Becomes part of the `parents` filter. Resolves via joins: current = active programs roster, past = `marketing_recipients` with `source_term` older than current and no recent registration, prospect = recipient with no `registrations` row. |
| Scope select (Master / School / Area / Segment / Person) | Maps 1:1 to `ParentsFilter` union from chunk 03 (`master_list`, `school` w/ `school_ids[]`, `area`, `segment`, `person`). |
| Scope detail input (typeahead) | School: queries `program_locations` by name + `name_aliases` (added in chunk 3.6.01). Area: queries `marketing_recipients.geo_segment`. Segment: queries `marketing_recipients.segments` (chunk 01 column). Person: `marketing_recipients` by name/email. |
| Live "~247 recipients" count | Server-side count of the resolved filter. Debounced ~300ms. |
| "Preview list" | Slide-over with the recipient list, paginated. |

## Q3 — Duration

| Element | Wires to |
|---|---|
| Duration radios (2 weeks / 1 month / 2 months / Custom) | Sets `inputs.duration` string. The edge function uses it to pick cadence + deadline placement. |
| Marketing-data hint | Hardcoded for v1. Future: campaign-type-specific lift figures. |

## Q4 — Channels

| Element | Wires to |
|---|---|
| Email checkbox (also pushes to portal) | Sets `inputs.channels` to include `email`. Render path: existing `marketing-send` → Resend. Portal push: write to a new `parent_portal_notifications` row keyed by `recipient_id` (Parent Portal already exists). |
| Flyer / Social checkboxes | Disabled in v1 (501 stub). When wired: new tables `campaign_assets` (flyer PDFs in Storage) + `campaign_social_posts`. |
| "Draft it ✨" | Calls `marketing-draft-campaign` edge function (chunk 3.6.03). Returns draft + `campaign_id`. |

## Drafting transition screen

| Element | Wires to |
|---|---|
| Animated checklist | Cosmetic; reflects the steps the edge function actually executes (auth → org config load → recipient resolve → Claude draft → insert row). Could be wired to SSE for real progress. |

## Schedule review — Top of page

| Element | Wires to |
|---|---|
| Back to campaigns | Client routing only. No persistence. |
| Time-saved pill | Number computed from a per-tenant baseline (see `project_enrops_time_saved.md`). For J2S, baseline is "manual campaign = ~16h". |
| Plan summary (Topic / Audience / Window / Channels) | Read from the draft's `marketing_campaigns` row + `draft_inputs` JSON. |

## Schedule review — Promo card

| Element | Wires to |
|---|---|
| Suggested promo (code, discount, expiry, step-up) | Comes from `marketing-draft-campaign` when input mentions early-bird / discount-eligible context. New table needed: `promo_codes` (id, organization_id, code, discount_cents, scope_program_ids[], starts_at, expires_at, step_up_price_cents, created_by, applied_at). |
| "Approve & apply to open programs" | **Writes**: insert `promo_codes` row. **Updates**: `programs.early_bird_price_cents` + `programs.early_bird_deadline` for every open FA26 row in scope. **Schedules**: a Supabase cron / `marketing-automations-cron` entry to restore prices at expiry. |
| "Edit code or amount" | Inline editor for the code string, $ amount, expiry datetime, program-scope multi-select. |
| "Skip the promo" | Marks the suggestion declined; calls Claude to regenerate body copy without code references. |
| Pricing-data note | The code applies via the existing checkout flow (`create-checkout` edge function). No new pricing-table code path. |

## Schedule review — List-fatigue check

| Element | Wires to |
|---|---|
| "See the breakdown" | Future: inline panel with engagement-data + per-touchpoint expected lift, sourced from `marketing_insights` table. v1: copy only. |
| "Trim to 6 touchpoints" | Re-calls `marketing-draft-campaign` with a `consolidate=true` flag. Replaces the timeline. |

## Schedule review — Cancellation banner

| Element | Wires to |
|---|---|
| "Default policy: 7 days before start" | Read from `organizations.auto_close_days_before_start` (new column, defaults 7). |
| "Edit policy" | Jumps to Settings → Programs. |

## Schedule review — Touchpoint cards

Each `<details>` card has a summary (always visible) and an expanded editor + preview pane.

| Element | Wires to |
|---|---|
| Card type chip (Email / Social / Flyer) | Derived from a `touchpoints[].type` field on the draft. Stored in `marketing_campaign_touchpoints` (new table: id, campaign_id, type, scheduled_at, payload jsonb, order_index, status, topics text[]). |
| Topic badges (Fall / Summer / etc.) | `marketing_campaign_touchpoints.topics text[]` — array of topic labels from the original Q1 input. Each topic gets a stable color (assigned at draft time). Lets the admin see at a glance which touchpoints cover which promoted thing. |
| Subject input (email) | `marketing_campaign_touchpoints.payload.subject`. |
| From field (readonly) | `organizations.default_sender_name + default_sender_email` (chunk 3.6.01). Not editable here. |
| "Edit there" link | Settings → Branding. |
| Send time input | `marketing_campaign_touchpoints.scheduled_at`. |
| Body textarea | `marketing_campaign_touchpoints.payload.body_template`. Existing `marketing-send` renderer interpolates `{{first_name}}`, `{{school}}`. |
| ✨ Regenerate (email) | Re-calls `marketing-draft-campaign` scoped to this touchpoint only. |
| Send test to me | Existing `marketing-send` with `mode=test`. Resend path. |
| Phone-frame preview | Rendered by the same template engine that `marketing-send` uses for real sends. Source of truth = `marketing-send/index.ts` renderer. |
| "Also pushes to parent portal" caption | Confirms the second write: `parent_portal_notifications` row created at send time. |
| Flyer Headline / Sub-headline / CTA inputs | Stored on the touchpoint's payload jsonb. Render: future flyer-render edge function (chunk 3.7+). Uses `org_branding` + `organizations.logo_url`. |
| Flyer Regenerate | Future flyer-draft edge function. |
| Download PDF | Future edge function returning a signed Supabase Storage URL. |
| Social Caption / Hashtags / Tags | On the touchpoint's payload jsonb. |
| Social Regenerate | Future social-draft edge function. |
| Copy caption | Local clipboard write (already implemented in the mockup). |

## Schedule review — Action bar

| Element | Wires to |
|---|---|
| Start over | Client-only nav back to Q1. Draft row stays in `marketing_campaigns` as orphaned draft until cleaned up. |
| Save as draft | Updates `marketing_campaigns` row, leaves `status=draft`, `approved_at=null`. |
| Approve & schedule | Sets `marketing_campaigns.status=ready`, writes `approved_at` + `approved_by` (chunk 01 columns). Inserts cron jobs / queues sends. Each touchpoint's `scheduled_at` becomes a cron tick into `marketing-send` with `ad_hoc_recipient_ids` (chunk 02). Promo code activation happens here if approved. |

## Celebration screen

| Element | Wires to |
|---|---|
| Confetti | Cosmetic. |
| Time-saved pill (~16h) | Same J2S baseline source as the schedule pill. |
| "What you unlocked" tiles | Counts from the schedule (touchpoints + promo). |
| Time-saved breakdown table | Per-line baselines from `project_enrops_time_saved.md`. |
| "Why this campaign will work" data | Industry-data lookups (future `marketing_insights` table). v1 hardcoded. |
| Homescreen wins preview | Mirrors the win card the Director will surface on the actual homescreen — that connection is part of the Director spec (chunk 01 of the Director build), not this chunk. |
| Back to campaigns / Build another | Client routing. |

## Contacts tab

| Element | Wires to |
|---|---|
| Sub-tabs (Parents / Partners / Instructors) | Three queries: `marketing_recipients` (parents), partner-org table (TBD; tied to chunks for Partner Hat), `instructors` table (existing). |
| Search + filters | All applied server-side. Parents: school filter via `school_name` or location alias; status via roster joins; segment via `marketing_recipients.segments` array. |
| "Send a message →" | Launches campaign builder pre-filled. Q2 audience locked to "single person" (or single org) with that contact's ID pinned. |
| Import contacts | Existing CSV import. Writes `marketing_recipients` with `source='manual'`. Dedup by email+school+source per existing rules. |

## Automations tab

| Element | Wires to |
|---|---|
| Toggle | `automation_settings` row per org (org_id, automation_key, enabled). New table OR reuse existing `automation_runs_log` parent table. |
| Edit copy | Per-org `automation_templates` (org_id, automation_key, subject, body_template). Falls back to platform default when null. Send path: existing `marketing-automations-cron`. |
| Six default automations | Thank-you / Mid-term recap / Final recap / Birthday / Pre-charge / Failed-charge. The pre-charge + failed-charge already wire to `process-installments` + `stripe-webhook` edge functions. |

---

## New schema introduced by this build

| Table or column | Purpose |
|---|---|
| `marketing_campaigns.draft_source / draft_inputs / draft_model / approved_at / approved_by` | Chunk 3.6.01 — already migrated. |
| `marketing_recipients.segments text[]` | Chunk 3.6.01 — already migrated. |
| `organizations.default_sender_name / default_sender_email / sending_domain / brand_voice` | Chunk 3.6.01 — already migrated. |
| `program_locations.name_aliases text[]` | Chunk 3.6.01 — already migrated. |
| `marketing_campaign_touchpoints` | New. One row per scheduled touchpoint inside a campaign. |
| `promo_codes` | New. Tracks the promo, expiry, programs in scope. |
| `automation_templates` | New (or extend existing). Per-org overrides for the 6 lifecycle automations. |
| `automation_settings` | New. Per-org on/off toggle for each automation. |
| `parent_portal_notifications` | Confirm whether existing table covers this; if not, add. |
| `campaign_assets` | Future (flyer storage references). |
| `campaign_social_posts` | Future. |
| `organizations.auto_close_days_before_start` | New column for the default cancellation policy banner. |
| `marketing_insights` | Future. Hardcoded copy in v1. |

## Edge functions involved

| Function | Status |
|---|---|
| `marketing-draft-campaign` | New, chunk 3.6.03. Drafts the plan via Claude. |
| `marketing-send` | Existing; chunk 3.6.02 added `ad_hoc_recipient_ids` for AI-resolved lists. |
| `marketing-automations-cron` | Existing. Runs the 6 lifecycle automations. |
| `marketing-unsubscribe` | Existing. Used by every email's List-Unsubscribe header. |
| `regenerate-email-logo` | Existing. Used when org_branding changes. |
| `create-checkout` / `stripe-webhook` / `process-installments` | Existing. Promo-code flow rides on top of these. |
| Flyer-draft / Social-draft / Flyer-render | Future. Not in chunks 3.6.x. |

## Third-party services

| Service | Used by | Where the secret lives |
|---|---|---|
| Resend (transactional email) | `marketing-send` only | Supabase Functions Secrets: `RESEND_API_KEY` |
| Anthropic (Claude) | `marketing-draft-campaign`, `polish-skills`, `extract-curriculum-details` | Supabase Functions Secrets: `ANTHROPIC_API_KEY` |
| Stripe (Connect) | `create-checkout`, `stripe-webhook`, `process-installments` | Supabase Functions Secrets + per-org `organizations.stripe_account_id` |
| Supabase Storage | Flyer PDFs (future) | Built-in |

## Out of scope for chunks 3.6.01–3.6.07

- Flyer rendering pipeline (`campaign_assets`, flyer-draft/flyer-render edge functions).
- Social post scheduling integration with IG/FB API (we draft + display; user copies for now).
- Partner-org schema (lives in Partner Hat chunks).
- Instructor messaging (lives in Instructor Hat chunks).
- The `marketing_insights` data source for "why this works" cards.
- The Director's homescreen wins feed (lives in Director chunks).
