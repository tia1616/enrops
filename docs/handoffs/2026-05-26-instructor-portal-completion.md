# Handoff — 2026-05-26 — Instructor portal (camps) ✅ done end-to-end

Paste this at the start of your next session.

---

## TL;DR for the next session

The **instructor portal for camps is end-to-end shipped.** Camp instructors can now be onboarded ASAP — invite → wizard → see schedule → see roster → mark sessions taught → see pay → access Stripe Express for payouts/1099s. SU26 rosters are loaded from Squarespace (230+ campers across 30+ camps via Apps Script). FA26 afterschool path **is not built yet** (task #37) — different shape, ~1-2 days when you're ready.

Pick up where: next session focus is whatever Jessica wants — instructor onboarding is unblocked.

## What shipped today (16 commits, 6 edge functions deployed, 6 migrations)

**Admin tools:**
- `+ Add instructor` modal on `/admin/instructors`
- `Remove instructor` flow: smart soft-delete if any history, hard-delete if zero history
- `/admin/payroll` (admin view of marked-taught sessions + auto-computed pay)
- `/admin/rosters` with CSV upload, manual entry, **inline per-camper edit** (allergies, medical, EpiPen, pickup, accommodations)

**Instructor portal:**
- Daily check-in section on assignment-detail (Mark Taught button per weekday; writes `session_delivery_confirmations`)
- Pay view (total earned + Processing/Approved/On hold totals + per-camp breakdown)
- Stripe Express deep link (signed login URL → opens their Stripe Express dashboard for payouts/1099s)
- Roster section now shows: camper name + age + grade, **parent contact** (name/phone/email), **medical "None reported by parent"** when blank, allergies + EpiPen flagged coral, emergency contact, authorized pickup
- Lesson docs now open inline in browser (PDFs viewable) instead of forcing download

**DB / infra:**
- `organizations.pay_hourly_cents` + `pay_camp_morning_hours` + `pay_camp_full_day_hours` + `pay_camp_weekly_bonus_cents` — J2S seeded ($20/hr, 3hrs morning/afternoon, 7hrs full_day, $100 weekly bonus)
- `organizations.apps_script_sync_secret` — per-tenant secret for Apps Script auth
- `registrations.camp_session_id` + RLS for instructor reads (camp rosters)
- `students` + `parents` RLS for instructor reads
- Unique index on `(camp_session_id, student_id)` for safe roster re-imports
- 6 cancelled J2S camps deleted (Community of Faith + First Congregational)
- 5 Minecraft camps + 1 LEGO Mechanical Engineers camp renamed to match linked curricula

**Apps Script roster sync (Jessica's Google account):**
- Edge function `apps-script-roster-sync` — receives per-camp rows, matches Drive filename to camp_session, upserts parents+students+registrations, handles refunds via Amount Refunded column, idempotent
- City alias map: Portland → [historic overlook, catlin gabel]; Vancouver → [firstenburg]; Oregon City → [st. paul, st paul]; Camas → [camas, lacamas]; others direct
- Script template at `docs/apps-script/roster-sync.gs`, setup doc at `docs/apps-script/README.md`
- `IGNORE_FILENAMES` property to skip cancelled-camp Drive sheets (Jessica's keeping for refund tracking)
- Weekly Sunday trigger set up by Jessica in her work Google account
- Result: 230+ campers loaded across SU26 camps with Drive sheets

**Earlier in the day (Stripe Connect cleanup):**
- Hardened `create-stripe-connect-account` against orphan Stripe accounts (pre-check search + delete-on-fail)
- Rejected orphan account `acct_1TaHAZI9b2uhR9Ut`

## Backlog (in priority order for instructor portal completion)

**Critical for FA26 (~3-4 days total):**
- **#37** FA26 afterschool instructor portal end-to-end — needs `program_assignments` table, per-week session derivation from `programs.day_of_week` + `first_session_date`, daily check-in branch for program_id, RLS for program rosters, pay computation for afterschool ($20 × 3 hrs/session per J2S policy). Registration data side already works (Enrops-native /j2s/register flow is live; 31 registrations in DB).
- **#46** Per-location skip dates for FA26 — `program_locations.skipped_dates DATE[]` + admin UI to enter them (teacher planning days, holidays). Session derivation skips these.

**Nice-to-have soon:**
- **#34** Front-end input validation across instructor portal (phone, names, email, DOB) — needed before real instructors hit the wizard
- **#27** Lower curriculum match threshold OR show all unlinked at publish time
- **#28** LinkExistingModal: optionally rename camp_session.curriculum_name when linking
- **#29** Backfill ages_min/ages_max on 54 of 57 J2S camps

**Multi-tenant platform work:**
- **#42** Tenant self-serve schedule CSV import (programs + camps)
- **#43** Tenant onboarding constraints wizard + per-org matching config — biggest gate for true self-serve onboarding (de-J2S-ify the matching algorithm constants)
- **#44** Availability survey results import (for tenants who ran surveys elsewhere)
- **#45** Tenant settings page (branding + pay rates + locations)
- **#47** LLM-assisted skip-date extraction (Option B: pre-fill Google search → operator picks URL → paste → LLM extracts dates → operator confirms)
- **#38** Tenant-onboarding CSV import polish (platform presets)

**Older queued (from prior sessions):**
- Test-mode Stripe keys (so future contractor smoke tests work)
- Viewer role on `org_members` (designers, accountants)
- `/admin/instructors` Add-instructor "send invite now?" flow
- Dora "newly cleared instructor" homescreen surface
- Real Enrops/J2S logo art (PWA icon)
- Admin actions on Payroll (approve/withhold/mark paid)
- Full dismissal flow (reason capture, pay reconciliation, open-assignment handoff)
- Instructor notification gap on unassign

## Open known limitations (J2S, today)

- Jessica's only confirmed camp assignment is **St. Paul's 7/6** — daily check-in shows but all days are "Upcoming" since camp hasn't started. Test path would be to seed a past-dated camp_session + assign her, or wait until 7/6.
- 2 stale Drive sheets in J2S folder (7/13 West Linn morning/afternoon, for cancelled Community of Faith camps) — keep for refund tracking; ignored by Apps Script via IGNORE_FILENAMES property.
- Hadley Horowitz's mom told Jessica she was refunded for 7/6 but Squarespace export doesn't show it yet. Sync will auto-cancel when Squarespace reflects the refund.
- 8 J2S camps at partner venues (Corbett, Forest Grove SCC for some weeks, West Linn Parks, Camas Community Ed, Lacamas Lodge afternoon series) — no Drive sheets; rosters need manual entry via `/admin/rosters` inline edit.

## Files / IDs to know

- J2S org: `1adf10ad-d091-4aa0-82e3-af331468ea2b`
- J2S Apps Script secret: stored on `organizations.apps_script_sync_secret` for J2S row
- J2S Squarespace Drive folder: `1AtX5bmG6Cuhjem0ssiA7VUr0YmvEIFmg`
- Apps Script source: `docs/apps-script/roster-sync.gs`
- Apps Script setup doc: `docs/apps-script/README.md`
