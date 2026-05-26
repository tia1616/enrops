# Apps Script roster sync

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
- This README — context for future maintainers.

## When this goes away

When J2S (or any tenant) switches to Enrops-native registration, the
camp_session_id is known at registration time and rosters land
directly in Supabase. The Apps Script can be deleted, the edge
function deprecated, and the `apps_script_sync_secret` column dropped.
