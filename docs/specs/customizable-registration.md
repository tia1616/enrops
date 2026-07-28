# Customizable Registration — Spec

**Status:** Draft for Jessica's review — not built. Written 2026-07-10.
**Owner surfaces touched:** registration form, Settings, instructor portal, admin rosters, parent portal, importers.

---

## 1. Summary

Registration today is a **fully hardcoded 5-step form** (`Register.jsx` + `StepStudent`/`StepParent` + `CartContext.jsx`). It collects: child name/grade/birthdate/homeroom/allergies/medical + one emergency contact, and parent name/email/phone/address. That's it.

Jessica needs three things:

1. **New standard questions we're missing today** — second parent/guardian (name + email + phone, optional), who the child can be **released to** (up to 4 people, first + last, **mandatory**) OR permission to **walk/bike home alone**, and who the child must **NOT** be released to (optional).
2. **Provider-customizable questions** — a provider adds their own questions in Settings, marks each mandatory or optional (e.g. Jeff asking "does the child have music experience?").
3. **This info visible on rosters** — instructors and admins see it; phone numbers are click-to-call.
4. Parents can update this info anytime in the **parent portal** (Jessica flagged as possibly v2).

### The big discovery (verified against live prod 2026-07-10)

**The schema for this already exists and is completely dormant.** The previous build laid the bones and never wired them:

| Artifact | State on prod | Evidence |
|---|---|---|
| `custom_reg_fields` config table (org-scoped, typed, required/optional, `applies_to` all/program/enrollment_type, sort_order, help_text, is_active) | **exists, 0 rows** | verified |
| `registrations.custom_field_values jsonb` (answer bucket) | **exists, 0 of 467 regs populated** | verified |
| `registrations.post_program_plan` (CHECK: `picked_up_by_parent / walks_home / bus / aftercare / other`) | **exists, 0 of 467 populated** | verified |
| `registrations.aftercare_provider`, `authorized_pickup_contacts` (free text) | **exists, only 3 of 467 populated** (manual admin entries) | verified |

`custom_reg_fields` is referenced **only** in schema files — no frontend, no edge function reads or writes it. The roster components *read* `custom_field_values` / `authorized_pickup_contacts` / `post_program_plan` for display, but nothing ever *writes* them. **The plumbing is 60% there; it just needs to be connected and extended.** Staging has parity (same table + columns present).

This changes the build from "design a new subsystem" to "wire up + extend what's scaffolded, plus add the structured people-fields it's missing."

---

## 2. Goals / non-goals

**Goals**
- One **config-driven registration engine**: a provider controls which questions appear, their order, and mandatory/optional — for both the platform's standard questions and their own custom ones.
- Capture guardian #2, release-authorization, walk/bike-home, and do-not-release as **structured** data (not free text) so rosters render it cleanly and phones are click-to-call.
- Surface all of it on instructor + admin rosters, role-appropriately.
- A path to collect this from **already-registered families** (J2S has 467 regs missing it).
- Parents edit their own info in the portal (phasing per §14).

**Non-goals (explicitly out of scope here)**
- Photo-release rework — that's moving into the signed-waiver flow separately (backlog #13). This spec does not touch photo consent.
- Full payment/pricing changes.
- Attendance / per-student unified record (backlog #27) — related but separate.

---

## 3. Core architecture decision — one engine, two field kinds

A registration form = an ordered list of **fields**. Two kinds, one rendering engine (this mirrors the availability-survey-builder principle: *every question is custom; a few types are wired to structured behavior*):

- **Standard fields** — platform-defined field *types* with structured storage and special roster rendering (guardian, release-authorization, walk/bike-home, do-not-release, emergency contact, how-heard). The provider can **toggle each on/off and set mandatory/optional**, but can't delete the type. Seeded ON + mandatory for J2S; a chess/ukulele provider might turn pickup off.
- **Custom fields** — free-form provider questions via the existing `custom_reg_fields` table (text/textarea/select/multiselect/checkbox/number/date). Answers land in `custom_field_values` jsonb.

**Why not make everything a generic custom field?** Because release-to names, guardian phones, and do-not-release people need to render as structured rows on rosters, feed click-to-call, and (later) drive dismissal logic. A jsonb blob can't do that cleanly. So structured people-data gets real columns/tables; genuinely free-form questions get jsonb. Same builder UI over both.

### 3a. Where the data lives — the key fork (needs Jessica's call)

The new "people" fields (guardian #2, release-to, do-not-release) and walk/bike-home are conceptually about **the child**, not a single enrollment. Two options:

- **Option A (recommended): a `student_contacts` table keyed to the child.** Enter once → applies to every program the child is in → **one place to edit** (matches Jessica's "one place to edit" + "one field, one editable surface" rules). Walk/bike-home becomes a field on `students`. New guardian #2 also lives here (or a family-level guardian record).
- **Option B: per-registration columns** (reuse the existing `authorized_pickup_contacts` / `post_program_plan` on `registrations`). Allows a *different* pickup list per program, but the parent re-answers on every signup and edits N places.

Recommendation: **A.** Real J2S reality is that a child's release rules are a property of the child, not the class. Per-program override is a rare edge case we can add later. This also means the info is captured once and reused across a family's multiple registrations — less friction, honoring the 3-question spirit even though that rule targets operators.

> Note: this leaves the dormant `registrations.authorized_pickup_contacts` / `post_program_plan` columns as the *per-registration override* slot for later, or we retire them. Either way, additive — we don't drop them now (multi-tenant lesson D).

### 3b. Recommended contacts model (`student_contacts`)

One canonical "people associated with a child" primitive (think-forward-and-sideways: guardians, pickup-authorized, emergency, and do-not-release are all *people with a role*):

```
student_contacts
  id uuid pk
  student_id uuid not null  -> students.id
  organization_id uuid not null
  role text not null  CHECK in ('guardian','authorized_pickup','emergency','do_not_release')
  first_name text not null
  last_name text
  phone text
  email text
  relationship text          -- "grandmother", "neighbor", etc. (optional)
  sort_order int default 0    -- ordered set; position = priority (mirror contractor emergency-contacts pattern)
  notes text                  -- e.g. custody note on a do_not_release row
  created_at / updated_at
  RLS: org-scoped read for members; parent can read/write own child's rows; public insert only via create-registration (service role)
```

- Written atomically via a `replace_student_contacts(student_id, role, contacts[])` SECURITY-DEFINER RPC (mirror the proven `replace_emergency_contacts` pattern — client sends an ordered array, server assigns sort_order; whole-set replace, no per-row drift).
- `students` gains **`dismissal_method text`** CHECK (`released_to_authorized_adult / walks_or_bikes_home / bus / aftercare / other`) + `aftercare_provider text`. (Superset of the existing `post_program_plan` enum; reuse those value names where they match.)
- Existing `students.emergency_contact_name/phone` and `parents.emergency_contact_*` are **left in place**, read via fallback, and migrated into `student_contacts` as a separate verified backfill step later (additive-and-empty, lesson D). MVP can render both.

**Additive & empty:** ship the table empty, backfill nothing at first, read with a fallback to the old columns.

---

## 4. The new standard questions — definitions

| Question | Field type | Mandatory? | Storage | Notes |
|---|---|---|---|---|
| Second parent/guardian | name + email + phone | Optional | `student_contacts` role=`guardian` (or family-level guardian record — see §3a decision) | Primary guardian is still the `parents` account row |
| How does the child leave? | single-choice: *Released to an authorized adult* / *Walks or bikes home on their own* / (provider-enabled: bus / aftercare) | **Mandatory** | `students.dismissal_method` | Choosing "released to authorized adult" **requires ≥1 release contact** (conditional required) |
| Who can pick up / be released to | up to 4 people, first + last (phone optional) | **Mandatory when dismissal = released** | `student_contacts` role=`authorized_pickup` | Ordered; the primary + 2nd guardian can be auto-offered as quick-adds |
| Who must NOT be released to | people, first + last | Optional | `student_contacts` role=`do_not_release` | **Sensitive** (custody). Tighter visibility — see §11 |
| Emergency contact | name + phone (+ relationship) | provider choice (J2S: mandatory) | `student_contacts` role=`emergency` (MVP: keep existing columns too) | Already collected today as single columns |
| How did you hear | select | provider choice | `parent_org_relationships.how_heard` | Already exists; options become tenant-configurable (folds in the backlog "how heard hardcoded for J2S" item) |

**"walk or bike home"** — folded into one option ("Walks or bikes home on their own") rather than two, to keep the form scannable. The distinction rarely matters operationally; a custom field can capture it if a provider needs it.

Each standard field carries a per-tenant config row: `enabled`, `required`, `label override`, `sort_order`. Seed J2S with the mandatory ones ON.

---

## 5. Custom provider questions — reuse `custom_reg_fields`

The table already models everything needed:
- `field_key`, `label`, `field_type` (text/textarea/select/multiselect/checkbox/number/date), `options jsonb`, `is_required`, `applies_to` (all / enrollment_type / program) + `applies_to_value`, `sort_order`, `help_text`, `is_active`.
- **Jeff's "music experience?"** = a `select` or `textarea` custom field, `applies_to='all'` (or scoped to a specific program via `applies_to='program'`).
- Answers write to `registrations.custom_field_values` jsonb keyed by `field_key`, at registration time.

**Build:** wire it — an admin CRUD (§6), read it in the registration form (§7), write answers in `create-registration`, render answers on rosters (already read in roster code, just needs data).

---

## 6. Settings UI — "Registration questions" builder

New Settings section (`AdminSettings.jsx` is a flat list of section cards → add one after "Forms & waivers", both govern what families fill out). New page `/admin/registration-questions` (`RegistrationQuestions.jsx`). Model after `SurveySettings.jsx` (the closest existing config-driven question builder) + `WaiverManager.jsx` (CRUD pattern).

Layout:
- **Standard questions** section: each with an on/off toggle + a Mandatory/Optional switch + label override. Safety fields (release/dismissal) default ON; can't be deleted, only disabled.
- **Your custom questions** section: list + add/edit/reorder/delete over `custom_reg_fields`. Type picker, options editor (for select), required toggle, applies-to (all program / a specific program).
- Live **preview** of the resulting registration form (render true preview — matches Jessica's in-app-preview rule).
- Owner/Admin only (RBAC).
- **Time-saved / value framing** where appropriate (operator surface).

---

## 7. Registration form changes (`Register.jsx` + steps)

- The form becomes **config-driven**: on load, fetch this org's enabled standard fields + active `custom_reg_fields` (public read policy already exists on `custom_reg_fields`).
- New/expanded steps:
  - **Student step** — add the dismissal-method question + conditional release-to list (up to 4) + optional do-not-release.
  - **Parent/Guardian step** — add optional second guardian.
  - **Custom questions** — rendered from config (per-child and/or per-registration placement TBD; simplest = one "A few more questions" step, program-scoped questions grouped under their program).
- `CartContext.jsx` `emptyChild()`/`emptyCart()` extended to hold the new structured fields + a `customAnswers` map.
- Validation: mandatory + conditional-required (release list required iff dismissal=released).
- `create-registration/index.ts` extended to write `student_contacts` (via RPC), `students.dismissal_method`, and `custom_field_values`. Keep it service-role guest-checkout safe.
- **Copy rules:** no "cancel" language; no em dashes in any parent-facing copy; warm, lowercase "enrops"; plain language, no jargon.

**Friction guardrail:** these add fields to a conversion-sensitive form. Keep it scannable — progressive disclosure (release list only appears when "released to adult" is chosen), quick-add buttons to reuse the guardians as pickup people, clear "optional" labelling. The mandatory set is deliberately small (dismissal method + at least one release person, which most parents fill anyway).

---

## 8. Roster surfaces

All roster reads are **direct Supabase frontend queries** (no roster edge fn) against `registrations` → `students` → `parents`. Four queries to extend to also pull `student_contacts` + `dismissal_method` + `custom_field_values`:

1. Instructor camp roster — `InstructorPortal.jsx` `RosterSection` (~:3035)
2. Admin per-program roster — `ProgramRoster.jsx` (~:114)
3. Admin roster editor (camps + programs) — `Rosters.jsx` `RosterEditor` (~:562)
4. Parent dashboard — `Dashboard.jsx` (~:200)

Render, per child:
- **Dismissal method** badge ("Walks/bikes home" or "Pickup only").
- **Released to** list (names, phone click-to-call).
- **Do NOT release to** — visually distinct warning treatment; role-gated (§11).
- **Guardians** (primary + secondary) with click-to-call.
- **Custom answers** (label: value).

### 8a. Click-to-call
The `tel:` pattern already exists in the instructor portal (`LocationSection` ~:2676 and co-instructor ~:1780, `phone.replace(/[^0-9+]/g,'')`). Today parent/emergency phones render as **plain text** in `CamperRow` (~:3166) and admin `StudentCard`. Wrap all guardian/emergency/pickup phones in `tel:` links across instructor + admin rosters.

### 8b. Afterschool instructor-roster gap ⚠️
The instructor portal renders rosters for **camps only** — `AfterschoolAssignmentCard` never calls `RosterSection`. **Afterschool daily dismissal is exactly where release/pickup info matters most**, and afterschool instructors currently have no roster at all. Surfacing release info to afterschool instructors requires **building the afterschool instructor roster view** — a real companion piece, potentially its own chunk. Flagged as a scope decision (§14).

---

## 9. Collect from already-registered families (J2S's 467 regs)

Jessica: *"which I'll have to ask all parents who've already signed up to answer."* This is a real v1-adjacent workstream, not just the registration form:

- A **parent-facing "complete your child's info" form** (the parent-portal edit surface, pulled forward) that shows the missing mandatory fields and writes `student_contacts` + `dismissal_method`.
- A **"request missing info" send** to families who haven't completed it (reuse the invite/comms rails; branded per tenant; no "cancel" language; respects suppressions).
- An **admin view of who's complete vs. outstanding** (so Jessica can chase stragglers).

This overlaps the parent-portal edit (§10) — the same form serves both "new parent updates info" and "existing parent fills the gap."

---

## 10. Parent portal self-edit

Parent portal exists (`Dashboard.jsx`, `/:slug/dashboard`, auth-gated by `parents.auth_id`). Its Settings tab today only edits email prefs. Add a **"My family" / child-info editor**:
- Edit guardians, release-to list, do-not-release, dismissal method (writes via the same `replace_student_contacts` RPC + `students` update, under RLS `parents_see_self` / a new parent-write policy scoped to their own children).
- This is the surface the §9 backfill reuses.

Note the parent portal is **hardcoded-J2S in presentation** (backlog #26, prelaunch-critical). If we add parent-edit here for other tenants, it rides the portal de-hardcode. For J2S-only near-term it's fine.

---

## 11. Multi-tenant, RLS, PII, RBAC

- **Everything org-scoped.** `custom_reg_fields` already has `organization_id` + RLS. `student_contacts` gets `organization_id` + org-member read + parent-own-child write + service-role insert path. No hardcoded tenant slug/UUID anywhere.
- **Standard questions are tenant-configurable, not hardcoded** — follows no-hardcoded-config + multi-tenant lesson B (don't bake J2S's requirements into the platform). Seed J2S ON; each provider chooses.
- **`do_not_release` is sensitive** (custody / safety). Visibility: instructors + admins yes (they enforce it at the door); consider hiding from Viewer role. Never in CSV exports that leave the building unless intended. Flag for the RBAC PII pass.
- **Money/PII layering:** unrelated to money cols, but respect the existing role gates on rosters.
- **Import safety:** deterministic parse, review-before-write, merge-not-overwrite (parent-family-import lessons).

---

## 12. Import path (fold-in)

New fields must be importable — a provider onboarding with an existing family book, and roster CSV uploads:
- **Parent/family import Phase 2** (`docs/handoffs/2026-06-08-parent-family-import-spec.md` §7) writes operational `parents`+`students`; extend its column-mapping to accept guardian #2 / release-to / dismissal columns → `student_contacts`.
- **Roster CSV import** (`admin-import-camp-roster` / `admin-import-program-roster`, `FIELD_DEFS` aliases in `Rosters.jsx`) — add aliases for the new fields.
- **CSV export** (roster export columns) — add the new fields (respecting do-not-release sensitivity).

---

## 13. Does this follow our rules?

- **One place to edit / one field one surface** ✅ — recommended child-level model = enter once, reused; single editable surface per field.
- **No hardcoded config** ✅ — standard questions are tenant-configurable; how-heard options become per-tenant (fixes an existing hardcoded-J2S backlog item).
- **Build right first time / think forward + sideways** ✅ — one `student_contacts` primitive for all "people," reused by guardians/pickup/emergency/do-not-release instead of four ad-hoc spots.
- **Additive-and-empty + parity** ✅ — new table/columns ship empty to staging **and** prod same pass; old emergency columns left intact with fallback read; backfill is a separate verified step.
- **Multi-tenant safe** ✅ — org-scoped + RLS, no tenant literals.
- **In-app true preview** ✅ — builder shows the real form.
- **Parent-copy rules** ✅ — no "cancel", no em dashes, warm, plain language.
- **3-question / low friction** — partial tension: we're *adding* mandatory fields to a parent form. Mitigated by keeping the mandatory set minimal + progressive disclosure. (The 3-question rule targets operator tasks, not safety-required parent data, so not a hard violation.)
- **Time-saved pill** ✅ — on the Settings builder (operator surface).
- **Staging-first, prod on Jessica's go, verify deploy** ✅ — standard pipeline.

---

## 14. Decisions (resolved by Jessica 2026-07-10)

1. **Data model home — DECIDED: child-level `student_contacts`.** Enter once, reused across every program the child is in; one place to edit. Per-program override deferred. §3a.
2. **Existing-families backfill — DECIDED: fast-follow, not v1, and only FALL (FA26) families.** Don't build the backfill flow in the main build. After the build ships, figure out the lightest mechanism — most likely just email fall families asking them to complete the missing info in the parent portal. So the parent-portal edit surface (§10) must exist for this to land, but the "request-info send + completion dashboard" (§9) is deferred and scoped to fall families only, not all 467. §9.
3. **Afterschool instructor roster — DECIDED: build it.** Afterschool instructors currently have NO roster view at all (verified: `AfterschoolAssignmentCard` shows class/time/location/co-instructors/dates only — zero student list). This is an unfinished half of the afterschool portal, not just a missing field. Reuse `RosterSection` with a `program_id`-keyed `registrations` query. Own chunk (§8b / Chunk 4). §8b.
4. **Standard questions tenant-configurable, seeded ON+mandatory for J2S** — confirmed (follows no-hardcoded-config).

---

## 15. Suggested phasing (per-chunk, each gets tests + guardrails + /code-review + self-test)

- **Chunk 0 — schema** (additive, staging+prod parity): `student_contacts` table + RLS + `replace_student_contacts` RPC; `students.dismissal_method`/`aftercare_provider`; per-tenant standard-field config; seed J2S.
- **Chunk 1 — Settings builder** (`/admin/registration-questions`): standard toggles + custom-field CRUD + live preview.
- **Chunk 2 — registration form**: config-driven render + new standard fields + custom fields; extend `create-registration`; validation.
- **Chunk 3 — rosters**: extend the 4 queries + render + click-to-call; do-not-release warning treatment + role gating. INHERITED FROM CHUNK-0 REVIEW: (a) `student_contacts` RLS already gates `do_not_release` reads to org EDITORS (owner/admin/staff) — Viewers excluded; decide instructor-facing visibility here (instructors enforce it at the door) and confirm whether Staff should see custody data; (b) the admin roster editor's UPDATE path must set `updated_at = now()` explicitly (no DB trigger, per codebase convention); (c) do a real-JWT RBAC runtime test with staging Staff/Viewer accounts (Chunk-0 verified predicates structurally, not via live roles).
- **Chunk 4 — afterschool instructor roster** (in scope, §14.2/§8b). Reuse `RosterSection` with a `program_id`-keyed `registrations` query.
- **Chunk 5 — parent portal edit** (§10) — needed so fall families can self-complete. The "request-info send + completion tracking" (§9) is a deferred fast-follow scoped to fall families, decided after this ships.
- **Chunk 6 — importers** (§12).

---

## 16b. Live registration-page safety (MONEY PATH — added after guardrail audit 2026-07-10)

J2S's `/j2s/register` is **live and is the checkout/payment path.** Any regression breaks real signups and payments. Binding rules for this build:

1. **The live form must not visibly change until we choose.** Seed J2S standard fields **disabled**. The config-driven form (Chunk 2) reads config, but with nothing enabled the page renders **identical to today**. Flip the enable toggles to reveal the new questions **only after** schema → settings → form-write → rosters are all built and verified end-to-end. Reveal is a deliberate, separate, reversible step.
2. **New writes go in `create-registration`, before Stripe.** Confirmed order: `Register.jsx` calls `create-registration` THEN `create-checkout`. So `student_contacts` / `dismissal_method` / `custom_field_values` writes happen pre-payment — a failed mandatory-safety write fails the registration with **no charge**, never stranding a paid registration with missing pickup data. Enforce mandatory client-side AND at `create-registration`. Do **not** move these writes after checkout.
3. **Roster read + write must move together (consistency).** Chosen model is child-level `student_contacts`, but today the admin roster editor (`Rosters.jsx` `CamperEditForm`) WRITES `registrations.authorized_pickup_contacts` and roster views READ it. Chunk 3 must repoint BOTH the four roster reads AND that editor's write to `student_contacts` in the same chunk — else admins edit one place and parents/instructors read another (split-brain). The old free-text column is kept (fallback read) but is no longer the write target.
4. **Backward-compat proven empirically (lesson C, static-green≠working).** On staging: (a) a real end-to-end Stripe test registration with standard fields OFF must behave identically to today + SELECT the row back; (b) a second with fields ON must land `student_contacts` + `custom_field_values` and render on the roster. Test registration must equal a real registration.
5. **CartContext changes are purely additive.** `emptyChild()`/`emptyCart()` gain new keys with safe defaults; never change existing keys/shape that `StepReview`/`StepPay`/`create-registration` depend on.
6. **Isolation + verify.** Build in a git worktree off `origin/main` (local main is stale; concurrent-session hazard). Render-verify the live page with PWA cache cleared before "done."

## 16c. RLS finding (from live-DB audit 2026-07-10)

`custom_reg_fields` policy `public_read_custom_fields` = `USING (is_active = true)` for role `public` — **no org filter**, so an anonymous reader can enumerate every org's active registration-question definitions (labels only, not answers). Low severity (labels aren't secret) but a cross-tenant metadata leak, same class as the world-readable `organizations` incident (backlog #23). **Chunk 0:** either scope public read so it can't be blind-enumerated across orgs, or consciously accept label-exposure and document why. Answers (`custom_field_values`) are on `registrations` and gated by that table's RLS — not publicly exposed. Any new `student_contacts` public/parent policies must be org-scoped from the start.

## 16. Pressure-test notes

- **Underspecified:** per-child vs per-registration (decision 1); whether guardian #2 is family-level or a `student_contacts` guardian row (recommend student_contacts for MVP, revisit if a family-account model is wanted).
- **Consistency:** reuses `post_program_plan` value names; doesn't collide with photo-release rework (#13) — explicitly out of scope.
- **Security/tenant:** org-scoped + RLS, no literals; do-not-release PII gating called out.
- **Empty/error states:** form with zero configured questions must still work (degrade to base fields); roster with no contacts shows nothing, not an error.
- **Schema gate:** verified live — columns/table present on prod + staging, dormant (0 rows); `post_program_plan` CHECK confirmed.
- **Real artifact:** file paths from live code (agents), schema from live DB (not just baseline file).
- **Irreversible:** none in schema (all additive); no deletes of existing emergency columns.
