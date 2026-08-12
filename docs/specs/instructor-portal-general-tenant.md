# Instructor portal for a GENERAL tenant — scope

Raised by Jessica 2026-08-11: Jeff (The Ukulele Project) wants to onboard his teachers
through Enrops, have them use the instructor portal to see and accept jobs, and run
scheduling / subbing / offers the way J2S does for after-school.

**Everything below was verified against the live PROD database and current `origin/staging`
code on 2026-08-11.** Nothing here is recalled. Where I have NOT verified something, it says
so explicitly.

---

## 0. The one sentence that should shape the whole build

Registration needed ~15 unglamorous fit-and-finish passes before Jeff was satisfied, and
registration was a surface that **already had a second tenant using it**. The instructor
portal has **never rendered for anyone but J2S**. Expect more fit-and-finish, not less.

---

## 1. What already works — do NOT rebuild these

Verified on prod, 2026-08-11.

### The data layer is already multi-tenant
Every instructor-side table has `organization_id`, `rowsecurity = true`, and at least one
policy:

| table | policies | rows (prod) |
|---|---|---|
| `instructors` | 3 | 24 |
| `program_assignments` | 3 | 23 |
| `camp_assignments` | 3 | 61 |
| `assignment_substitutions` | 4 | 0 |
| `contractor_onboarding_status` | 4 | 24 |
| `contractor_agreements` | 4 | 22 |
| `contractor_acknowledgments` | 4 | 132 |
| `legal_documents` | 2 | 7 |
| `instructor_term_availability` | 3 | 13 |
| `instructor_offer_messages` | 4 | 158 |
| `attendance_records` | 5 | 655 |
| `tenant_pay_rates` | 1 | 8 |
| `instructor_training_videos` | 3 | **0** |
| `instructor_training_completions` | 2 | **0** |
| `org_policy_acknowledgements` | 2 | **0** |

So this is **not** a data-model build. It is a config, routing, nav and authoring build.

### The portal itself is rich already
`src/pages/portal/InstructorPortal.jsx` is ~4,500 lines and already does: magic-link
sign-in, camp assignments, **after-school assignments**, accept / request-change, sub
offers with accept + decline, availability survey banners (camp cycle AND after-school
term), daily check-in, attendance + dismissal recording, roster with parent contacts,
lesson + curriculum documents, a pay view, and a documents drawer.

### After-school offers and subbing already exist
`send-afterschool-offers`, `send-afterschool-survey`, `AssignSubModal.jsx`,
`create-assignment-substitution`, `respond-to-assignment`, `respond-to-sub-offer`.
`AfterschoolSchedule.jsx` is the board, with realtime on `program_assignments`.

### Payroll-as-calculator is ALREADY the default
`Payroll.jsx:125` — `canStripePayout = payRoute?.instructor_pay_model === 'legacy_own_platform'`.
Jeff is `enrops_platform`, so he already gets **"Mark paid manually" and no Stripe button**.
Her ask here is **already the behavior**. This needs *verifying at runtime*, not building.
`PayRoutesCard` already explains the three routes and calls option 1 "manual / calculator".

> **What is NOT proven:** whether the calculator produces correct numbers for a
> `weekly_term` after-school org with no camps. `v_effective_pay_lines` and
> `tenant_pay_rates` (`role`, `session_type`, `amount_cents`) have only ever been
> exercised by J2S. Treat correctness as unverified.

---

## 2. What actually blocks Jeff — the real work

### 2.1 Lean nav has NO instructor surfaces at all — BLOCKER
`AdminLayout.jsx:143 shapeNavForOrg` — for `instructor_pay_model === 'enrops_platform'`,
`HIDE_TOP` contains `/admin/schedule`. That hides the entire **Instructors** section
(Schedule / Instructor Roster / Availability). It also:
- drops `/admin/class-reports` from the Programs tabs (`:184`) — **her explicit ask**;
- drops the whole Money tab strip including `/admin/payouts` (`:195-204`).

> **CORRECTION (2026-08-11).** An earlier draft of this spec said these routes are
> "route-guarded, unreachable by URL." **That is wrong.** The guard at `AdminLayout.jsx:516`
> only blocks items that have a **`gate`** (a ROLE permission) the user's role fails.
> `shapeNavForOrg` *removes* `/admin/schedule` from `navItems` entirely, and a removed item
> can never match that `find()`. So for a lean org these surfaces are **hidden but still
> reachable by typing the URL.**
>
> Two consequences, one bad and one useful:
> - *Bad:* a lean operator with a stale bookmark can already land on them today.
> - **Useful: this is how to test the zero-row question before changing any nav.** Open
>   `/admin/schedule` as Jeff's org right now and see what a camps-first cockpit does with
>   zero camps. That de-risks chunk 2 without shipping anything.

> The comment at `AdminLayout.jsx:141` justifies this as *"Empirically safe: every
> enrops_platform tenant on prod has zero instructors and zero programs."* **Jeff is the
> tenant that breaks that premise.** He has 21 programs today and is about to have
> teachers. That comment must be rewritten, not just worked around.

### 2.2 The portal route is hardcoded to J2S — BLOCKER
`App.jsx:205` `<Route path="/j2s/instructor" …>`, and `:215-216` redirect the bare
`/instructor` and `/instructors` to `/j2s/instructor`. The generic `/:slug/instructor`
exists at `:209`, so the fix is small — but the bare shortcuts are the ones people type on
a phone, and today they land Jeff's teachers on **J2S's portal**.

### 2.3 Onboarding is a hardcoded Oregon + J2S compliance flow — the biggest piece
This is **not** a de-fork like registration. It is one company's legal process written into
frontend code.

| Where | What is hardcoded |
|---|---|
| `lib/onboardingSteps.js:20` | `STEP_ORDER` — fixed 9-step array |
| `lib/onboardingSteps.js:52` | only `bgcEnabled` + `trainingEnabled` are configurable |
| `lib/onboardingSteps.js:72` | `CONTRACTOR_AGREEMENT_VERSION = 'v2.0_2026-06-15'` — **J2S's document version string, in code** |
| `screens/Screen3ORS.jsx` | Oregon Revised Statutes **670.600** contractor test |
| `screens/Screen4Agreement.jsx:27` | checkbox text: *"…independent contractor under ORS 670.600"* |
| `screens/Screen5Policies.jsx:17` | names `code_of_conduct` |
| `screens/Screen6Additional.jsx:21-23` | names `mandatory_reporter_ack`, `photo_video_release`, `vehicle_driving_ack` |
| `InstructorPortal.jsx:2409` | `DRAWER_DOCS` — hardcoded 3-item list |

**There is no state / region column on `organizations`** (checked: only `mailing_address`
free text and `stripe_country`), so the Oregon step has nothing to branch on today.

### 2.4 Nothing can edit `legal_documents` — her explicit ask, and it does not exist
Grepped all of `src`: the table is only ever **read** (via the `get-legal-document` edge
function, because RLS hides it from instructor JWTs). **No admin screen writes it.** J2S's
7 rows were seeded by migration. Keys today:
`attendance_policy`, `code_of_conduct`, `contractor_agreement`, `mandatory_reporter_ack`,
`pay_schedule`, `photo_video_release`, `vehicle_driving_ack`.

So "a way for him to edit what docs instructors sign" is a **from-scratch authoring
surface** — plus versioning (the table already has `document_version`, `effective_from`,
`replaced_by`, and `contractor_agreements` snapshots the signed text).

### 2.5 True zero-state
Prod, verified:

| org | plan | pay model | instructors | legal docs | programs | camps |
|---|---|---|---|---|---|---|
| **the-ukulele-project (Jeff)** | founding | enrops_platform | **0** | **0** | 21 | 0 |
| j2s | free | legacy_own_platform | 24 (13 active) | 7 | 91 | 51 |
| every other org | — | enrops_platform | 0 | 0 | 0 | 0 |

Every instructor screen in the product has only ever rendered against J2S's data.

### 2.6 No previews anywhere — her explicit ask
`SurveySettings.jsx` contains **zero** matches for "preview". There is no portal preview and
no arrival/dismissal roster preview. This is the same class as the hand-drawn registration
preview she already made me replace: the norm is either the builder IS the artifact, or
Preview opens the REAL one.

### 2.7 The people-noun — CLOSED, out of scope
Jeff says "teachers", but Jessica ruled on 2026-08-11: **"instructors" everywhere, do not
get distracted.** No `staff_noun` config field. Do not raise this again in this build.
(It stays on the nonstandard-UI debt register as a deferred item, nothing more.)

---

## 3. Warnings to myself — where I am most likely to get this wrong

1. **Do not "just unhide" the nav.** `shapeNavForOrg` hides `/admin/schedule` for a
   *reason* — Schedule is a camps-first board. Showing it to a `weekly_term` org with 0
   camps may render an empty or broken cockpit. **Test what each surface does with zero
   rows before exposing it.** Static green ≠ working.

2. **`instructor_pay_model` is doing three jobs.** `entitlements.js` says it should mean
   NAV SHAPE only, but `Payroll.jsx` reads it as PAY RAIL and `AdminLayout` reads it as
   TIER. Giving Jeff instructors means touching a column with three meanings. Do not add a
   fourth. If a new axis is needed, add a new column.

3. **Never branch on `slug === 'the-ukulele-project'`.** Every gap here must resolve to a
   config value on `organizations` or a per-org row. J2S must not diverge either — same
   feature everywhere, J2S-specific behavior becomes hidden CONFIG.

4. **Do not delete the Oregon step — make it optional.** J2S depends on it and has 24
   instructors through it. Removing it to generalize would break the only tenant using it.

5. **`legal_documents` edits are a MONEY and LEGAL surface.** 22 `contractor_agreements`
   snapshot signed text. An editor that mutates a document in place would retroactively
   change what 24 people already signed. **Edits must create a new version, never update a
   signed one.** Verify the FK/`replaced_by` semantics before writing anything.

6. **The doc body is authored HTML/text rendered to instructors.** Same stored-XSS class as
   the confirmation page blocker in the 8/11 review. **Sanitize at RENDER, not only in the
   admin browser.**

7. **`'afterschool'` is a DATA VALUE, not just copy** (`InstructorPortal.jsx` has 25 hits).
   A copy sweep here would break comparisons. Label side only — and better done AFTER this
   lands, not during.

8. **Attendance "today" is UTC, not tenant-local** (open backlog item). Arrival/dismissal
   is exactly the surface that bug bites. Check before shipping class reports to Jeff.

9. **Do not report the payroll calculator as working because the button is absent.** Prove
   a real pay line computes for a `weekly_term` after-school program.

10. **I have not yet looked at how comparable platforms do instructor onboarding.** The
    rule is go and look BEFORE designing, and I have not. Do that before proposing the
    onboarding UX — do not design it from what I already believe.

11. ~~Jeff's teachers may not be contractors~~ — **RESOLVED 2026-08-11: they are 1099
    contractors, same as J2S.** The wizard shape applies. New risk in its place: because
    the reuse is large, it is tempting to declare the wizard "already works for him." It
    has never run for an org with **zero** legal documents. The wizard reads
    `legal_documents` by key; Jeff has none, so **every document step will fail or render
    empty until the authoring surface exists and he has written them.** The doc editor is
    therefore a HARD PREREQUISITE of onboarding, not a parallel nice-to-have.

12. **Two navs render different components for the same action.** Anything built here must
    work in BOTH nav shapes, or it silently exists for only one of them.

---

## 4. Backlog items worth folding in

From `BACKLOG.md`, re-verified as still open:

- **Sub availability + multi-offer** (parked worktree `enrops-subs-wt`) — (a) the sub picker
  at `AssignSubModal.jsx:68` lists *everyone* with no availability check or conflict flag;
  (b) offer one slot to MULTIPLE candidates, first-come-first-serve. Directly in scope for
  "subbing like after-school".
- **Instructor email visibility in Comms** — 5 instructor emails missing from the Comms
  catalog, and the instructor timeline *synthesizes* from `email_sent_at` columns instead of
  reading `instructor_offer_messages`. **This overlaps the "email instructors from Comms"
  ask from earlier today.**
- **Survey non-responder phones** — surface phone + copy-all so stragglers can be called.
- **Survey import gap** — date unavailability still has no structured field.
- **UTC date guards** — see warning 8.
- **After-school patch-offer wiring** — a deployed-but-dark edge function; decide wire vs
  remove (she disliked the word "patch").
- **Training is entirely dark** — `instructor_training_videos` and
  `instructor_training_completions` are both **0 rows on prod**. Decide before exposing it.
- **`org_policy_acknowledgements` is 0 rows** — a second, unused acknowledgment mechanism
  alongside `contractor_acknowledgments` (132 rows). Resolve which one is real before
  building the doc editor on top of the wrong one.

---

## 5. Decisions — ANSWERED by Jessica 2026-08-11

1. **Jeff's teachers are 1099 independent contractors, same as J2S.** So the existing
   wizard shape applies: agreement, W-9, policies, acknowledgments. This is the *large
   reuse* answer — warning 11 is retired.
2. **Jeff IS in Oregon**, so the ORS 670.600 step is reusable as-is and is NOT a blocker.
   **Her explicit instruction: note that a STATE step must be built for future tenants.**
   See §5a — this is now a recorded debt item, not part of this build.
3. **Blank editor + generic starter templates.** He gets an empty document list plus a few
   neutral, tenant-agnostic starting drafts (agreement, code of conduct, photo release) he
   can rewrite. **Explicitly NOT copying J2S's documents** — they are Oregon-specific and
   name Journey to STEAM.
4. **People-noun ("teachers" vs "instructors") is OUT OF SCOPE.** Jessica, verbatim:
   *"just have instructors everywhere. don't get distracted by things that don't matter."*
   Use **instructors** as the platform word throughout. Do not raise this again in this
   build; do not add a `staff_noun` config field.

Still unanswered, but NOT blocking — can be defaulted and revisited:
- **Background checks** — `organizations.background_check_config` already toggles this per
  org. Default it OFF for Jeff until he says otherwise; turning it on is a one-row update.

### 5a. Recorded debt — a STATE step for future tenants
There is **no state / region column on `organizations`** (verified: only `mailing_address`
free text and `stripe_country`). The ORS 670.600 contractor-status step is Oregon statute
and is currently unconditional for every tenant.

Jeff is in Oregon so this does not bite now. **The first non-Oregon tenant who onboards a
contractor will be shown another state's law and asked to certify under it.** The fix is a
state value on the org plus a per-state (or opt-out) contractor-status step. Raised and
deferred by Jessica 2026-08-11. Do not delete the Oregon step — J2S has 24 instructors
through it.

---

## 6. Norms from comparable platforms — RESEARCHED 2026-08-11

Warning 10 discharged. I went and looked rather than designing from belief.

**Confirmed norms we should adopt:**

1. **Open shift + claim, first-come-first-served, with an optional approval mode.**
   Deputy publishes an open shift, notifies *recommended* team members, and lets them claim
   it "on either a first come first served basis or with manager approval depending on what
   the manager has set." Homebase does the same. Deputy also has **shift offers** — invite
   *selected* people to claim one slot.
   → This is **exactly** the parked `enrops-subs-wt` backlog item (A: rank available-first;
   B: offer one slot to multiple candidates, first-come-first-serve). It is the market
   norm, not an invention. Build it as the norm and adopt the vocabulary. Deputy's
   "recommended team members" also validates item A: targeting should be
   **availability-aware**, not a flat list of everyone — which is precisely what
   `AssignSubModal.jsx:68` does wrong today.

2. **The staff portal is a first-class product surface**, not an afterthought — Jackrabbit's
   is "a single place to access everything they need," mobile-first. Ours already is.

3. **Onboarding paperwork lives IN the platform, consolidated.** CampMinder keeps
   "applications, tax info, contracts, and payroll… in one secure place," with background
   checks and reference requests attached. Our documents drawer + `contractor_agreements`
   already matches this shape.

4. **E-signature is native, not a third-party bolt-on.** Sawyer signs agreements and
   releases inside the platform "with no third party apps needed." We already do this for
   contractors — do not reach for DocuSign.

**What I did NOT find:** no comparable platform advertises a "preview what your staff see"
feature. So the preview ask is a genuine differentiator rather than a norm to copy — which
means the design should follow the rule she already set on the registration preview:
**never hand-draw an approximation; open the REAL thing** (Google Forms' eye icon,
SurveyMonkey test mode).

### 6a. The portal preview ALREADY EXISTS — verified in code
`InstructorPortal.jsx:121, 168-193, 1063-1228`. An admin can open
`/<slug>/instructor?as=<instructor-email>` and see that instructor's **real** portal behind
an "Admin preview" banner. It is genuinely wired: accept / request-change fire with
`acting_instructor_id`.

Three gaps, and they are the actual work:
- **It needs an existing instructor to impersonate. Jeff has zero.** There is nobody to
  preview as, so the feature is unreachable for exactly the operator who needs it.
- **Nothing in admin links to it.** It is a URL you have to already know.
- **It WRITES REAL DATA** — the banner says *"saving will write to <email>'s availability."*
  That is impersonation, not preview. A true preview must be read-only or sandboxed.

So "preview of what the portal looks like" is not a from-scratch build: it is
**zero-state + an entry point + a safe read-only mode** on a mechanism that already works.

---

## 7. Proposed sequencing

Each chunk is independently shippable and independently useful. Order is chosen so the
thing that **fails safe** goes first and nothing is exposed before it can render.

**Chunk 1 — Document authoring (HARD PREREQUISITE).**
Admin surface to create/edit/version `legal_documents`, seeded with generic tenant-agnostic
starter drafts. Nothing else in onboarding can work until Jeff has documents; he has zero.
Must-haves: new version on edit (never mutate a signed doc), sanitize at render, and RLS
proven for a non-J2S org.

**Chunk 2 — Reach: nav + routes.**
Un-hide the Instructors section, Class Reports and the payroll view for lean orgs, and fix
`/instructor` + `/instructors` so they resolve per-tenant instead of redirecting to J2S.
Gated on each surface being proven to render with **zero rows** first.

**Chunk 3 — Onboard one real instructor end to end.**
Invite → wizard → documents signed → appears on the roster. Oregon step reused as-is.
Background check defaulted off. This is the first true runtime test of the whole flow for a
non-J2S org.

**Chunk 4 — Scheduling, offers, subbing.**
Expose the after-school board for Jeff, then fold in the parked availability-aware sub
picker and multi-candidate first-come-first-serve offers (§6 norm 1).

**Chunk 5 — Previews.**
Portal preview entry point + safe read-only mode + a zero-state sample instructor (§6a),
plus a preview for the availability survey in Settings.

**Chunk 6 — Class reports + payroll verification.**
Prove arrival/dismissal reporting renders for a `weekly_term` org, and prove a real pay line
computes correctly. Includes the UTC-vs-tenant-local "today" fix, which bites this surface.

---

## 7a. Follow-up decisions — Jessica, 2026-08-11 (second pass)

### A. Background check external link — ALREADY SOLVED, verified in code
`screens/Screen2BackgroundCheck.jsx`. Her guess ("they have to leave onboarding") is half
right: they leave the *page*, never the *wizard*.
- The provider link is `target="_blank"` — **new tab**, wizard stays open behind it.
- Copy already reads: *"You can continue with the rest of your onboarding now — your
  background check will be reviewed in parallel."*
- Continue marks `checkr_submitted` so the wizard stops landing them there.
- The completion gate still holds them at `pending_background_check` until an admin marks
  it clear. So skipping it cannot smuggle anyone onto a roster.
- Provider name / URL / instructions already come from
  `organizations.background_check_config` — **already provider-neutral config**, never
  Checkr-specific.

**So the structure is already right. Two real defects to fix, though:**
1. **The link disappears forever after Continue.** The `alreadySubmitted` branch (L75-93)
   renders status + Continue and **no provider link**. Nothing prevents an instructor
   clicking Continue without ever opening the check — and then they can never find the link
   again inside the wizard. Fix: keep the link on the return visit ("Haven't finished yet?").
2. **"Background check submitted ✓" is shown whether or not they ever clicked it.** Honest-
   state violation. Distinguish "not started" from "submitted".

### B. Jeff is FOUNDING and gets everything — this changes the nav fix for the better
`entitlements.js` **already** resolves `platform_plan='founding'` to full access. But
`AdminLayout.shapeNavForOrg` ignores entitlements entirely and branches on
`instructor_pay_model`. **That mismatch is the actual bug.**

So chunk 2 is NOT "unhide instructor surfaces for Jeff." It is: **make nav shape read the
entitlement system that already exists and already knows he is founding.** This also
retires warning 2 — no fourth meaning gets bolted onto `instructor_pay_model`; the axis
that should drive it already exists and is already correct.

### B2. What Jeff gets — the five surfaces, and the coupling nobody had flagged
Asked by Jessica 2026-08-11: *"he'll have access to instructor onboarding, availability
survey, instructor comms, instructor portal, and instructor scheduling right?"* Yes — but
they are not gated the same way, and one needs an extra change:

| Surface | Gated by | Comes with |
|---|---|---|
| Instructor onboarding | **Not nav-gated at all.** `/:slug/onboarding` + the portal-embedded wizard. Blocked by having **zero documents**, not by access. | chunk 1 + 3 |
| Availability survey | Admin half (`/admin/availability`) is a TAB of the hidden Instructors item; the send fires from the Schedule board. *(`/admin/survey-settings` is already reachable — it is in Settings' `match` list.)* | chunk 2 + 4 |
| **Instructor comms** | **`commsAudiencesFor()` — a SECOND, INDEPENDENT gate.** See below. | chunk 2 (must be same change) |
| Instructor portal | The `/j2s/instructor` hardcode. Portal itself is not nav-gated. | chunk 2 |
| Instructor scheduling | `/admin/schedule`. **Good news:** `AfterschoolSchedule` is a *mode inside* `Schedule.jsx` (`:1103`), so no new route is needed. **Risk:** the page is camps-first and Jeff has zero camps. | chunk 2 + 4 |

**The coupling: fixing nav shape alone does NOT give him instructor Comms.**
`entitlements.js commsAudiencesFor()` hides the instructors audience for **every lean org,
paid or not** — deliberately. Its stated reason: two instructor automations say *"send from
your Schedule tab"*, and lean nav hid that tab, so the pills would point at a surface he
cannot open. It calls this *"a truth constraint, not a pricing one."*

The moment chunk 2 gives him the Schedule tab, **that reason evaporates** — and if
`commsAudiencesFor` is not updated in the SAME change, he ends up with the Schedule tab and
still no instructor audience in Comms, with no error anywhere to explain it. This is
precisely the class of silent half-fix that has bitten before. **Ship both halves together.**

Also worth separating: instructor Comms audience *visible* ≠ **able to email them ad hoc**.
The compose-and-send-to-instructors surface Jessica asked for on the morning of 2026-08-11
is still an unbuilt, separate piece (see §4, "Instructor email visibility in Comms").

### B3. Two more decisions, 2026-08-11
**No Stripe Connect step in Jeff's onboarding.** Today `effectiveStepOrder` only toggles
`CHECKR_SUBMITTED` and `TRAINING_COMPLETED`; **`STRIPE_SUBMITTED` is unconditional for every
tenant.** So this needs a third toggle. Natural config already exists:
`organizations.instructor_pay_enabled` — verified `false` for Jeff, `true` for J2S, which is
exactly the right split. Blocks chunk 3.

**After-school only, "for now."** Jeff runs no camps (verified: 0 camp cycles, 3 after-school
terms FA26/SP27/WI27). **Implement this as data-driven, NOT as a camps switch-off** — the
Schedule page should land on whichever mode the org actually has. Her words were "for now",
and school-break camps are a normal after-school-provider offering, so a hard disable would
have to be undone later. A data-driven default needs no rework.

### C. Preview by walking the wizard as an instructor would — YES, and we have precedent
Honest finding: I could **not** confirm that HR onboarding tools (BambooHR / Gusto /
Rippling) ship an "experience it as an employee" mode — the search did not substantiate it,
so I am not claiming it as a norm.

What IS substantiated: the form/survey world does this universally (Google Forms' eye icon,
SurveyMonkey test mode, Typeform preview) — and **we already shipped exactly this pattern
in-product** when the hand-drawn registration preview was replaced with one that opens the
REAL form. So this is consistent with a decision Jessica has already made.

Design: a **"Preview onboarding"** action in Settings that runs the REAL wizard against a
throwaway sandbox record, clearly bannered, discarded at the end.
**Hard requirement:** it must NOT write to a real instructor. The existing `?as=` portal
preview does write real data (§6a) — that is the flaw not to repeat.

### D. "This serves as my invoice" attestation
Surface: the **"Mark taught"** button in `DayRow` (`InstructorPortal.jsx:3208`), plus
`SubCheckInSection`. Writes to **`session_delivery_confirmations`** (218 rows on prod).

That table has **no attestation column today**. Requirements:
1. **Show the line at the point of the click**, immediately above the button — not in a
   drawer or a footnote.
2. **STORE a snapshot of the exact wording + a version on the confirmation row.** An
   attestation that is only rendered is not evidence, and rewording it later would
   retroactively change what 218 past confirmations appear to have said. Same lesson as the
   payment-plan fee snapshot and as `contractor_agreements` snapshotting signed text.
3. **Per-org configurable with a neutral default** — nothing hardcoded for any tenant.
4. **I am not a lawyer.** Draft wording below is neutral phrasing, not legal advice, and
   should be reviewed before it goes live — it is simultaneously a contractor-status
   statement and a payment document.

Draft for review: *"By marking this session taught, I confirm I delivered it as an
independent contractor. This record serves as my invoice for this work."*

### E. J2S-hardcoding audit — her hard constraint, results
Grepped all of `src`. Real hardcodes (excluding comments):
- **`App.jsx:205, 215, 216`** — `/j2s/instructor` route + the `/instructor` and
  `/instructors` redirects. **In scope. Fixing in chunk 2.**
- **`PublicLayout.jsx:143`** — `if (org.slug === 'j2s')` renders a whole hardcoded branded
  shell, including `support@journeytosteam.com` and a "Journey to STEAM" footer.
  **Family-facing, not instructor** — out of this build's scope, but it is a genuine
  slug-branch she should know exists.
- **`index.css`** — the shared CSS variables are literally named `--j2s-purple` etc. Values
  ARE overridden per brand so behavior is correct for every tenant; the *naming* is debt,
  not a functional hardcode. Cosmetic, cheap to rename, not urgent.

Everything else matching "j2s" in `src` is commentary.

## 7b. NEXT BUILD — each document is on/off per provider

Jessica, 2026-08-12, after testing the documents screen: *"these policies should be
toggle on or off. not every provider will use them all."* Correct, and it is the
same mistake as everything else in this build — J2S needs all seven, so all seven
became mandatory for everyone. A chess tutor whose instructors never drive is
currently forced to write a driving acknowledgment before anyone can finish
onboarding, because Screens 5 and 6 block on all six non-agreement documents.

**Do NOT infer "off" from "not published."** Tempting and wrong: a provider who
intends to have a code of conduct but has not written it yet would silently
onboard instructors who never acknowledged one. Absence is not a decision;
the toggle has to be explicit.

Shape, in build order:

1. **Storage** — `organizations.instructor_document_config` JSONB, matching the
   shape of `background_check_config` / `training_config` that already exist.
   `{ photo_video_release: false, vehicle_driving_ack: false }` — absent key means
   ON, so **every existing org keeps all seven with no backfill** and J2S is
   untouched. Additive and inert.
2. **Expose it to the instructor.** The wizard cannot read `organizations` (RLS),
   which is why `background_check_public` exists as a column on the
   `public_org_directory` view. Add the document config the same way. **This is the
   part that needs a migration** and is the reason this is not a UI-only change.
3. **Filter the wizard.** `Screen5Policies` DOCS and `Screen6Additional` DOC_KEYS
   stop being constants and come from the enabled set. If a screen ends up with
   zero enabled documents it must be skipped entirely, not shown empty — same rule
   `effectiveStepOrder` already applies to the background-check and training steps.
4. **The toggle UI** on `/admin/instructor-documents`: a switch per row. Turning one
   OFF must not delete published versions — a provider who turns the photo release
   back on should get their old text, and anyone who already signed it keeps their
   record.
5. **The banner count** ("all 7 of these") must count ENABLED documents, or it goes
   straight back to lying.

**The contractor agreement is not toggleable.** It is the one document that is
signed rather than acknowledged, `submit-agreement` requires it, and onboarding
cannot complete without it.

## 8. Not yet done

- Nothing built. Repo is at baseline: main clone on `staging` @ `69c289e`, clean, no
  worktrees, no branches.
- Sequencing above is proposed, **not approved**.
- Background-check default (off) is my assumption, not Jeff's answer.
- Whether each instructor surface survives zero rows is **untested** — that is the gate on
  chunk 2 and the single most likely place this build goes wrong.
