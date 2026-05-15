# Spec: PostHog Analytics v1

**Status:** Scoped, not yet implemented. Build after Connect v1 and Director shipping.
**Owner:** Jessica
**Date scoped:** 2026-05-14

## Goal

Capture first-tenant (J2S) user behavior so UI/UX decisions are data-informed before tenants 2+ onboard after the 2026-07-31 launch. Specifically: see drop-offs in the 3-question pattern, measure Boss Mode conversion, watch how parents/instructors actually move through registration and offer flows.

## Why PostHog over a custom Supabase events table

- Session replay on free tier — non-developer users can show Jessica *what they did*, not just what got logged.
- Funnels, retention, heatmaps out of the box; no dashboard work.
- Free tier: 1M events/mo, 5K session recordings/mo — plenty for J2S-only phase.
- Tradeoff accepted: external vendor, but data is exportable; can migrate to self-hosted or Supabase table later if needed.

## Multi-tenant rules (non-negotiable)

1. **Every event carries `org_id`** as a top-level property AND PostHog Group identity (`posthog.group('organization', org_id)`). Never hardcode J2S.
2. **User identity** uses Supabase `auth.user.id` via `posthog.identify(userId, { org_id, role })`. Roles: `parent`, `instructor`, `admin`, `director`.
3. **Tenant isolation in queries**: every PostHog dashboard/insight filtered by org_id group. When tenant 2 onboards, Jessica sees only J2S unless explicitly cross-tenant.
4. **Parent PII**: do not send email/phone as properties. Use Supabase user_id only; if a name is needed for replay, mask it via PostHog's autocapture privacy settings.

## Install scope

**Frontend (React/Vite app under `src/`):**
- Add `posthog-js` to dependencies.
- Initialize in `src/main.jsx` or equivalent root, behind env var `VITE_POSTHOG_KEY` so dev/preview/prod can diverge.
- Wrap in `AuthContext.jsx` to call `identify` + `group` on sign-in, `reset` on sign-out.
- Enable autocapture + session replay; disable on `/admin` routes if Jessica doesn't want her own clicks recorded.

**Backend (Supabase edge functions):**
- Defer. Frontend autocapture covers ~80% of what we need. Add server-side `posthog-node` later only for events that can't be observed from the client (stripe-webhook outcomes, marketing-send delivery).

## v1 event taxonomy (track these explicitly, on top of autocapture)

Bake the Enrops principles into the event names so the funnels mirror the product vision.

| Event | When | Properties (beyond org_id, user_id, role) |
|---|---|---|
| `director_opened` | Director surface loaded | `entry_point` (home/email/direct) |
| `three_question_started` | First of the 3 questions rendered | `flow_id` (e.g., `schedule_term`, `match_instructors`) |
| `three_question_answered` | Each question answered | `flow_id`, `question_index` (1/2/3), `time_to_answer_ms` |
| `three_question_completed` | All 3 answered | `flow_id`, `total_time_ms` |
| `not_now_clicked` | "Not now" affordance clicked anywhere | `surface` (which screen), `flow_id` |
| `approval_card_viewed` | Approval card shown | `card_type`, `flow_id` |
| `approval_card_decided` | Approve/Decline/Edit clicked | `card_type`, `decision`, `time_to_decide_ms` |
| `ltv_pill_shown` | LTV pill rendered | `pill_type`, `surface` |
| `ltv_pill_clicked` | LTV pill clicked | `pill_type`, `surface` |
| `boss_mode_prompt_shown` | Free→paid upgrade prompt rendered | `trigger`, `surface` |
| `boss_mode_prompt_clicked` | User clicks into Boss Mode upgrade | `trigger`, `surface` |
| `offer_response_recorded` | Director acceptance feed entry | `response` (accept/change/decline/no_response), `instructor_id_hash` |
| `registration_step_completed` | Parent registration funnel step | `step_index`, `step_name` |
| `checkout_initiated` | Stripe checkout opened | `amount_cents`, `installment_plan` |

**Note:** `instructor_id_hash` — hash the instructor user_id with a per-tenant salt before sending. Internal IDs out, never raw.

## v1 dashboards (built in PostHog UI, not code)

1. **3-question funnel** — `three_question_started` → `_answered` (1) → `_answered` (2) → `_answered` (3) → `_completed`. Broken down by `flow_id`. Watch where users drop.
2. **"Not now" map** — `not_now_clicked` grouped by `surface`. Tells Jessica which screens feel pushy.
3. **Boss Mode conversion** — `boss_mode_prompt_shown` → `_clicked` → checkout completed. By `trigger`.
4. **Approval card decisions** — decision distribution + time-to-decide histogram per card type.
5. **Director acceptance feed health** — offer_response distribution over time, response latency.
6. **Registration funnel** — per-step completion + drop-off, by school/term as breakdowns.
7. **Session replays filtered to first-time users** — Jessica watches the first N sessions of every new tenant.

## Consent / privacy

- Parents and instructors get a short privacy note at first sign-in: "We track in-app activity to improve the product. No personal data is sold or shared." (final copy TBD, run past legal review pre-launch).
- PostHog `opt_out_capturing()` available; expose a toggle in user settings post-launch.
- Set PostHog to mask all input fields by default in session replay (`session_recording: { maskAllInputs: true }`).

## What v1 deliberately does NOT include

- Server-side event capture from edge functions (deferred).
- Cross-tenant comparison dashboards (no other tenants yet).
- A/B testing / feature flags (PostHog supports it, but defer until launch).
- Cohort-based email triggers (different system; lives in marketing-send).

## Definition of done

- [ ] `posthog-js` installed, `VITE_POSTHOG_KEY` configured in prod
- [ ] `identify` + `group` wired in `AuthContext.jsx`
- [ ] All 14 v1 events fire from the right code paths
- [ ] Session replay confirmed working on a J2S parent registration
- [ ] 7 dashboards built in PostHog UI
- [ ] Privacy note added to first-login flow
- [ ] Jessica verifies she can pull replay of her own test session

## Open questions for Jessica

1. Cloud region: PostHog US or EU? (Parents are US-based — US is fine.)
2. Do you want the `/admin` (your own portal) recorded, or excluded?
3. Is "instructor_id_hash" enough anonymization for the offer feed event, or should the entire event be stripped of instructor reference?

## Estimated effort when picked up

- Install + identify/group plumbing: 1–2 hr
- 14 events instrumented across existing flows: 4–6 hr (depends on how much of the Director flow exists by then)
- Dashboards in PostHog UI: 1–2 hr
- Privacy note + opt-out toggle: 1 hr
- **Total: ~½ to 1 day of focused work** once the surfaces exist.
