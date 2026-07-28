# Attendance + Dismissal Log ("Class Reports") — Spec

**Status:** Draft for Jessica — vision captured 2026-07-11. Not built. Successor feature to customizable-registration (depends on its release data).

---

## 1. The vision (Jessica's words, structured)

On the **instructor roster**, two columns next to each child:
1. **Attendance** — "Mark present" (check-in).
2. **Dismissal** — mark **who the child was released to** (pick from their authorized-pickup list), and the **system timestamps** that action.

That data becomes:
- An **admin report** to track kids and verify instructors follow safety guidelines at dismissal (the core value — this is a **safety/compliance** tool, not just a log).
- **Attached to each student** — searchable per-student (a student's attendance + dismissal history), tied to the unified student record.
- **Per term**, with current-term default and older terms archivable.

## 2. Why this is the natural next feature

customizable-registration already captured, per child: the **authorized-pickup list** (`student_contacts` role=`authorized_pickup`), **do-not-release** list, and **dismissal_method**. This feature **consumes** that:
- The dismissal picker's options = the child's authorized-pickup names (+ "walked/biked home" if that's their `dismissal_method`).
- Compliance checks fire against the **do-not-release** list.

So no rework of the current feature — it's the foundation. This also fills backlog **#27** (attendance + unified student record) and Arielle's "attendance keystone."

## 3. Data model (recommended)

**One row per (student, class-day)** capturing both check-in and dismissal — they're two moments of the same child-day, so one table keeps them together and makes "who was here and how did they leave" a single record.

```
attendance_records
  id uuid pk
  organization_id uuid not null
  registration_id uuid not null        -> registrations
  student_id uuid not null             -> students
  program_id uuid null / camp_session_id uuid null   -- exactly one (mirror registrations)
  session_date date not null
  -- check-in
  present boolean                       -- null=not marked, true=here, false=absent
  checked_in_at timestamptz
  checked_in_by uuid                    -> instructors
  -- dismissal
  dismissal_kind text                   -- released_to_adult | walked_or_biked | not_dismissed
  released_to_contact_id uuid null      -> student_contacts (who they were released to)
  released_to_name text                 -- snapshot (survives contact edits/deletes)
  released_at timestamptz
  released_by uuid                      -> instructors
  notes text
  created_at / updated_at
  UNIQUE (student_id, coalesce(program_id,camp_session_id), session_date)
```
- **Snapshot `released_to_name`** so the historical record survives if the contact is later edited/removed.
- Term is derived from the program/camp term or the `session_date` — drives per-term filtering + archive (archive = filter to older terms, never delete).
- Additive + empty; org-scoped; RLS (instructors write their own class's rows; admins read all; parents optionally see their own child's).

## 4. Instructor UI — two columns on the roster

Extend the roster rows (camp `RosterSection` + the new afterschool roster) for **today's class meeting** (or an instructor-selected class day):
- **Attendance column:** "Mark present" toggle → writes `present=true, checked_in_at=now, checked_in_by=me`.
- **Dismissal column:** a picker of the child's **authorized-pickup names** (+ "Walked/biked home" when that's their method) → on select, writes `released_to_*, released_at=now, released_by=me`.
- **Safety guards (the point):** warn/block if the picked person matches a **do-not-release** name; surface the do-not-release list inline; flag a child released to someone **not** on the authorized list (allow with a reason, but record it).
- Per-day: the roster is date-aware (defaults today). For multi-day camps + recurring afterschool, one record per meeting date.

## 5. Admin report — "Class Reports"

**Location (recommended):** a **"Class Reports"** surface. Jessica's instinct (a sub-nav under Programs) is reasonable; alternatively a top-level "Reports." Recommend **under Programs → Class Reports** to keep program-scoped things together, consistent with "Class rosters" living there.

Contents:
- **Per program → per term:** daily grid — who was present each day, who each child was released to + when + by which instructor.
- **Compliance highlights (lead with these):** children **not yet dismissed**, releases to a **non-authorized** person, **do-not-release violations**, **missing check-ins**. This is what makes it a safety tool.
- **Per-term selector**, current-term default; older terms accessible ("archive" = filter, not delete).
- **Export** (CSV/PDF) for records.

## 6. Per-student history — DEFERRED (pure front-end over existing data)

Decision (Jessica 2026-07-11): **do not spec or build the per-student view now.** Every table keys to `student_id`, so "search a student → see their attendance/dismissal/registration history" is a later **read layer** over data that already exists — not something to design up front.

**The one real data-layer caveat (NOT a view problem): student identity.** Today `create-registration` **inserts a fresh `students` row per registration**, so the same child across programs/terms is **multiple `students` rows**. So the data "is there" but scattered. What makes the eventual per-student view trivial-vs-hard is whether we adopt **one canonical record per child**. That's a data-dedup decision (same issue as the parent/family importer + backlog #27), separate from this feature. Attendance just needs to key to `student_id`; whatever identity we later land on, the FK holds. Park "canonical student identity + unified record" as its own future item — do NOT fold it into attendance.

## 7. Think-ahead / architecture notes

- **Per-term scoping + archive** via `session_date`/term — filter, never delete. Design the report term-selector from day one so it scales as terms accumulate.
- **Dismissal picker sources from `student_contacts`** (built) — clean dependency; no duplicate data entry.
- **Compliance is the value** — the report must flag violations, not just list events.
- **Automations (future):** alert admin if a child is still undismissed at end of day, or released to a non-authorized/ do-not-release person (ties to the alerts/automations engine).
- **Multi-tenant:** all org-scoped + RLS; no hardcoded tenant. Instructors write only their own class's records (mirror the roster RLS just built).
- **Sub vs. camp coverage:** a substitute instructor must be able to mark attendance/dismissal for the day they cover (RLS via `assignment_substitutions`, like the roster read).

## 8. What to fold in NOW vs. next chunks

**Fold in now:** nothing structural — customizable-registration's release data is the foundation and is built. Finish that feature's loose ends first (Chunk 3 editor repoint + Review-step display + CSV; deferred parent-portal edit/backfill), so it's left clean.

**This feature's chunks (its own build, after a spec sign-off):**
- **A — schema:** `attendance_records` + RLS + indexes (staging+prod parity).
- **B — instructor roster columns:** attendance check-in + dismissal picker + timestamps + do-not-release/authorized guards (per class day).
- **C — admin "Class Reports":** per program/term daily grid + compliance highlights + term archive + export.
- **~~D — per-student history~~ DEFERRED:** not part of this feature. It's the unified student record (#27), gated on the canonical-student-identity decision (§6). Pure front-end later; don't spec now.
- **E — alerts/automations (future):** undismissed / non-authorized-release alerts.

## 9. Recommended start point

This is a distinct, sizable feature — give it its own build. Recommended sequence:
1. Finish customizable-registration's remaining Chunk 3 loose ends (small).
2. Sign off this spec.
3. **Start the Attendance + Dismissal build in a fresh chat** (Chunk A schema first), since the current session is very long — fresh context + this spec is the clean handoff.
