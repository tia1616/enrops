# Provider guides (source of truth)

One set of guides feeds three places, so there is one thing to keep true:
1. the Help page (every guide, grouped by stage),
2. the "?" bubble next to each page title (links to that page's guide),
3. Ennie's answers in chat (answers ONLY from these files, and names the guide it used).

## Rules for writing a guide

- Use the exact words on the screen. If the screen changes, the guide changes in the same commit.
- One job per guide. Goal, when you need it, what to have ready, steps, Ennie's advice, if it goes wrong.
- Plain words. "site", "school partner", "enrops service fee" (ours), "processing fee" (Stripe's).
- Lowercase "enrops". No database words. No em dashes.
- Numbers name their source. A fee or a time on screen is quoted from the screen, never invented.
- If something can't be done yet, say so plainly ("Not yet. Tell us if you need it.").
- Verified against prod: commit `e144a4a1` (origin/main, 2026-11-19), lean nav, free plan. The Locations, district and roster steps were re-checked 2026-11-19 against the one-Locations-list release (`8651fef2`).
- `guides.test.mjs` fails on a heading without an `{#id}`, a duplicate id, a leftover `VERIFY` note, or a "?" bubble whose `guide="..."` points at nothing.

## Stages (a stage opens when its trigger happens)

| File | Stage | Opens when |
|---|---|---|
| `1-get-your-link.md` | Get your link | Signup |
| `2-make-it-yours.md` | Make it yours | First program published |
| `3-fill-your-classes.md` | Fill your classes | Stage 1 complete |
| `4-run-the-term.md` | Run the term | About 14 days before the first class |
| `5-money.md` | Money moments | First registration, refund or payout |
| `6-next-term.md` | Next term | Last class date passes |
| `faq.md` | Questions people actually asked | Always |

Each guide heading carries an id in braces, for example `{#connect-stripe}`. Pages link to that id.
