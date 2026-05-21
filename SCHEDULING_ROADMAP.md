# Scheduling roadmap

Snapshot of what works end-to-end on the Schedule page today, what's still
missing for J2S's future cycles, and what blocks a fresh tenant from
self-serving.

Written 2026-05-19. Last updated 2026-05-20. Last cycle worked through: SU26.

---

## ✓ Works end-to-end now (J2S, mid-cycle)

If a tenant has their org + locations + cycle + camp_sessions + instructors
already loaded, the Schedule page runs a cycle without admin SQL:

- Run match-instructors agent (collecting phase only)
- Drag + tweak draft (lead ↔ developing, travel conflict, full-day → half-day)
- Approve draft (button auto-hides when no proposed rows remain)
- Preview offers (renders with deadline)
- Send offers (writes audit row per send)
- Phase-aware header chrome (only relevant action buttons show)
- Hat tip surfaces what's next per cycle phase
- Patch-send after reassign (clears email trail, surfaces in Hat)
- Change-request queue with auto-advance + skip + confirm-before-unassign
- Resend offer from picker
- Message any instructor from picker (free-text email)
- Conversation thread per instructor — attributed to **actual sender** via
  `sender_instructor_id`, so a reassigned camp's old messages stay tied to
  the prior instructor instead of falsely showing up under the new one
- Auto-reminders cron + manual reminder fire
- Email activity log + click-to-view-the-actual-email
- Email activity log: **search by instructor name** + filter chip counts
  update live to that search
- Declined-instructor memory + Re-suggest button to undo
- Term/cycle picker in header (when multiple cycles exist)
- ModalShell scrolls body when content overflows — the close X stays
  reachable on any screen height
- **DB-level trigger guards every camp_assignments write** for instructor
  double-bookings + same-day-different-location travel conflicts. The
  UI's validateDrop runs the same logic for real-time drag feedback, but
  the trigger is the safety net for SQL bypasses, future automations,
  and any new write path. Cleared one historical conflict (Michele's
  Wk5 Happy Valley collision) during install
- **Locations admin page** (`/admin/locations`) — add/edit venues
  without SQL. Address, room, contact, arrival, food/drink, notes all
  land in instructor emails. Closes tenant-2 blocker #1

---

## 🚧 Blockers for Tenant #2 onboarding

Things that today require Jessica + Claude to do SQL. Tenant #2 cannot
self-serve onboard until these have admin UIs.

### 1. ~~`program_locations` CRUD UI~~ — ✓ shipped 2026-05-20

Lives at `/admin/locations`. Add new venue, edit any field, see how many
camps reference each venue. Every instructor-facing field carries a
"Visible to instructors" pill so admin knows what lands in emails.
Remaining nit: no "Mark inactive" toggle — would need an `is_active`
column on `program_locations` (not added yet). Low priority; venues
stay around even if no camps reference them.

### 2. `scheduling_cycles` create UI — high impact

**Today:** Manual SQL. SU26 was hand-inserted.
**Needed:** "New cycle" button that walks through:
- Cycle code (SU27 / FA27 / WI28 / SP28)
- Cycle type (summer_camp / afterschool)
- Start + end dates (auto-derive weeks for camps)
- Defaults: auto_reminders_enabled = true, status = 'collecting'

**Scope:** ~1 session. Form + Supabase insert.

### 3. `camp_sessions` bulk create + edit UI — medium impact

**Today:** J2S loads from Drive master dash manually
([drift memory](.claude/projects/.../project_enrops_drive_supabase_drift.md)).
**Needed:** Either:
- (a) Programs page where tenant enters which curriculum runs where each
  week, and Enrops generates the camp_sessions rows
- (b) Import-from-spreadsheet flow (paste/upload, validate, commit)

Linked to **#4** below — the natural home is the Programs tab Jessica
described, which feeds both this and parent-facing registrations.

**Scope:** ~2-4 sessions depending on whether we build the full Programs
tab or just a thin "Add session" form.

### 4. Programs tab (sibling page to Schedule) — high impact

Per Jessica's workflow:
1. **Build programs** (which curriculum runs at which venue, what days,
   how many weeks) — *where* the data is set up
2. **Open registrations** to parents — already works
3. **Send availability survey** to instructors — see #5
4. **Build instructor schedule** — this is the current Schedule page

The Programs tab is stage 1. Likely structure:
- List view: "all programs in this cycle" filtered by cycle picker
- Per-program editor: curriculum, location, day/time, age range, capacity,
  price, registration window
- "Open registrations" toggle that flips program.status active

Architectural wrinkle: camps cycles use `camp_sessions.cycle_id` to link.
Afterschool uses `programs.term` (free text). Either:
- Add `programs.cycle_id` FK (schema change + backfill)
- OR keep them parallel and have Schedule page query both based on
  `cycle.cycle_type`

Recommend adding `programs.cycle_id` for consistency.

**Scope:** ~3-5 sessions.

### 5. In-portal availability survey — high impact

**Today:** Google Form → manual transcription
([drift memory](.claude/projects/.../project_enrops_drive_supabase_drift.md)).
**Needed:** Instructor portal page where they:
- See cycle dates
- Check which weeks they're available
- Check session types (Morning / Afternoon / Full Day)
- Set location preferences per venue (Highly preferred / Preferred / Not
  preferred / Unavailable)
- Set curriculum category prefs (LEGO / Coding / Robotics)
- Mark specific dates as unavailable (date picker — see
  [survey import gap memory](.claude/projects/.../project_enrops_survey_import_gap.md))
- Pick role preference (Lead only / Both / Developing only)
- Saturday availability toggle
- Notes textarea

Writes to existing tables: `instructor_availability`,
`instructor_location_preferences`, `instructor_curriculum_preferences`.

**Scope:** ~2-3 sessions. Big screen but straightforward CRUD.

### 6. Instructors management page — medium impact

**Today:** Picker has "+ Add new instructor" (one-off) but no list view to
manage existing.
**Needed:** "Instructors" nav (already stubbed as "soon"):
- List all instructors for the org
- Add new
- Edit profile (name, email, phone)
- Toggle active / inactive
- View their assignment history across cycles
- View their current availability for active cycles

**Scope:** ~1-2 sessions.

---

## 🛠 Smaller workflow gaps still in Schedule page

These don't block tenant-2 but show up as friction for J2S over time.

### A. send-patch-offer bundling on resend

**Symptom:** If Skyler has 3 pending patches, clicking "Resend offer" on
one of her chips bundles all 3 into the email. Sometimes desired,
sometimes not.
**Fix:** Add a `single_only: true` flag to send-patch-offer that limits the
query to only the passed assignment_id. Resend flow uses single, the Hat
tip's bulk-pending flow uses bundled (current behavior).
**Scope:** 30 min — edge function + frontend.

### B. Realtime not covering new tables

**Symptom:** Two admins editing at once won't see each other's writes to
`instructor_offer_messages` or `session_declined_instructors` until refresh.
**Fix:** Subscribe to these tables in the Schedule page's realtime channel.
**Scope:** ~1 hour.

### C. Match-instructors doesn't read declines

**Symptom:** Re-running the agent mid-cycle could re-suggest a declined
instructor. Currently blocked by `canRematch = cycle.status === 'collecting'`,
so the case is theoretical, but worth fixing if re-runs ever become useful
mid-cycle.
**Fix:** Pass declined-instructor list into the match function and filter
out of its candidates per session.
**Scope:** ~1 hour. Edge function change + redeploy.

### D. Email template drift

**Symptom:** The JS renderers in EmailActivityModal can drift from the
server-side templates in send-offers / send-patch-offer / offer-reminders-cron.
**Long-term fix:** Store rendered HTML in `instructor_offer_messages.html`
at send time. Then "view email" reads verbatim from the row instead of
re-rendering.
**Scope:** ~1 session. Schema change + four function updates + drop the
JS renderers.

### E. Sessions table rename + cycle_id on programs

Architectural cleanup — see #4 above.

### F. "Publish without emailing" picker button

**Symptom:** Sometimes an admin assigns an instructor mid-cycle who they
know will see the new camp via the portal anyway (e.g. they're already
logged in, or it's a small add-on the admin already verbally told them
about). Today the Hat tip still pesters with "Send the offer?" and admin
has to ignore it or manually SQL the row to published + email_sent_at.
**Fix:** Add a checkbox to the picker's confirm step: *"Publish without
emailing — they'll see it in their portal."* When checked, the assignment
flips straight to published + email_sent_at=now + system audit message
"Published without email." No actual email fires. Reminder cron still
picks them up if they don't respond.
**Scope:** ~30 min. Frontend change + a small handleAssignWithoutEmail
that mirrors handleSendPatchOffers without the function invoke.

### G. Enrollment sync from external tracker

**Symptom:** SU26 enrollment lives in a Google Sheet (parent registrations
on Squarespace). Schedule page reads
`camp_sessions.current_enrollment` — but nothing updates it automatically.
Today Claude runs the sync on demand by reading the sheet via MCP and
running an UPDATE. Works manually; was set up as a recurring routine
(Tue/Thu 8am Pacific) but the routine needs the user's MCP connectors
attached at claude.ai/customize/connectors.
**Fix path:** Once Jessica connects Google Sheets + Supabase MCPs, the
routine fires autonomously. Goes away entirely for FA26+ since Enrops
handles registrations natively → derive enrollment from
`COUNT(registrations)`.
**Scope:** ~10 min user-side MCP setup, then routine is set.

### H. Inbound email replies aren't captured

**Symptom:** When an instructor replies to an offer/reminder email
directly in their inbox (instead of clicking the portal Accept / Request
change buttons), the reply lands in Jessica's inbox but Enrops never
sees it. The assignment stays in `awaiting response` state forever.
Surfaced when Michele "replied" but nothing came through.
**Fix:** Inbound email handler on the reply-to address (e.g. an SES /
Resend Inbound webhook on `jessica@journeytosteam.com` or a dedicated
`replies@updates.journeytosteam.com`). Parse the email's headers for
the assignment-id (need to include one in outgoing emails first), pipe
the body into `instructor_offer_messages` with sender_role='instructor'
and a real sender_instructor_id.
**Scope:** ~1-2 sessions. Outbound emails need a hidden assignment-id
header; inbound handler is a new edge function + a Resend webhook
config. Worth doing before launch — non-tech instructors WILL keep
hitting Reply.

---

## 🎨 UI polish (low priority)

- Hide zero-count counters? (Jessica said keep them visible — track in
  case that changes.)
- Sticky filter bar when scrolling weekly grid.
- Mobile responsiveness of the calendar (today desktop-only).

---

## ⏱ Suggested order (next ~3 months)

Mapped to Jessica's July 31, 2026 launch date for Tenant #2:

1. **Now → mid-June:** Tenant-2 setup UIs in this order:
   - program_locations CRUD (#1, fastest payoff)
   - scheduling_cycles create (#2)
   - In-portal availability survey (#5, needed for FA26 anyway)

2. **Mid-June → mid-July:** Programs tab build (#3 + #4 combined)

3. **Mid-July → launch:** Instructors page (#6), polish (#A, #B, #D),
   inbound email replies (#H — important for non-tech instructors who
   hit Reply instead of using the portal), onboarding flow for new
   tenant (org setup wizard).

J2S FA26 cycle work (build scheduling_cycle row, link camp_sessions, run
match agent, etc.) happens ~July anyway and benefits from #1, #2, #5
landing first.

---

## Owner notes

- Hat-driven UX principle: every new page above should follow the
  Director + Hats pattern. One Hat character per page, plain English,
  Not-now option, max 5 on-deck cards.
- Tenant-2 onboarding must not require Claude/SQL. If a build can't
  pass that test, it's not done.
- Email templates: when you change copy in send-offers /
  send-patch-offer / offer-reminders-cron, also update the JS renderers
  in `EmailActivityModal` until #D ships.
