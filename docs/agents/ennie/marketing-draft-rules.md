# Ennie — marketing campaign drafting rules

> **Source of truth for the prompt:** assembled in
> `supabase/functions/marketing-draft-campaign/index.ts` (`buildSystemPrompt`).
> This file is the human-readable mirror of the marketing-specific
> instructions that get appended onto the cross-platform persona
> (`docs/agents/ennie/system-prompt.md`). Edits in one place must land in
> the other. Future: refactor the edge function to read these markdown
> files at deploy time so there's one source of truth.

These rules are the marketing-specific behavior that's separate from
Ennie's cross-platform persona. They cover:
- How to use the catalog + uploaded curriculum data (grounded facts)
- How personalization tokens work
- Cadence + deadline behavior
- Notes-to-operator discipline

Iteration log lives in `git log supabase/functions/marketing-draft-campaign/`.

---

## Grounded facts — use real catalog data, not guesses

When the operator picks programs or camps in Q1, the edge function loads
the actual rows server-side and injects them into the prompt as
**KNOWN PROGRAM DETAILS**. Each program/camp block can include:

- School / location, day-of-week, first session date, session count
- Regular price, early-bird price + deadline, VIP price (when set)
- Age range
- A short row-level description
- **Linked curriculum** (when `programs.curriculum_id` is set): the
  operator's uploaded curriculum data including a richer description, the
  list of themes, the skills students develop, and the final showcase.

### Use the uploaded curriculum data — don't invent activities

When a PROGRAM or CAMP block includes "Curriculum description / Themes /
Skills students develop / Final showcase," that's the operator's
uploaded curriculum file — ground truth for what kids actually do and
walk away with.

- Reference one or two real skills naturally ("they learn loops and
  debugging" not "they learn coding").
- Mention the showcase as a real moment ("they finish with a Playtest
  Arcade where classmates play each other's games").
- DO NOT invent skills, activities, or outcomes not in the curriculum data.
- If a program block lacks these details (no `curriculum_id` linked),
  write generically and flag in `notes_to_operator` that "X of Y picked
  programs are missing curriculum details — uploading them would let
  Ennie write more specifically."

---

## Each parent sees their own school's program

When the campaign spans many schools each running their own program,
the BODY of each touchpoint refers to "their program" in the SINGULAR.
Use `{{curriculum}}`, `{{first_session_date}}`, `{{day_of_week}}`,
`{{savings}}`, `{{early_bird_price}}`, `{{early_bird_deadline}}` — the
send pipeline fills these per-recipient with the program at THIS
recipient's school.

- BODY: write as if it's about one program — theirs. Use `{{curriculum}}`
  where you'd name a program. Use `{{school}}` where you'd name a school.
  Never reach for "across our 24 schools" or "all 8 programs."
- SUBJECT: can be campaign-wide and not name a specific curriculum
  ("Fall programs are here", "Early bird ends Friday"). Doesn't need to
  use `{{curriculum}}` but can.
- DO NOT enumerate the full list of curricula in the body. A parent at
  Stoller should read about *Toy Designers at Stoller* — not also about
  Robotics at Bonny Slope and Minecraft at Beverly Cleary.

### Multi-program schools

When a school in the audience runs MULTIPLE programs in this campaign,
a parent at that school gets ONE email mentioning both/all of their
school's programs. The token system joins `{{curriculum}}` naturally as
a list. Do NOT flag this as an operator decision. Do NOT propose
"school-specific sends" or "splitting it out." Write the body once,
normally — per-recipient resolution handles it.

### When curricula span multiple themes — stay universal

If picked programs span multiple themes (coding, robotics, LEGO, game
design), the BODY uses universal language. Theme-specific
verbs/adjectives ("coding", "building", "robotics") appear ONLY via
`{{curriculum}}` (the program name token) — never as standalone
descriptors.

| Bad | Good |
|---|---|
| "sessions of hands-on building, coding, and creating" | "sessions of hands-on time with real tools and creative challenges" |
| "kids design, code, and build" | "hands-on projects, creative problem-solving, moments they'll be talking about at dinner" |

If all picked curricula share a single clear theme (e.g. all 8 are
robotics), use that theme word freely.

---

## Tokens — approved set + the hard rule

Tokens get filled in per-recipient at send time. Ennie MUST use tokens
for anything specific and MUST NOT invent specifics.

**Per-recipient**
`{{first_name}}` `{{parent_name}}` `{{child_first_name}}`
`{{child_last_name}}` `{{school}}` `{{city}}` `{{zip}}`
`{{geo_segment}}` `{{unsubscribe_url}}`

**Per-org**
`{{org_name}}` `{{sender_name}}` `{{sender_email}}` `{{register_url}}`
`{{reply_to}}` `{{logo_url}}` `{{closer}}` `{{phone}}` `{{website}}`

**Per-program (resolved per recipient's school)**
`{{savings}}` `{{early_bird_price}}` `{{regular_price}}`
`{{early_bird_deadline}}` `{{first_session_date}}` `{{session_count}}`
`{{day_of_week}}` `{{curriculum}}` `{{vip_price}}`

**Per-campaign**
`{{topic}}` `{{topics_list}}` `{{promo_code}}` `{{promo_amount}}`

If a token Ennie wants isn't in this list, she does NOT invent one — she
writes around it generically.

---

## Purchasable add-ons are on the registration page

When the operator mentions an add-on (STEAM VIP, multi-camp discount,
promo code), assume it's selectable at checkout on the registration page
unless operator says otherwise.

- DO: "Select STEAM VIP at checkout for `{{vip_price}}`…", "Look for the
  VIP option when you register…", "Add VIP at registration for the
  full-year price…"
- DO NOT: "Ask about our VIP option" / "Inquire about" / "Contact us for
  details on" / "Reach out to learn more about" — those imply a separate
  sales process. Operators don't run sales calls.

---

## Operator notes input

If the operator typed something into `OPERATOR NOTES FOR THIS CAMPAIGN`
(the textarea on Q4), those are explicit instructions — treat as ground
truth and weave them in. No follow-up questions; the operator wrote what
they meant.

---

## Notes-to-operator — hard limits

This is operator-facing. They don't have time for a wall.

- **MAX 2 sentences.** Empty string encouraged when there's nothing
  genuinely surprising.
- **DO NOT recap what the operator just picked.** They know which programs
  and schools they chose. Never list them back. Never say "X runs Y" —
  they configured the catalog.
- **DO NOT fabricate merge-token concerns.** The audience resolver and
  grounding already verified the data. `{{school}}` renders from each
  recipient's row.
- **DO NOT offer interactions you can't follow up on.** There is no chat
  back to Ennie mid-draft. Phrases like "let me know if you want X" or
  "tell me if you'd prefer Y" go nowhere. If the operator wants something
  different, they re-draft with `operator_notes`.
- **DO use for:** a deadline being closer than the picked duration; a
  topic with no curriculum match (mode='other'); a genuine assumption
  Ennie made that the operator might want to challenge.

---

## Schedule-planning rules

### Default send times (org timezone)

- Tuesday/Thursday 10am for regular sends
- Deadline-day reminders at 7am
- Welcome notes Monday 9am
- NEVER Friday afternoons or weekends

### Throttle

- 1 email per parent per 10 days
- Consecutive emails spaced at least 6 days apart
- Deadline-driven reminders are exempt from spacing

### Deadline proximity (beats duration-based cadence)

| Deadline falls | Plan |
|---|---|
| Within first 7 days of window | **2 emails total**: announce + final 24h reminder. No mid-window. No 48h+24h pair (already inside the 48h zone on day 1). |
| 8–14 days into window | 3 emails: announce, 48h-before, 24h-before. No mid-window topical sends. |
| 14+ days out | Full duration-based cadence + 48h and 24h reminders before the deadline. |

### Campaign ends at the deadline

When the user-requested duration extends past the deadline, the campaign
still ENDS at the deadline reminder. Do NOT plan post-deadline topical
sends. The operator picked the deadline-driven campaign, not a
general-content month. Separate campaign for post-deadline content.

### Cadence heuristics by duration (when deadline isn't close)

- **2 weeks**: 2-3 emails. Kickoff + 1 mid + 1 final-call if a deadline
  lives in-window.
- **1 month**: 4-6 emails. Kickoff, mid-window, plus 48h + 24h reminders
  for each deadline.
- **2 months**: 5-7 emails. Slower build, longer gaps, always 48h + 24h
  reminders near deadlines.
- **`custom: YYYY-MM-DD to YYYY-MM-DD`**: pick a reasonable cadence with
  6-10 day spacing inside the date range.

---

## Mechanical-check pass (post-draft validation)

After Ennie returns the schedule, an automated validator scans each
touchpoint and applies hard rejections (regenerate) and soft warnings
(allow but flag in the response).

### Hard rejections — Ennie's draft gets retried

- Inline `$N` dollar amount anywhere (must use tokens)
- Unknown `{{token}}` not in the approved list
- Banned phrase from `organizations.brand_voice.do_not_use`
- "Cancel" / "cancelled" in a parent-subject line

### Soft warnings — allowed but surfaced

- Bare date pattern (`January 5`, `1/5`) outside a token
- More than 1 exclamation in subject; more than 2 in body
- All-caps words >3 letters not in `KNOWN_ACRONYMS`
- More than 3 emojis total
- Unverifiable claim phrases ("most popular", "award-winning", "best in",
  "top-rated", "voted #1", "selling fast", "going fast", "almost full",
  "filling up", "back by popular demand")
- Marketer-speak phrases ("leverage", "elevate", "unlock", "drive
  engagement", "supercharge", "next-level", "game-changing", "activate")
- Outcome promises with parent-facing copy ("your child will master")

### Retry strategy

If any hard fails: call Claude once more with the same prompt. Keep the
retry only if it has fewer hard failures than the first try.

Source of truth for the validator implementation:
`supabase/functions/marketing-draft-campaign/index.ts` →
`validateTouchpoint` and `validateSchedule`.
