# Onboarding + Instructor Portal v1 — Punchlist

_Snapshot: 2026-05-22, end of contractor-portal smoke-test pass._

---

## Onboarding (wizard) — to production

### Hard blockers (external)

1. **Checkr staging** — set Checkr API key + webhook secret as Supabase env vars; remove the stale webhook endpoint pointing at production from the Checkr dashboard; smoke-test the hosted-invitation → callback → status update path end-to-end
2. **Stripe Connect platform approval** — Stripe is currently reviewing the J2S platform application. Once approved: replace the SQL bypass with the real Express onboarding flow; verify Arielle's webhook is wired; confirm `STRIPE_INSTRUCTOR_PLATFORM_KEY` and webhook signing secret are set in Supabase

### Code/UX polish

3. **Wizard visual styling** — currently Tailwind neutrals; restyle progress bar, primary buttons, and accordion chrome to Enrops Plum/Gold/Chalk
4. **W-9 confirmation** — verify Stripe Connect Express collects 1099 tax info during payout setup. If it does, we're done. If not, add a W-9 upload step. (Currently ambiguous — needs answering before launch.)
5. **Completion variants** — smoke-test all four `overall_status` paths: `complete`, `pending_background_check`, `pending_stripe`, `payouts_disabled`
6. **Decline / Abandon flows** — `/j2s/onboarding/declined` and `/abandoned` exist as routes; confirm they're reachable and render the right copy
7. **Agreement PDF** — client generates a presentation PDF on submit and uploads to `contractor-documents`. Confirm it's landing in storage and matches the signed text
8. **Two-tab idempotency** — Screens 4 (agreement) and 5/6 (acks) have unique constraints; verify Screens 1, 3, 7, 8 also degrade cleanly on duplicate submits

### Notifications

9. **Invite email** — confirm `contractor-invite` magic-link email actually sends and lands in inbox
10. **Resend invite** — admin needs a "resend" button for stale invites (Send Invite currently invites once; what's the path for retry?)
11. **Onboarding-complete email** — decide: notify admin? notify contractor? both?

### Multi-tenant (post-v1)

12. **Per-tenant Checkr + Stripe secrets** — currently J2S-only; refactor to per-org once a second tenant is real

---

## Instructor portal v1

### Already built

Auth (magic link + Google OAuth) · onboarding wizard unified at `/:slug/instructor` · My Schedule (current + past camps) · Accept / Request Change with messaging · Profile (avatar, preferred name, phone, shirt, CPR) · per-cycle Availability survey · admin impersonation · Send Invite + admin BG-check upload

### Outstanding

1. **Nested routes refactor** — split `/j2s/instructor` from phase machine into shell + `<Outlet />` (`/onboarding`, `/schedule`, `/profile`, `/pay`, `/lessons`). Queued after Checkr lands so it doesn't muddy smoke-testing.
2. **`preferred_name` sweep** — Schedule.jsx greeting, instructor-facing emails, admin instructor list — all should display preferred name when set
3. **Lesson plans / rosters / pay** — per the spec Jessica will hand off

### Housekeeping

4. **Untracked edge functions** — `admin-invite` and `admin-list-members` sit in the working tree uncommitted. Decide: commit or delete
5. **Onboarding column drift** — `instructors.site_preferences` and `instructors.availability` columns still exist but are now write-only-via-survey. Document this in a schema comment so a future dev doesn't try to read them as onboarding state.
