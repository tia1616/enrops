# Ennie — Mechanical Validation Checks

*Checks that run on Ennie's Mode B output (drafted messages going to parents, instructors, partners) **outside** her system prompt. These are cheap, fast, and 100% reliable — they catch the kinds of mistakes that are better caught by code than by asking an LLM to remember rules.*

**Version:** v1 — 2026-05-28
**Replaces:** `docs/agents/don/mechanical-checks.md`. Same rules — Ennie inherits Don's discipline for writer-mode output, plus a couple of new ones for instructor/partner channels.

---

## When these run

After Ennie generates a draft, before it's saved as a campaign / queued message the operator can review. If any **hard rejection** check fails, regenerate the draft (or send back an error). If any **soft warning** triggers, save the draft but flag the issue in the review UI so the operator sees it.

Mode A (operator-facing chat / suggestions / narration) is not subject to these checks — it's interactive and the operator sees it immediately. Mode B is what gets these guardrails.

---

## Hard rejections (regenerate the draft if any fail)

### Dollar-sign check

If the body or subject contains `$` followed by a digit (regex: `\$\d`), reject. Ennie should be using `{{early_bird_price}}`, `{{regular_price}}`, `{{savings}}`, or `{{promo_amount}}` — never an inline dollar amount.

### Bare date check

If the body matches a date pattern (`January 5`, `1/5`, `Jan 5th`, `9/10/2026`, etc.) that isn't inside a token, flag for human review. Could be legitimate ("see you in September") but usually means Ennie invented a date.

> Suggested regex starting point: `\b(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\s+\d{1,2}` — tune for false positives.

### Unknown token check

If the body contains any `{{token}}` not in the approved registry (the `marketing-merge-tokens.md` doc), reject. Ennie made one up.

### Banned-phrase check

Scan against the tenant's "Words and phrases to avoid" list from their Ennie's notes file. If any match, reject with the specific phrase flagged so the regeneration prompt can call it out.

### "Cancel" in parent-facing subject lines (new)

For Mode B output where the audience is `parents`, if the subject line contains "cancel" or "cancelled" (case-insensitive), reject. Reframe required — "isn't running" / "schedule update" / "we've moved that to next session." Operator and partner channels are exempt; cancel language is fine there.

### Instructor subject-line cancel check (new)

For Mode B output where the audience is `instructor`, if the subject line contains "cancel", "removed", or "terminated", reject. Reframe to "Schedule update" or "Change to your [date] assignment."

---

## Soft warnings (allow but flag for operator review)

### Exclamation count

- More than 2 exclamation points in the body → flag.
- More than 1 in the subject line → flag.

### All caps

Any word longer than 3 letters in all caps that isn't a known acronym (`STEAM`, `STEM`, `K-5`, `LEGO`, etc.) → flag.

### Emoji count

More than 3 emojis total across subject + body → flag. For instructor and partner audiences, more than 1 emoji anywhere → flag.

### Unverifiable claims

If the body contains phrases like:

- "most popular"
- "award-winning"
- "best in [anything]"
- "top-rated"
- "voted #1"
- "selling fast" / "going fast"
- "almost full" / "filling up"
- "back by popular demand"

…flag for human review. These can be legitimate if true, but should always get the operator's eyes on them.

### Outcome promises (new)

Flag if body contains "your child will [become / master / be able to]" or "guaranteed to [anything]". Describe what kids will *do*, not what they'll *become*. Operator can override if the claim is genuinely true and they're comfortable owning it.

### Marketer-speak (new — covers Ennie's "no jargon" rule)

Flag if body or subject contains any of: "leverage", "elevate", "unlock", "drive engagement", "synergy", "activate your", "supercharge", "next-level", "game-changing". Mode B copy should sound like a human, not a deck.

---

## At send time, not draft time

### Unfilled token check

If a `{{token}}` makes it through to the actual outgoing email, that's a bug — either the token doesn't exist in the registry, or its fallback wasn't applied.

**What to do:**

1. Log it for debugging.
2. If a fallback is defined in `marketing-merge-tokens.md`, apply it.
3. If no fallback exists, skip the send for that recipient and surface the failure to the operator. Don't send an email with literal `{{token_name}}` text in it.

---

## Why these live outside Ennie's prompt

Ennie's prompt is for **judgment calls** — what tone to strike, what to say, what to leave out. Mechanical checks are **rules a regex can enforce**. Asking Ennie to "always remember to never use a dollar sign" wastes prompt tokens and is less reliable than a 5-character regex.

The split:

- **Ennie's prompt:** voice, audience, what to claim and not claim, when to use a token.
- **Mechanical checks:** Did she actually do it? Did she slip up?

Two layers, two jobs, both cheap to maintain.
