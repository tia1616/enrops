# Apps Script integrations

Two Google Apps Scripts live in a tenant's own Google account and push
data into Enrops. Both authenticate the same way — the tenant's opaque
`organizations.apps_script_sync_secret` — and neither needs a Supabase
login.

| Script | Sheet it is bound to | Enrops function | Trigger |
| --- | --- | --- | --- |
| `roster-sync.gs` | the Squarespace camp-export Drive folder | `apps-script-roster-sync` | on change of "All Orders" |
| `website-lead-intake.gs` | "J2S Get Notified Submissions" | `website-lead-intake` | time-driven, every 5 min |

Install steps for each are the comment block at the top of that `.gs`
file. The rest of this README covers the roster sync; the lead intake is
documented at the bottom.

## Roster sync

A Google Apps Script that pushes per-camp Squarespace roster data into
Enrops on a schedule. Lives in the tenant's own Google account; calls
the public Supabase edge function `apps-script-roster-sync` with a
per-tenant secret.

## Why this exists

Squarespace doesn't have an Orders API on the Core plan, but it does
auto-sync exports to a Drive folder (one master "All Orders" sheet plus
one per-camp sheet). This script reads those per-camp sheets and POSTs
their rows to Enrops, where the edge function:

1. Authenticates via the per-tenant secret stored on
   `organizations.apps_script_sync_secret`.
2. Matches each Drive sheet to a `camp_session` by filename pattern
   (`M/D-M/D <session_type> - <venue> Summer Camp: <curriculum>`).
3. Upserts parent → student → registration rows.
4. Detects refunds via Squarespace's `Amount Refunded` column and
   marks the registration `cancelled` (never deleted, for audit).

This is a J2S-shaped patch for SU26. When providers run their
registrations through Enrops natively (FA26+), this whole pipeline
becomes vestigial and can be removed.

## Setup for J2S

See the comment block at the top of `roster-sync.gs` — that's the
canonical step-by-step. Tenants reading this for the first time should
go through those steps in order.

Need the secret? Jessica has it — it's `organizations.apps_script_sync_secret`
on the J2S org row. Don't paste it into commits.

## How the auth works

The script POSTs `{ secret, camp_filename, rows[] }` to the edge
function. The function looks up the org by the secret (UNIQUE column).
If the secret matches no org, returns 401 `invalid_secret`. If it
matches an org, all subsequent DB operations are scoped to that
`organization_id` — same RLS posture as if a JWT had been verified.

Rotating the secret: run `UPDATE organizations SET apps_script_sync_secret = encode(gen_random_bytes(32), 'hex') WHERE id = '<org_id>'`,
update the `ROSTER_SYNC_SECRET` script property, rerun
`syncAllRosters` once. Old secret stops working immediately.

## What's in this folder

- `roster-sync.gs` — the Apps Script source. Tenants paste this into a
  new Apps Script project. Includes inline setup comments.
- `website-lead-intake.gs` — the "Get Notified" lead sync. See below.
- This README — context for future maintainers.

## Website lead intake

The tenant's site has a "Get Notified" form (for J2S,
journeytosteam.com/notify). Squarespace appends every submission to a
Google Sheet. `website-lead-intake.gs` is bound to that sheet, runs on a
five-minute timer, and POSTs the un-synced rows to the
`website-lead-intake` edge function, which writes them to
`marketing_recipients`.

Three things about it that are easy to get wrong:

- **It cannot be an `onFormSubmit` trigger.** Squarespace appends rows
  through the Sheets API, not through a Google Form, so that trigger
  never fires. The timer is the only thing that sees the rows.
- **It never touches Squarespace's columns.** It adds one column,
  `synced_at`, at the far right of the sheet, and that is the only cell
  it ever writes.
- **A row is stamped only when Enrops says it handled it.** Created,
  merged, unchanged, and the deliberate skips (test row, unusable
  address, unsubscribed address) all stamp. A failure leaves the cell
  empty and the row is retried on the next run, so nothing is lost to a
  transient error — and nothing is imported twice, because the edge
  function fills blanks and unions tags rather than overwriting.

Every contact it creates carries the tag `website-notify`, plus one tag
per interest ticked (`after-school`, `winter-break-camps`,
`no-school-day-camps`, `spring-break-camps`, `summer-camps-2027`,
`birthday-parties`) and a `grade-K` / `grade-1` / … tag when the grade
answer is readable. A first-access campaign targets these through the
campaign builder's existing "A group / tag…" audience scope — pick
`website-notify` for everyone who signed up, or an interest tag for the
people who asked about that one thing.

There is no notes column on `marketing_recipients`, so the free-text
"anything we should know" answer stays in the sheet; only the grade is
lifted out of it.

## When this goes away

When J2S (or any tenant) switches to Enrops-native registration, the
camp_session_id is known at registration time and rosters land
directly in Supabase. The Apps Script can be deleted, the edge
function deprecated, and the `apps_script_sync_secret` column dropped.
