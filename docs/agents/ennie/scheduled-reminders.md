# Ennie — Scheduled operator reminders

*Recurring nudges Ennie surfaces on the provider homescreen (and via the
Director feed, when built). These run on the calendar — not in response to
data state changes — so they need to be set up to fire on a date relative
to a term's start.*

**Version:** v1 — 2026-06-01
**Implementation status:** spec only. The Director feed / reminder
infrastructure is not built yet. When it lands, it reads this file for the
catalog of recurring reminders to surface.

---

## Why these exist

Operators forget time-sensitive admin work that has lead time of
weeks-to-months. Facility reservations, insurance renewals, background
checks — none of these are triggered by a data state change Ennie can
detect; they're triggered by the calendar. Ennie's job is to surface them
before the deadline becomes a fire drill.

Each reminder defines: **what** to remind about, **when** to fire it
(relative to some anchor date), and **where** the operator goes to act on
it (a deep link into the relevant Enrops surface).

---

## Reminder: Facility reservations

**What:** Tell the operator to start reserving facilities for the upcoming
term — Facilitron, Mazevo, partner-school direct email.

**When:** **3 months before the term's first session date.**

For J2S today this means roughly:
- Fall term (Sep start) → reminder fires in **early June**
- Winter term (Jan start) → reminder fires in **early October**
- Spring term (Apr start) → reminder fires in **early January**

The anchor is the earliest `first_session_date` across all programs in the
upcoming term (per organization). If no programs in that term have a start
date set, fall back to a tenant-configured default month (FA=Sep, WI=Jan,
SP=Apr).

**Where the operator goes:** `/admin/programs` → select the upcoming term
→ work through the By-school view, expanding each school to copy session
dates into Facilitron / Mazevo, and clicking the facility pill to log
when each request is submitted and approved.

**Copy Ennie should use** (Mode A, operator-facing):

> "Heads up — the next term starts about 3 months from now. Most districts
> want facility reservations submitted 8–12 weeks ahead, so this is a good
> time to start. Open Scheduled programs → By school to walk through each
> site and copy the session dates into Facilitron or Mazevo. You can tick
> them off as you submit and as approvals come back."

**Dismissable:** yes. Once dismissed, snooze for 2 weeks then re-fire if
not all facilities for that term show approved.

**Stop firing when:** every program in the upcoming term has
`facility_approved_at` set.

---

## Other reminders (placeholders — flesh out when relevant)

Catalog inherited from `project_enrops_term_cycle` memory's "Always-on
tenant reminders" section. Each needs the same structure as facility
reservations above when implementation gets close.

- **COI insurance renewal** — 30 days before expiration.
- **Instructor background checks** — 60 days before per-district/per-school
  expiration; on new hire.
- **Volunteer forms** — on new hire; on assignment.
- **Contracts / partner agreements** — 60 days before renewal date.
- **Tabling / community events** — 2–3 months lead time before target
  event.

---

## Implementation notes (for whoever builds the Director feed)

- Reminders are **per-organization**. Multi-tenant: each tenant's
  reminders fire independently based on their own program dates and
  config.
- Anchor dates derive from real data (`programs.first_session_date`,
  `insurance_certificates.expires_at`, etc.) — not hardcoded calendar
  dates — so a tenant whose Fall starts in October gets the right nudge,
  not a J2S-specific one.
- Reminders persist in a `tenant_reminders` table (status: pending,
  dismissed, snoozed_until, dismissed_at) so dismissals stick across
  sessions.
- Dismissal copy should never be "ignore" — frame as "Got it, I've
  handled this" so the operator feels in control.
- Per `feedback_no_tech_jargon`: surface copy is plain English. No
  "Reminder fired" or "Trigger active" labels.
