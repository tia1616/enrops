# Don — Mechanical Validation Checks

*Checks that run on Don's output **outside** his system prompt. These are cheap, fast, and 100% reliable — they catch the kinds of mistakes that are better caught by code than by asking Don to remember rules.*

**Version:** v1 — 2026-05-19

---

## When these run

After Don generates a draft, before it's saved as a campaign the operator can review. If any **hard rejection** check fails, regenerate the draft (or send back an error). If any **soft warning** triggers, save the draft but flag the issue in the review UI so the operator sees it.

---

## Hard rejections (regenerate the draft if any fail)

### Dollar-sign check

If the body or subject contains `$` followed by a digit (regex: `\$\d`), reject. Don should be using `{{early_bird_price}}`, `{{regular_price}}`, `{{savings}}`, or `{{promo_amount}}` — never an inline dollar amount.

### Bare date check

If the body matches a date pattern (`January 5`, `1/5`, `Jan 5th`, `9/10/2026`, etc.) that isn't inside a token, flag for human review. Could be legitimate ("see you in September") but usually means Don invented a date.

> Suggested regex starting point: `\b(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\s+\d{1,2}` — tune for false positives.

### Unknown token check

If the body contains any `{{token}}` not in the approved registry (the `marketing-merge-tokens.md` doc), reject. Don made one up.

### Banned-phrase check

Scan against the provider's "Words and phrases to avoid" list from their Don's notes file. If any match, reject with the specific phrase flagged so the regeneration prompt can call it out.

---

## Soft warnings (allow but flag for operator review)

### Exclamation count

- More than 2 exclamation points in the body → flag.
- More than 1 in the subject line → flag.

### All caps

Any word longer than 3 letters in all caps that isn't a known acronym (`STEAM`, `STEM`, `K-5`, `LEGO`, etc.) → flag.

### Emoji count

More than 3 emojis total across subject + body → flag.

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

---

## At send time, not draft time

### Unfilled token check

If a `{{token}}` makes it through to the actual outgoing email, that's a bug — either the token doesn't exist in the registry, or its fallback wasn't applied.

**What to do:**

1. Log it for debugging.
2. If a fallback is defined in `marketing-merge-tokens.md`, apply it.
3. If no fallback exists, skip the send for that recipient and surface the failure to the operator. Don't send an email with literal `{{token_name}}` text in it.

---

## Why these live outside Don's prompt

Don's prompt is for **judgment calls** — what tone to strike, what to say, what to leave out. Mechanical checks are **rules a regex can enforce**. Asking Don to "always remember to never use a dollar sign" wastes prompt tokens and is less reliable than a 5-character regex.

The split:

- **Don's prompt:** voice, audience, what to claim and not claim, when to use a token.
- **Mechanical checks:** Did he actually do it? Did he slip up?

Two layers, two jobs, both cheap to maintain.
