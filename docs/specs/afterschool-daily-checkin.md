# After-school Daily check-in (per-session pay marking) — spec

**Goal:** an after-school instructor can mark each weekly session taught and get paid,
exactly the way a camp instructor marks each camp day — closing the last camp↔after-school
parity gap in the instructor portal.

## What ALREADY exists (verified against live staging DB + code — no migration needed)

- `session_delivery_confirmations` already has `program_id` + a CHECK `one_session_reference`
  (camp_session_id XOR program_id), partial unique index `unique_program_delivery`
  (instructor_id, program_id, session_date), `session_type` CHECK allows `after_school`,
  `confirmed_by` CHECK allows `self`.
- `v_effective_pay_lines` already UNIONs a full **program branch** (program_assignments,
  program subs) — Payroll surfaces program confirmations with correct payee/sub routing.
- `tenant_pay_rates` already has `after_school` rates for J2S (lead 6000, developing 5000);
  `resolvePayAmount(org, role, session_type)` is generic and already lists `after_school`.
- `admin-confirm-session` already has a program branch (reads `row.session_type`), so the
  ADMIN confirm + pay path works for program rows today.
- `confirm-sub-delivery` already handles program subs and **hardcodes** `session_type='after_school'`
  ("programs don't carry session_type") — the exact pattern to mirror.
- RLS `instructor_read_confirmations` = `instructor_id = current_instructor_id()` (program-agnostic);
  `org_admins_write_confirmations` covers program rows. Edge fn uses service role anyway.
- Program meeting dates come from `derive_program_session_schedule(p_program_id)` (weekly cadence
  + closures) and are ALREADY loaded into the after-school detail view as the `schedule` prop.

## The gaps to build

### Chunk A — backend: `confirm-session-taught` program branch
Extend the existing function (mirror admin-confirm-session / confirm-sub-delivery, which both
branch camp/program in ONE function — the codebase pattern):
- Accept `program_assignment_id` as an alternative to `camp_assignment_id` (exactly one).
- Program branch: look up `program_assignments` by id → org, instructor, `status`, `role`.
- Auth: `assignment.instructor_id === me.id` (same as camp). Fail closed otherwise.
- Guard `status === 'confirmed'` (same committed-status invariant as camp).
- **Date validity (security):** validate `session_date` is a real session for this program by
  calling `derive_program_session_schedule(program_id)` and confirming a `kind='session'` row
  matches — the program equivalent of the camp `starts_on..ends_on` range check. Blocks a raw-API
  caller confirming an arbitrary date.
- Future guard: `session_date > today` → reject (same as camp).
- Sub guard: `assignment_substitutions` with `parent_assignment_type='program'`, date, status in
  (confirmed,taught) → 409 `session_covered_by_substitute`.
- `session_type = 'after_school'` (hardcode — programs carry none; mirror confirm-sub-delivery).
- Pay: `resolvePayAmount(org, role, 'after_school')` (null-tolerant, same as camp).
- Write: promote existing pending row (race-guard `confirmed_by='pending'`) OR insert fresh with
  `program_id` (null camp_session_id), `confirmed_by='self'`, `pay_status='approved'`, pay_amount.
  Idempotent on the `unique_program_delivery` index (handle 23505 → re-read + promote).
- Return `{ confirmation }` in the SAME shape the UI already consumes.
- deno check + existing deno tests; deploy to STAGING (verify_jwt stays true — instructor-auth).

### Chunk B — UI: `AfterschoolDailyCheckInSection`
Near-clone of `DailyCheckInSection`:
- Day list from `programSessionDates(schedule)` (already available; no new fetch).
- Load confirmations `.eq('program_id', programId)` (select must include `program_id`).
- Per-day state machine identical: Upcoming (future) / Mark taught / ✓ Marked taught; a
  `confirmed_by='pending'` placeholder is NOT counted as marked (same rule).
- Invoke `confirm-session-taught` with `{ program_assignment_id, session_date }`.
- Reuse `humanizeConfirmError`.
- Wire into `AfterschoolDetailView` (replace the "no check-in yet" comment), above the roster —
  matching the camp view's Location → Daily check-in → Roster → Lessons order.

### Chunk C — (DECISION) cron seeding for admin "confirm forgotten" parity
The instructor self-check-in (A+B) is complete standalone — the UI lists every session date
whether or not a row exists. BUT admin "Confirm & pay" on Payroll only shows days that have a
`session_delivery_confirmations` row. For camps, `session-confirmation-cron` seeds pending rows so
admin can pay a day the instructor forgot. After-school has no such seeding, so an unmarked
after-school session never surfaces for the admin to pay.
- **Option 1 (full parity):** extend the cron to seed pending program days for accepted
  program_assignments whose `derive_program_session_schedule` includes today (stamp
  session_type='after_school'). More work (per-program schedule derivation in the cron).
- **Option 2 (defer):** ship A+B; admin can only pay after-school days the instructor marked.
  Revisit if it becomes a real operational gap.
- Recommend: ship A+B now, decide C with Jessica.

## Pressure-test / control audit
- **Silent failure:** "Mark taught" errors render at the row via humanizeConfirmError (mirrors camp).
- **Honest state:** button → ✓ Marked taught (· by admin when admin-confirmed); pending placeholder
  still shows a live button (not falsely "marked").
- **Downstream effect:** self-mark → row → appears on Payroll (v_effective_pay_lines) approved →
  included in the payout. Verified end-to-end by SELECT-back on staging (eat the cooking).
- **Invariant in UI AND DB:** future/date-validity/status/sub guards enforced in the edge fn
  (DB write path); UI mirrors (only real dates shown, future disabled).
- **Multi-tenant:** org derived from the assignment row; no hardcoded tenant; tenant-rls-audit.
- **Idempotency:** unique_program_delivery index + 23505 handling; re-mark is a no-op.
