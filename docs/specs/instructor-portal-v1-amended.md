# Instructor Portal v1 — Spec (amended 2026-05-22)

**Date:** 2026-05-22
**Owner:** Jessica
**Status:** Build-ready. Amendments locked after the 2026-05-22 review pass.
**Route:** `/${slug}/instructor` — `slug` derived from `organizations.slug`, never hardcoded. On a null slug, hard-fail to an error route; never fall back to a default tenant.
**Scope:** My Schedule (split: offers vs confirmed), My Profile (editable: preferred_name, phone, avatar, shirt_size, CPR cert, emergency contacts), Assignment Response (accept / request change).
**Out of scope (named, parked):** real-photo upload; class photos → parent portal; freeform instructor→admin messaging (see §9, deferred to v1.1). Availability and site_preferences are collected via the per-cycle survey (`InstructorAvailabilityForm`), NOT in this portal — handled separately.

---

## 0. Provenance & amendments

This spec is the source-derived original (verified 2026-05-22 by live DB query and deployed-source read) **plus amendments from the 2026-05-22 review pass** that addressed:

- Critical: SECURITY DEFINER RPC needs explicit REVOKE/GRANT (§3.3)
- New chunk 3 columns missing from profile spec: `preferred_name`, `shirt_size` (§3.1, §3.4)
- CPR cert re-upload missing from profile (§3.1, §3.4)
- Site_preferences + availability removed from profile (belong in per-cycle survey)
- Schedule card rendering rules made concrete (§2.3)
- Schedule query filter for status + cycle (§2.2)
- Admin-reply re-engagement loop defined (§4)
- 8 DiceBear seeds picked + avatars pre-hosted in `public-assets/avatars/` (§3.2)
- photo_url dual-semantics note (§5)

**Already-shipped preparation work that landed before this spec was built** (not part of the chunks below; reference only):
- `instructors.preferred_name TEXT` + `shirt_size TEXT` columns (migration 20260522_instructors_preferred_name_and_shirt_size)
- `src/lib/instructorName.js` helper (`displayFirstName`, `displayFullName`)
- `link-instructor` edge function returns `preferred_name`
- `/admin/contacts` page (Instructors tab) with "Send invite" button
- `camp_assignments.flags TEXT[]` column + extended `compute_distance_bonus()` trigger that writes flags (`location_override`, `location_low_pref`) alongside `distance_bonus_cents` (migrations 20260522_camp_assignments_flags_column + 20260522_compute_assignment_flags_in_trigger)
- Schedule.jsx InstructorChip renders flag badges; `send-offers` email body explains the bonus reason when `location_override` is set

**Deployed shared code (reused, not rebuilt):**
- `_shared/instructor.ts` — `resolveInstructor(req, opts)`, `adminClient()`, `corsHeaders`, `json()`, `clientIp()`, `userAgent()`.
- `_shared/onboardingStep.ts`, `_shared/gateCheck.ts` — onboarding-specific; not used here, listed for context.

**Helper functions:** `private.current_instructor_id()`, `public.user_org_ids()`, `public.is_org_member()`, `public.is_org_owner_or_admin()`.

---

## 1. What already exists (verified — no work needed)

**Tables & data:**
- `camp_sessions` — 57 rows, SU26 cycle.
- `camp_assignments` — 53 published (46 `confirmed`, 7 `published`-unconfirmed). Status values in live data: only `published`, `confirmed`. New `flags TEXT[]` column populated by the extended trigger.
- `instructor_offer_messages` — threaded admin↔instructor messages, scoped per `camp_assignment_id`. Already attributes each message by `sender_instructor_id` (thread-leak bug fix is in place — historical instructor replies stay attached to their original sender even after camp reassignment).
- `contractor_emergency_contacts`, `program_locations`, `scheduling_cycles` (1 row: SU26, status `scheduling`).
- `instructor_availability` (per-cycle, written by the existing survey form) — out of this spec's scope.

**RLS already live (do not modify):**
- `instructors` — instructor self-read via `auth_user_id = auth.uid()`. **No instructor UPDATE policy.**
- `camp_assignments` — instructor self-read on own published rows. Instructor self-UPDATE policy `instructor_self_assignments_respond` exists (see §4 — it gets dropped in Chunk F).
- `camp_sessions` — instructor reads sessions they're assigned to, via join through published `camp_assignments`.
- `program_locations` — `public_read_program_locations`: SELECT where org is active.
- `contractor_emergency_contacts` — instructor SELECT / INSERT / UPDATE. **No DELETE policy yet — Chunk A adds one.**
- `instructor_offer_messages` — instructor reads own; INSERT allowed with `sender_role = 'instructor'`.

---

## 2. Screen: My Schedule (split — offers vs confirmed)

### 2.1 Split layout
A `published`-but-unconfirmed assignment is an **open offer**; a `confirmed` one is a **locked schedule item**. The screen has two sections:
1. **"Needs your response"** — assignments with `status = 'published'` (and `status = 'change_requested'`). Shown at top.
2. **"Confirmed schedule"** — assignments with `status = 'confirmed'`.

> **Build note:** Chunk E first checks whether a component already renders at `/${slug}/instructor`. If so, extend it; if not, build per this section.

### 2.2 Data source (amended)
Direct client query, RLS-scoped, read-only.

```
camp_assignments
  WHERE instructor_id = <my id>
    AND published_at IS NOT NULL
    AND status IN ('published', 'change_requested', 'confirmed')   -- excludes withdrawn / declined / proposed
    AND camp_session_id IN (
      SELECT id FROM camp_sessions
      WHERE cycle_id IN (
        SELECT id FROM scheduling_cycles
        WHERE organization_id = <my org>
          AND status <> 'archived'                                  -- current and recent cycles only
      )
    )
  → camp_sessions (via camp_session_id)
    → program_locations (via camp_sessions.location_id)
```

Status filter excludes admin-withdrawn rows. Cycle filter excludes archived prior-term assignments — SU26 today, picks up FA26 automatically when scheduled.

### 2.3 Fields per assignment card (amended with concrete rendering)

**Data fields:**
- `camp_sessions`: `week_num`, `starts_on`, `ends_on`, `class_days`, `session_type` (`morning`/`afternoon`/`full_day`), `start_time`, `end_time`, `curriculum_name`, `curriculum_category`, `current_enrollment`, `ages_min`, `ages_max`.
- `camp_assignments`: `role`, `status`, `distance_bonus_cents`, `flags`, `deadline`, `change_request_message`.
- `program_locations`: `name`, `address`, `room_number`, `arrival_instructions`, `food_drink_policy`, `contact_name`, `contact_email`, `contact_phone`, `notes`.

**Render rules:**
- **Role:** "Lead Instructor" / "Developing Instructor" (friendly label, never raw enum). Read-only on instructor side.
- **Status pill:**
  - `published` → "Awaiting your response"
  - `change_requested` → "Change requested — waiting on admin"
  - `confirmed` → "Confirmed ✓"
- **`distance_bonus_cents`:** render only when `> 0`. Display as "+$50 distance bonus" (`cents/100`, no decimals unless non-integer).
- **`change_request_message`:** when status is `change_requested`, render the instructor's own previous message inside the card under a label "Your message:".
- **`session_type` sort:** explicit ordinal `morning(0) < afternoon(1) < full_day(2)`.
- **Empty / null `class_days`:** display "Days TBD".
- **Null `current_enrollment`:** display "Enrollment not yet synced" (rare; happens before the term's first sync).
- **Message thread (`instructor_offer_messages`):** when card is in `change_requested` status, render the read-only thread inside the card. RLS already allows the read. Messages attributed by `sender_instructor_id`.

### 2.4 Sort, group, empty state
Within each section, group by `week_num` ascending; within a week sort by `session_type` (ordinal above) then `start_time`.
- **Zero assignments:** "No camp assignments yet. Your coordinator will send offers as the schedule fills in."
- **Offers section empty, confirmed populated:** hide the offers section entirely.

### 2.5 Performance
Confirm a btree index on `camp_assignments.instructor_id` exists; if absent, add it.

---

## 3. Screen: My Profile (editable)

### 3.1 Read (amended)

Direct client query, `instructors` self-read RLS.

**Profile screen displays:**
- `first_name`, `last_name` — **read-only.** Legal name was locked when the contractor agreement was signed. Helper text: "Need a legal-name change? Contact admin."
- `preferred_name` — **editable.** Optional. What you go by day-to-day (e.g. Rebecca → Bo). Drives `displayFirstName` everywhere.
- `email` — read-only.
- `phone` — editable.
- `avatar` (in `photo_url`) — editable. See §3.2.
- `shirt_size` — editable. Optional. Enum: `XS, S, M, L, XL, 2XL, 3XL`.
- `contractor_tier` — read-only.
- `first_aid_cpr_url` + `first_aid_cpr_expires_at` — **editable as a pair.** Optional. See §3.3 for upload rules.
- `contractor_emergency_contacts` — editable, see §3.4.

**Not in this screen** (belong to other surfaces):
- `site_preferences` (districts) — collected via the per-cycle availability survey.
- `availability.day_defaults` — collected via the per-cycle availability survey. The `instructors.availability` column is vestigial and not read by anything that matters; the canonical source is `instructor_availability` per cycle.
- `date_of_birth` — set during onboarding for minor detection; not user-editable.

### 3.2 Profile photo — preset avatars

Instructors pick from 8 preset DiceBear `bottts` avatars. The DB stores the avatar KEY, not a URL.

**The 8 seeds** (locked 2026-05-22):
`bottts-1=astro, bottts-2=bolt, bottts-3=comet, bottts-4=delta, bottts-5=echo, bottts-6=flux, bottts-7=gamma, bottts-8=helix`

**Hosting:** SVGs pre-uploaded to Supabase Storage at `public-assets/avatars/bottts-{1..8}.svg`. Public bucket. Verified 2026-05-22 — URLs return 200.

**Storage column:** `instructors.photo_url` (existing nullable text) stores the key string (`bottts-1`…`bottts-8`). Comment at every read/write site MUST state "holds an avatar key, not a URL, since instructor portal v1." Column rename deferred to v1.1.

**Unset state:** `photo_url = NULL` is a designed state — UI shows a neutral default placeholder defined in `DEFAULT_AVATAR`.

**`[NEW]` Frontend constants `src/lib/avatars.js`:**
- `AVATARS`: 8-entry array `[{ key, seed, label }]` where `label` is the picker chip text ("Robot 1" through "Robot 8").
- `DEFAULT_AVATAR`: explicit unset-state placeholder.
- `avatarUrl(key)`: resolves a key (or null) to a Storage URL; returns the default for null/unknown.

**Two sources of truth for keys:** `update-instructor-profile` (§3.5) hardcodes its own copy of the 8 valid keys since Deno can't import from `src/`. Each location carries a comment pointing at the other. The 8 keys are short fixed strings — drift risk minimal but acknowledged.

**Where the avatar renders:** profile screen (8-grid picker + chosen state); `InstructorPortal.jsx` greeting where the existing photo thumb sits; admin Contacts page (`InstructorsTab.jsx`) thumbnail — needs to swap from raw `photo_url` to `avatarUrl(key)`.

### 3.3 CPR cert re-upload (`[NEW]` in this amendment)

Same upload constraints as the chunk 3 onboarding Screen 8:
- Allowed MIME: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`.
- Max 5MB.
- HEIC→JPEG conversion happens client-side via existing `ensureBrowserSafeImage` helper.
- Storage path: `contractor-documents/{instructor_id}/cpr_cert_{timestamp}.{ext}`.
- Both `first_aid_cpr_url` AND `first_aid_cpr_expires_at` must be set together — if user uploads a file but doesn't provide an expiry date, inline error "Add the expiry date from the certificate."
- Non-blocking warning if expiry date is in the past: "This certificate has already expired — you may want to upload a current one."

### 3.4 Emergency contacts — replace-the-whole-set, transactional

**Object shape:** each contact `{ contact_name, relationship, phone }`. All three required. `is_primary` is derived from array position (index 0 = `true`), never sent by the client.

**Write model:** the client sends the full ordered array. The write deletes all the instructor's existing rows and re-inserts. **MUST be atomic** — see RPC below.

**`[NEW]` RPC `public.replace_emergency_contacts(uuid, uuid, jsonb)` — SECURITY DEFINER, search_path pinned, atomic delete+insert:**

```sql
create or replace function public.replace_emergency_contacts(
  p_instructor_id   uuid,
  p_organization_id uuid,
  p_contacts        jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c    jsonb;
  idx  int := 0;
begin
  delete from public.contractor_emergency_contacts
   where instructor_id = p_instructor_id;

  for c in select * from jsonb_array_elements(p_contacts)
  loop
    insert into public.contractor_emergency_contacts
      (instructor_id, organization_id, contact_name, relationship, phone, is_primary)
    values (
      p_instructor_id,
      p_organization_id,
      c->>'contact_name',
      c->>'relationship',
      c->>'phone',
      idx = 0
    );
    idx := idx + 1;
  end loop;
end;
$$;

-- CRITICAL: SECURITY DEFINER + default PUBLIC EXECUTE is a privilege escalation
-- foot-gun. Lock execution to service_role only.
revoke execute on function public.replace_emergency_contacts(uuid, uuid, jsonb) from public;
revoke execute on function public.replace_emergency_contacts(uuid, uuid, jsonb) from anon, authenticated;
grant  execute on function public.replace_emergency_contacts(uuid, uuid, jsonb) to service_role;
```

**`[NEW]` Migration — DELETE policy on `contractor_emergency_contacts` (defense-in-depth):**

```sql
create policy instructor_delete_ec
  on public.contractor_emergency_contacts
  for delete
  using ( instructor_id = private.current_instructor_id() );
```

### 3.5 `[NEW]` Edge function: `update-instructor-profile`

- **verify_jwt:** `true`.
- **Shared code:** `_shared/instructor.ts`.
- **Method:** POST; OPTIONS → 200; else 405.
- **Preamble:** `resolveInstructor(req)` (defaults). Return `error` as-is.
- **Body** (all optional): `{ preferred_name?, phone?, avatar_key?, shirt_size?, first_aid_cpr_url?, first_aid_cpr_expires_at?, emergency_contacts? }`.
- **Empty-body rule:** if no field present, return `200 { success: true, noop: true }`.
- **Field handling:**
  - **`preferred_name`** — string; trim; cap 1000. Empty after trim → set to NULL (clears). Otherwise → update `instructors.preferred_name`.
  - **`phone`** — trim. Empty after trim → ignore (don't overwrite a real number with ''). Cap 1000. Updates `instructors.phone`.
  - **`avatar_key`** — must be one of `bottts-1`…`bottts-8`. Invalid → `400 { error: 'invalid_avatar' }`. Updates `instructors.photo_url`.
  - **`shirt_size`** — must be one of `XS, S, M, L, XL, 2XL, 3XL`. Invalid → `400 { error: 'invalid_shirt_size' }`. Empty string → clears (sets NULL).
  - **`first_aid_cpr_url`** — string; updates `instructors.first_aid_cpr_url`. If present, `first_aid_cpr_expires_at` is also required → `400 { error: 'cpr_expiry_required' }` if missing.
  - **`first_aid_cpr_expires_at`** — `YYYY-MM-DD` string; updates `instructors.first_aid_cpr_expires_at`.
  - **`emergency_contacts`** — non-empty array required if present (`400 emergency_contacts_required`). Every element validated (`400 contact_fields_required`). Then RPC `replace_emergency_contacts` is called with server-resolved instructor id + org id.
- **Write order:** `instructors` UPDATE first via service-role client (bypasses absent instructor UPDATE RLS); then RPC if `emergency_contacts` present. If `instructors` UPDATE succeeds and RPC fails, return RPC error — partial save is acceptable; instructor retries contacts. Frontend behavior on partial success: keep form dirty, show inline error "Phone/avatar saved, but emergency contacts didn't save — please try again."
- **Response:** `200 { success: true }` or `4xx/5xx { error }`.

---

## 4. Assignment Response (accept / request change)

### 4.1 Status model (verified)
`camp_assignments_status_check` allows: `proposed, confirmed, change_requested, published, withdrawn, declined`.
- Instructor can only transition `published` → `confirmed` OR `published`/`change_requested` → `change_requested`.
- `withdrawn` is admin-only. `declined` is intentionally unused in v1.

### 4.2 The problem with the current RLS
`camp_assignments` UPDATE policy `instructor_self_assignments_respond` doesn't constrain `status`. Direct client could write `declined`/`withdrawn`. **Chunk F drops this policy** after `respond-to-assignment` is deployed.

### 4.3 `[NEW]` Edge function: `respond-to-assignment`

- **verify_jwt:** `true`. **Shared:** `_shared/instructor.ts`.
- **Method:** POST; OPTIONS → 200; else 405.
- **Body:** `{ camp_assignment_id, action: 'accept' | 'request_change', message? }`.
- **Preamble:** `resolveInstructor` defaults.
- **Logic:**
  1. `action` validation → `400 invalid_action`.
  2. If `request_change`: message required, non-empty after trim, cap 1000 → `400 message_required`.
  3. Fetch assignment via service role: `select id, instructor_id, status, published_at, organization_id, camp_session_id`.
  4. Anti-enumeration: no row OR `instructor_id !== me.id` → `403 forbidden`.
  5. `published_at IS NULL` → `400 not_published`.
  6. Status guard: only `published` or `change_requested` may transition. `confirmed` → `400 already_confirmed`. `withdrawn`/`declined`/`proposed` → `400 assignment_closed`.
  7. **Write order (matters):**
     - `request_change`: **first** insert into `instructor_offer_messages` `{ organization_id, camp_assignment_id, sender_role: 'instructor', sender_instructor_id: me.id, message }`. Failure → `500 message_insert_failed`, status untouched. **Then** update `camp_assignments` → `status='change_requested'`, `change_request_message=message`, `instructor_response_at=now()`.
     - `accept`: update `camp_assignments` → `status='confirmed'`, `instructor_response_at=now()`. No message row.
  8. Post-message status failure (request_change): `500 status_update_failed`. Orphan message is acceptable (admin-visible, instructor retries).
  9. Return `200 { success: true, status }`.

### 4.4 Admin-reply re-engagement (`[NEW]` in this amendment)

When the admin replies to a change request via `offer-message-reply` (a new row in `instructor_offer_messages` with `sender_role='admin'`):

- **Status does NOT change.** Stays `change_requested` until the instructor takes another action.
- **Frontend detection** for re-enabling the "Request Change" button: look at the latest message in the assignment's thread; if `sender_role='admin'`, the button is enabled. If `sender_role='instructor'` (the instructor's pending message is the most recent), button stays disabled.
- The "Accept" button is always enabled when status is `published` or `change_requested`.
- After admin reply, instructor can either Accept the original offer (moves to `confirmed`) or send a new change request (re-uses the same row's `change_request_message` field — column gets overwritten — and inserts a new message into the thread).

The thread-leak fix is already in place (`sender_instructor_id` attribution), so even when the assignment was reassigned in the past, messages stay correctly attributed and this detection works.

### 4.5 `[NEW]` Migration — drop the direct UPDATE policy
```sql
drop policy instructor_self_assignments_respond on public.camp_assignments;
```

Runs **last** in Chunk F, only after `respond-to-assignment` is deployed and the UI calls it.

---

## 5. Chunk contracts (amended)

**Every new edge function requires (verified):** `_shared/instructor.ts` deployed; `camp_assignments` / `camp_sessions` instructor SELECT RLS live; `private.current_instructor_id()` exists.

**Guarantees to downstream:**
- `respond-to-assignment` only ever sets `camp_assignments.status` to `confirmed` / `change_requested`.
- After §4.5, instructors have no direct UPDATE on `camp_assignments` — `respond-to-assignment` is the sole instructor write path.
- Emergency contacts canonical write path is `update-instructor-profile` → `replace_emergency_contacts` RPC. RPC guarantees atomic set replacement + `is_primary` index-0 invariant.
- `instructors.photo_url` now holds an avatar key string (`bottts-N`), not a URL, for instructors who have used the portal. **Note dual-semantics:** the onboarding wizard's `welcome` step is still nominally able to write a storage path here (currently doesn't send one). v1.1 rename `photo_url` → `avatar_key` would fix the misnomer; until then, all readers must treat the column as an avatar key string and resolve via `avatarUrl()`.

**Migrations introduced:**
1. `replace_emergency_contacts` RPC + REVOKE/GRANT lock-down + `instructor_delete_ec` DELETE policy. (Chunk A)
2. Drop `instructor_self_assignments_respond`. (Chunk F, last)

---

## 6. Security & error handling

Same as the original spec. Key additions from this pass:
- §3.4 RPC EXECUTE permissions locked to `service_role` only (critical fix).
- Phone format validation deferred (accepted v1 risk).
- Avatar runtime dependency removed by pre-hosting in `public-assets`.

---

## 7. Pressure-test — instructor flow

Same scenarios as original spec, plus:
- **Admin replies to a change request** → Status stays `change_requested`. Instructor's "Request Change" button re-enables based on `sender_role='admin'` detection. Accept button always enabled.
- **Profile partial-save failure** (instructors UPDATE succeeded, RPC failed) → inline error keeps form dirty, instructor retries.

---

## 8. Chunk breakdown

### Chunk A — Migration: RPC + DELETE policy
- One migration file: `replace_emergency_contacts` SECURITY DEFINER function **with REVOKE/GRANT** AND `instructor_delete_ec` policy.
- No dependencies. Run anytime.
- **Done when:** `pg_proc` shows function with `search_path` pinned; `pg_policies` shows the DELETE policy; `information_schema.routine_privileges` confirms only `service_role` has EXECUTE.

### Chunk B — Edge function: `respond-to-assignment`
- Build per §4.3. `verify_jwt: true`. Reuses `_shared/instructor.ts`.
- Message-insert-before-status-update ordering critical.
- **Done when:** deployed; `accept` and `request_change` both tested against a real SU26 assignment; double-submit returns `already_confirmed`.

### Chunk C — Edge function: `update-instructor-profile`
- Build per §3.5. `verify_jwt: true`. Calls the `replace_emergency_contacts` RPC.
- Hardcodes the 8 avatar keys and the shirt-size enum.
- **Requires:** Chunk A deployed.
- **Done when:** deployed; preferred_name, phone, avatar (valid + invalid), shirt_size (valid + invalid), CPR upload (with + without expiry), emergency-contact replace (valid + empty + malformed) all tested; empty body returns `noop`; partial-success path returns RPC error cleanly.

### Chunk D — Avatar constants `src/lib/avatars.js`
- File per §3.2: `AVATARS` (8 entries with labels), `DEFAULT_AVATAR`, `avatarUrl(key)`.
- URLs resolve to `https://iuasfpztkmrtagivlhtj.supabase.co/storage/v1/object/public/public-assets/avatars/bottts-N.svg` (already uploaded and verified 2026-05-22).
- **Done when:** file exists; 8 keys match the edge-function copy; `avatarUrl` returns correct URLs and the default for null/unknown.

### Chunk E — Frontend: My Schedule + My Profile
- Check whether a schedule component already renders at `/${slug}/instructor`. Extend if present; build per §2 if not.
- **My Schedule** (§2): RLS query with status + cycle filters; split into "Needs your response" / "Confirmed schedule"; status pills + concrete render rules per §2.3.
- **My Profile** (§3): read view + edit form (preferred_name, phone, 8-avatar grid, shirt_size, CPR upload, emergency contacts). Calls `update-instructor-profile` (Chunk C); uses `src/lib/avatars.js` (Chunk D). Form-dirty tracking so a no-change save doesn't call the function.
- Also check: any existing admin-side code reading `instructors.photo_url` as a URL — adjust to use `avatarUrl()` resolution. Known site: `src/pages/admin/contacts/InstructorsTab.jsx` thumbnail.
- **Requires:** C + D for the profile; nothing for the schedule.
- **Done when:** both screens render on SU26 data; profile edits round-trip; default avatar renders for null `photo_url`; admin Contacts thumbnail resolves through `avatarUrl()`.

### Chunk F — Frontend: Assignment Response + drop-policy migration
- Pre-migration check: grep frontend for any direct `.from('camp_assignments').update(...)`. Repoint at `respond-to-assignment` if found.
- **Assignment Response UI** (§4): Accept / Request-change buttons on each "Needs your response" card. Render the `instructor_offer_messages` thread per assignment (read-only on instructor side). Admin-reply re-engagement detection per §4.4.
- **Migration:** drop `instructor_self_assignments_respond` — run **last**, only after B is deployed and this UI calls it.
- **Requires:** B deployed; E done.
- **Done when:** instructor can accept / request-change from the UI; `pg_policies` confirms the direct UPDATE policy is gone; a direct client UPDATE on `camp_assignments` now fails.

### Dependency graph
```
A  ── independent (run anytime)
B  ── independent (needs _shared/instructor.ts — already live)
D  ── independent, tiny (gates avatar parts of C + E)
C  ── needs A (the RPC)
E  ── schedule half independent | profile half needs C + D
F  ── needs B deployed + E done; contains the drop migration (LAST)
```

---

## 9. Deferred to v1.1 — freeform instructor→admin messaging

(Unchanged from original spec.)

The freeform messaging surface that doesn't hang off a specific camp_assignment_id is deferred. v1 already covers assignment-related messaging via `request_change` + `offer-message-reply`. v1.1 needs either a new table or nullable `camp_assignment_id` plus unread-state mechanism and email trigger.

---

## 10. Locked decisions from this amendment pass

For reference when chunks A-F are built:

1. **Site_preferences + availability stay in the per-cycle survey** (`InstructorAvailabilityForm`). NOT in profile. NOT in this spec.
2. **Preferred name + shirt size** are editable in profile.
3. **CPR re-upload** in profile, optional, with expiry validation.
4. **8 DiceBear seeds locked:** astro, bolt, comet, delta, echo, flux, gamma, helix.
5. **Avatars pre-hosted** in `public-assets/avatars/bottts-{1..8}.svg`. Public bucket. URLs verified 2026-05-22.
6. **First / last name are read-only** in profile. Locked by signed contractor agreement.
7. **Admin-reply re-engagement:** status stays `change_requested`; "Request Change" button re-enables when newest message in thread is from `sender_role='admin'`.
8. **REVOKE/GRANT on the RPC** is part of Chunk A — not optional.
9. **Distance-bonus / location-flag persistence** already landed before this spec — the matcher's `location_override` and `location_low_pref` flags are written to `camp_assignments.flags` by the trigger and surfaced as chip badges + email reasoning. Schedule UI and `send-offers` already updated; `send-offers` source has the update but isn't redeployed yet (deferred until next deploy pass).
