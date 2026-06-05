# Family Comms Automations v1 — handoff (2026-06-03 EOD)

**Status: SHIPPED and live.** All 9 lifecycle templates exist, the editor has
real-data preview + test send, the daily cron is active, and all camp
automations are toggled ON. This doc is the "where we landed / what's left"
for tomorrow's awake brain.

---

## What shipped today (already on prod)

- **Real-data preview pane** in `AutomationEditor.jsx` — picks a real camp/program
  and renders the actual email (same render pipeline as test send + live send).
  Live preview label flips between "real data" / "sample data". Committed in
  `37c997d`, deployed, verified live.
- **Real-data test send** from the editor drawer (backend `mode:"test_send"`).
- Body-editor HTML round-trip + sign-off `<br>` stacking fixes (prior commit
  `27ff829`).

## What's running right now

- **Cron**: pg_cron jobid 19, fires **15:00 UTC = 8:00am PDT daily**, POSTs to
  `lifecycle-automations-cron`.
- **All camp automations toggled ON** (Jessica did this end of day 2026-06-03).
- **First real send**: `welcome_camp` fires ~**June 8** (first camp is June 15,
  7-day lead). 262 confirmed camp registrations are eligible (all have a student
  + parent email).

---

## The flash-sale investigation (why I touched this today)

Jessica asked: today's FA26 flash-sale marketing campaign silently failed to
send — does the lifecycle system have the same bug?

**Answer: No.** Different architecture.

- **Flash-sale failure root cause**: a throwaway path — 15 hand-built
  `flash_sale_*` pg_cron jobs → a standalone `flash-sale-send` edge function that
  **wrote nothing to the DB**. pg_cron reported "succeeded," but `net.http_post`
  is async, so "succeeded" only means *the POST was accepted* — not delivered.
  No per-recipient row, no Resend message-id. Unrecoverable, invisible.

- **Lifecycle cron is the opposite** (verified `index.ts` 283–447): every run
  writes an `automation_runs` row (status `sending`→`sent`/`failed`), and each
  successful send writes an `automation_run_recipients` row capturing the real
  `resend_message_id`. Send-first-then-insert means failures don't write a
  "sent" row, so the next cron retries them. Idempotent via
  `UNIQUE(automation_id, context_key)`. **Sends are auditable in the DB** — the
  exact thing the flash sale lacked.

---

## Fixed tonight (staged, NOT yet committed/pushed)

- **Stale header comment** in `lifecycle-automations-cron/index.ts` (lines 5–14):
  it wrongly listed `session_midpoint`, `session_last_day`,
  `days_after_first_session`, `birthday` as "stubbed / no fire." They are
  fully implemented. Comment now lists the real wired triggers. **Comment-only,
  zero behavior change.**

### To ship this tomorrow (one-liner each)
> ⚠️ The working tree has unrelated changes from the **instructor-onboarding chat**
> (`InstructorPortal.jsx`, `ProgramWizardNew.jsx`, `apps-script-roster-sync`,
> `deno.lock`, `docs/backlog.md.md`). **Do NOT commit those here.** Scope the
> commit to the one file:

```
git -C C:\Users\JVorster\Desktop\Projects\enrops add supabase/functions/lifecycle-automations-cron/index.ts
git -C C:\Users\JVorster\Desktop\Projects\enrops commit -m "Correct lifecycle cron header comment (triggers are wired, not stubbed)"
git -C C:\Users\JVorster\Desktop\Projects\enrops push origin main
npx supabase functions deploy lifecycle-automations-cron
```

(Frontend doesn't change, so no Netlify wait needed for this one.)

---

## Decisions waiting for awake-brain review

### 1. Persist per-recipient send FAILURES (recommend: do it)
Today, when a send fails, the function logs to `console.error` + an aggregated
`automation_runs.error_message` ("N of M sends failed"), but writes **no
per-recipient row**. So a *persistently* failing parent is only visible for 24h
(edge-log retention). For a once-daily lifecycle send that's a small gap, but
worth closing now that all automations are live.

**Why it's not a one-liner**: the idempotency pre-check
(`select context_key ... where automation_id = x`) currently treats ANY row as
"already done." If we insert `status='failed'` rows, that query must be filtered
to `status='sent'` or it'll skip the retry. So the change is:
1. `index.ts` ~line 312 pre-check → add `.eq("status", "sent")`.
2. `sendOne` failure branch (~line 425) → upsert a `status='failed'` row
   (on-conflict update, since the unique key may already hold a prior failure).
3. Confirm `automation_run_recipients.status` CHECK constraint allows `'failed'`
   (query `pg_constraint` first — per the SQL-constraints memory rule).

Low risk but it's a behavior change to the send/idempotency path — review awake.

### 2. Trust-but-verify the daily cron actually ran
The cron fires via `net.http_post` (async) — same false "succeeded" signal at the
*trigger* level as the flash sale. The mitigation is already built (durable rows),
but the habit worth adopting: **after a send is expected, check the DB, not
pg_cron status.**

---

## Concrete verification to run AFTER the first send (~June 8, post-8am PDT)

This is the proof-of-send the flash sale never had. Claude can run these directly
via Supabase MCP:

```sql
-- Did today's run happen and finish clean?
select id, automation_id, status, audience_size, time_saved_minutes,
       error_message, created_at
from automation_runs
where created_at >= current_date
order by created_at desc;

-- Did real per-recipient rows land with Resend message-ids?
select automation_id, status, count(*),
       count(resend_message_id) as with_message_id
from automation_run_recipients
where created_at >= current_date
group by automation_id, status;
```

Expect: `automation_runs.status = 'sent'`, and `with_message_id` = row count
(every sent row has a real Resend id). If runs are missing entirely → the cron
didn't fire (check pg_cron job 19). If rows exist but `error_message` is set →
some sends failed (see decision #1 about making those durable).

---

## Backlog (not blocking — see docs/family-comms-backlog.md)

1. **Per-term `register_url`** — single column today; FA26 + SU26 share one URL.
2. **Cities-as-`school_name` hygiene** — ~1018 J2S recipients have a city in
   `school_name`. Cosmetic for camps (uses geo_segment), noisy for analytics.
   One-shot SQL pass.
3. **Provider-facing camp-creation UI** — camps still load via Tracker sync.

---

## Guardrail sweep result (ran 2026-06-03)

Passed: deploy verified (`37c997d` live, HTTP 200, ~18s build); no hardcoded
tenant identity; stored overrides clean; block tokens render between paragraphs
(not inside `<p>`); sign-off stacks with `<br>`; operator-facing copy honest.
