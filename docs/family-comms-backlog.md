# Family Comms — backlog

Items deferred from the 2026-06-02 / 2026-06-03 Q1 intent-first build. Not blocking
ship; sized small-to-medium each. Tackle when next looking at marketing comms or
when a tenant onboarding makes one of them load-bearing.

---

## 1. Per-term `register_url`

**Today.** `organizations.register_url` is a single column. Every campaign
links there regardless of term — FA26 emails and SU26 emails both point at
the same URL.

**Why this is a problem.** Different terms have different registration
pages (J2S today: `/fall-after-school` vs `/summer-camps`). Operators
shouldn't have to override the URL per campaign.

**Schema candidate.** `organizations.term_register_urls jsonb` keyed by
term code: `{ "FA26": "https://...", "SU26": "https://...", "default": "..." }`.
Marketing-touchpoint-send resolves the term from the campaign's picks and
looks up the matching URL, falling back to `register_url` if not set.

**Touches.** `organizations` migration; `marketing-touchpoint-send`'s token
resolver; onboarding-checklist Step 4.

---

## 2. Cities-as-`school_name` data hygiene

**Today.** ~270 J2S `marketing_recipients` have a city name (Portland,
Hillsboro, Beaverton, Tigard, etc.) in `school_name`. Almost certainly
mis-tagged camp parents — the city is the *area*, not the school the
child attends.

**Why this is a problem.** Mostly cosmetic: when the marketing renderer
tries to match `school_name` to a `program_locations.name`, "Portland"
never matches. These parents fall through to no-match. For camps mode
that's fine (camps use geo_segment, not school_name). For afterschool
mode they get a generic email. For analytics it's noisy.

**Recommended fix.** One-shot SQL pass: for any recipient whose
`school_name` matches a known `geo_segment` value AND whose `school_name`
doesn't match any `program_locations.name`, move the value into
`geo_segment` (if not already set) and null out `school_name`.

**Touches.** SQL migration via Supabase MCP; no code changes needed.

---

## 3. Provider-facing "create a program/camp from scratch" UI

**Status as of 2026-06-03.** The "Instructor schedule onboarding flow"
session is actively building `ProgramWizardNew.jsx` +
`ProgramPrereqEmptyState.jsx` + a `preview_program_session_dates`
migration. That work covers afterschool program creation.

**Camp creation is still a gap.** Today camps are loaded via Tracker sync
(SU26 brittleness — see [memory: tracker sync brittle on renames](../../../../.claude/projects/C--Users-JVorster/memory/project_enrops_tracker_sync_brittle.md)).
A second tenant onboarding can't bootstrap camps without an admin UI.

**Recommended scope.** Once the afterschool wizard ships (other chat),
extend the same pattern to camps: prereq detection, step-wise wizard,
backed by `camp_sessions` writes scoped per-org-cycle.

**Touches.** New `CampWizardNew.jsx` or shared `EntityWizardNew.jsx`;
likely a shared prereq detection helper.

---

## Recently resolved (this session, 2026-06-03)

- Q1 multi-select visual constraint to Q1-covered options — landed.
- AutoScopeBanner highlights auto-derived items as pills — landed.
- Camp pricing columns (price_cents / early_bird_price_cents /
  early_bird_deadline) + per-area camp price token resolution — landed.
- J2S brand-string fallbacks in instructor-portal edge functions
  (`send-offers`, `send-availability-survey`, `offer-reminders-cron`,
  `send-patch-offer`, `offer-message-reply`, `stripe-webhook`,
  `create-checkout`) — replaced `?? 'j2s'` with throw on null slug.
- 3 J2S brand strings removed from `marketing-draft-campaign` prompt
  (was leaking into every tenant's Ennie call).
- Body editor preserves italics/bold via markdown round-trip; edits
  save on Done editing (DB PATCH); All/None bar on multi-selects;
  "no picked content" badge suppressed for non-program intents.

## N. Camps: the token set is not per-mode

Filed 2026-08-10, from the code review of the `{{registration_close_date}}`
build. Deferred deliberately: camps are done for the season, so nothing can hit
this until next summer.

The afterschool half of this review is FIXED, not deferred - `{{program_details}}`
shipped the same day (one row per program, each with its own deadline), which is
what Jessica asked for when she saw the dangling sentence in a Cannady preview.
The camps half below is the part still open.

**Today.** `APPROVED_TOKENS` in `marketing-draft-campaign` is ONE flat set
covering both modes. The rule that a token is afterschool-only lives in prose
inside Ennie's prompt ("Tokens that DO NOT work for camps"), and the merge-token
palette in `TouchpointCard.jsx` shows every chip regardless of the campaign's
mode. Neither is enforcement.

**Why this is a problem.** A camps draft that uses an afterschool-only token
passes the mechanical check, then renders empty at send. `postCleanCopy` only
strips lines ending in a colon and collapses runs of spaces, so the parent
receives the half-sentence: `Sign-ups close on .` This is a whole class, not one
token - `{{day_of_week}}`, `{{session_count}}`, `{{regular_price}}`,
`{{early_bird_price}}`, `{{early_bird_deadline}}`, `{{savings}}`, `{{vip_price}}`
and now `{{registration_close_date}}` all behave this way in camps mode.

**Fix candidate.** Split into `AFTERSCHOOL_TOKENS` / `CAMPS_TOKENS` / `SHARED_TOKENS`,
have the draft validator reject out-of-mode tokens instead of trusting the prompt,
and filter the palette in `TouchpointCard.jsx` by the campaign's mode so an
operator cannot insert a chip that renders blank.

**Touches.** `marketing-draft-campaign` (APPROVED_TOKENS + prompt),
`marketing-touchpoint-send` (keep the two sets in sync), `TouchpointCard.jsx`
(palette filter). Worth doing before next summer's camps campaigns.

Root cause worth naming: the renderer substitutes an empty string and trusts the
copy around it to still read. `{{early_bird_deadline}}`, `{{savings}}`,
`{{regular_price}}`, `{{session_count}}` and `{{day_of_week}}` all still have
that shape. The afterschool fix took the block-shaped route
(`{{program_details}}` renders a whole `<ul>` or nothing, so there is no
half-sentence to leave behind) - prefer that pattern over per-symptom patching
when this comes back around.

---

## 8. The curriculum-change notice still sends literal `**asterisks**`

**Added 2026-09-22.** Jessica's call: not urgent, because curricula are not
changed often. Do it the next time anything touches that sender.

**Today.** `notify-program-curriculum-change` has its own private send loop, its
own plain textarea, and posts `text:` only to Resend — no HTML path at all.
That is the exact defect Jeff reported on Message families on 20 Sept, in the
one surface that was not fixed with it. **14 sends on prod** have gone through
it. An operator who drafts with an assistant and pastes gets `**bold**` and
`[words](url)` delivered literally, the same as the 230 of 405 emails measured
on The Ukulele Project before the Message families fix.

**Why it was left.** Scope. The Message families build was Jeff's actual
complaint and shipped 21 Sept; this is its twin, and nothing about it got worse
in the meantime.

**Do NOT fix it by teaching the twin the same trick.** It also defines its own
private `substitute()` at `index.ts:100`, a second copy of the one exported from
`_shared/familyNotify.ts`. Two spellings of one rule is the divergence, not the
cure. The fix is to **delete both private copies and adopt the shared modules**
— `familyNotify` for the send loop and token substitution, `familyEmailHtml` for
the HTML body and the plain-text half derived from it. That is the same adoption
Message families just went through, so the shape is proven.

**Watch for when you do.** The shared `substitute()` now accepts `{single}` as
well as `{{double}}` braces; the twin's private copy does not. Check the twin's
stored templates for either form before switching, so nothing that renders today
starts rendering blank.

**Touches.** `notify-program-curriculum-change/index.ts` (its send loop, its
`substitute`, its textarea's surface), `_shared/familyNotify.ts` and
`_shared/familyEmailHtml.ts` (adopt, do not copy). Deploy-order note: this
function bundles `_shared`, so deploy it from a tree level with `origin/main`.

---

## Recently resolved (prior session, 2026-06-02)

- Q1 intent-first surface with 4 intents + "Something else" sub-intents.
- Q2 auto-derive from Q1 picks (camps + programs).
- Camps end-to-end: per-area token resolution, `{{camp_details}}` HTML
  list, `{{school}}` blocked for camps.
- 79-test boundary suite in `scripts/verify-intents.mjs`.
