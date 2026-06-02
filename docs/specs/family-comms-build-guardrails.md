# Family Comms — Build Guardrails

**Written 2026-06-02 by Claude after the FA26 ship marathon.**

Honest postmortem of mistakes I made today. Read this BEFORE writing any code for Family Comms or its sub-features. Each item came from a real bug Jessica had to surface, costing her hours of test-iterate cycles.

---

## 1. "Done" never means "code committed" — it means "I looked at the output"

The single biggest cause of the parade today. I'd write code, claim done, and Jessica would find a bug by clicking through the actual flow.

**Before saying any user-facing change is ready:**

- **HTML output** — render it in an iframe (or query the DB row and inspect the rendered HTML). Check for stripped tags, broken anchors, double-escaped entities (`&lt;strong&gt;`), malformed attributes.
- **DB writes** — SELECT the row back. Verify every column matches expectation.
- **UI components** — manually trace each conditional render: empty state, loading state, error state, full-data state. Never silently hide a UI element when data is missing — show a disabled/empty-state component instead.
- **Multi-step flows** — walk the entire path from fresh state to completion. Not just the happy path.
- **Edge functions producing text** — invoke with realistic data, READ the response. Don't trust 200 status.
- **Ennie's outputs specifically** — after any prompt change, query 3-5 actual generated bodies and read them line-by-line against grounded facts.

Bugs that violated this rule today: malformed anchor tags from a token highlighter, silently-hidden preview dropdown, `<strong>` rendering as literal text in VIP block (then again in curriculum minutes later), Ennie inventing "real tools" / "every session wraps with a project", stale "Chunk 06 mock" footer in production, sign-off duplicating org name.

---

## 2. Deploy state is part of "done"

I caused Jessica to test prod with stale frontend for an hour because I committed locally but never pushed.

**After every `git commit` touching frontend:**
1. `git push origin main`
2. Confirm Netlify built the new commit (use `deploy-verify` skill or wait ~90s + curl the JS bundle)
3. Only THEN tell the user to test on prod

**Edge functions:**
- `npx supabase functions deploy <name>` is enough. No Netlify wait.
- But verify the version on the Supabase dashboard incremented.

**Migrations:**
- Apply via MCP (`apply_migration`) AND commit the SQL file to `supabase/migrations/` for source control. Both. Not one.

**Build before push:**
- `npm run build` — Vite production mode is stricter than dev. Catches issues dev silently allows.

---

## 3. Schema gates before any DB write

Three different gates can reject a query. Distinguish them by error message:

| Error message | Gate | Fix |
|---|---|---|
| `permission denied for table X` | GRANT (SQL-level) | `GRANT SELECT, UPDATE on X to authenticated;` |
| `new row violates row-level security policy` | RLS check expression | Update policy or fix the data being inserted |
| `new row for relation X violates check constraint "Y_check"` | CHECK constraint (column-level) | Query `pg_constraint` for allowed values; fix the data |
| 0 rows returned, no error | RLS silently filtered OR GRANT missing for SELECT | Try as service-role to confirm the row exists |

**Before any non-trivial INSERT or UPDATE the user will trigger:**
```sql
-- CHECK constraints (enums often hide here):
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'TABLE_NAME'::regclass and contype = 'c';

-- GRANTs for the authenticated role:
select privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'TABLE_NAME' and grantee = 'authenticated';

-- RLS policies:
select policyname, cmd, pg_get_expr(polqual, polrelid) from pg_policies pp
join pg_policy p on p.polname = pp.policyname where tablename = 'TABLE_NAME';
```

Bugs that violated this rule today: `source='registration'` blocked by CHECK constraint (allowed value was `enrops_registration`), Approve flow blocked by missing GRANT on `marketing_campaigns` (which I misdiagnosed as RLS for hours).

---

## 4. Multi-tenant safety — never hardcode tenant identity

**NEVER in shared code:**
- Tenant slugs (`'j2s'`, `'journey-to-steam'`)
- Tenant UUIDs (`1adf10ad-d091-4aa0-82e3-af331468ea2b`)
- Tenant brand strings ("STEAM VIP", "Journey to STEAM", domain names like `journeytosteam.com`)

**Tenant-specific content lives in `organizations.*` columns:**
- `brand_voice` JSONB (closer, tone, do_use, do_not_use)
- `vip_offering` JSONB (enabled, label, price_cents, description, excluded_location_ids)
- `default_sender_name`, `default_sender_email`, `logo_url`, etc.

**Service-role functions must explicitly filter by `organization_id` on every query.** RLS is bypassed under service-role, so the safety has to live in the code.

Use the `tenant-rls-audit` skill before pushing changes that touch DB queries or operator-facing copy.

Bugs today: VIP language ("STEAM VIP at $720") hardcoded in the multi-tenant Ennie prompt; placeholder URL `https://journeytosteam.com/summer-camps` in Q4 field for every tenant.

---

## 5. Scale gotchas (mostly already-burned lessons — don't re-burn them)

- **`.in("col", bigArray)`** — PostgREST puts the array in the URL query string. ~500 UUIDs is a safe ceiling. Above ~700 you'll silently get empty results or 414. Chunk by 500 client-side.
- **Sequential loops over recipients** — edge functions have a 150s hard timeout. At 350ms per Resend call × 700+ recipients you blow it. Parallel batches of 25 with `Promise.all` gets ~30s total.
- **One INSERT per row in a loop** — bulk-insert the batch. Same parallel pattern.

---

## 6. Token resolution and HTML rendering — three traps

These bit me three separate times today, twice the same way:

### A. Tokens that emit HTML must bypass `escapeHtml`
The default `replaceTokens(text, tokens, { html: true })` escapes every value. If a token resolves to `<strong>X</strong>`, escape turns it into `&lt;strong&gt;X&lt;/strong&gt;` and the parent sees literal text.

**Add such tokens to `PRE_RENDERED_HTML_TOKENS`** in `marketing-touchpoint-send/index.ts`. Currently `vip_block` and `curriculum` are in this set. When you add a new token that emits HTML, add it here too. Don't just add it to `APPROVED_TOKENS` and move on — that's a duplicate of where it already lives.

### B. Token highlighters / regex passes shouldn't run inside HTML attributes
`highlightTokens` was wrapping `{{token}}` in a `<span>`. Inside `<a href="{{register_url}}">...</a>` that produced `<a href="<span>...</span>">...` which browsers parse unpredictably — anchor tags vanished, hrefs leaked as text.

**Pattern that works:** `replace(/\{\{(\w+)\}\}(?![^<]*>)/g, ...)` — the negative lookahead skips tokens whose next `>` isn't preceded by a `<` (i.e. tokens inside attribute values).

### C. Preview iframes need `<base target="_blank">` + sandbox flags
`sandbox=""` (most restrictive) blocks ALL navigation. Clicking a link inside takes the iframe to a blank state. Fix:
- Inject `<base target="_blank">` into the preview HTML's `<head>` (server-side, preview-only — NOT in real send bodies)
- Set iframe `sandbox="allow-popups allow-popups-to-escape-sandbox"` so the new tab actually opens

---

## 7. Honest copy — every operator-facing string

Before shipping any operator-facing string:

**Two questions:**
1. Is what this says actually TRUE today? (Not "after the next chunk" — today.)
2. If the operator clicks/follows this, does the destination exist and work?

Lying examples we shipped earlier today:
- "Email + parent portal" (no portal exists)
- "Back to campaigns" (no campaigns list page exists — went to a refresh)
- "We'll keep going either way" on drafting screen (state isn't resumable; navigating away cancels)
- "Chunk 06 mock — real approval flow lands in chunk 07" (literal dev mock left in production)
- `/admin/marketing` route used in a button after the route was retired
- "Mention our STEAM VIP full-year option, $720 total" as an operator_notes hint AFTER VIP was centralized in `org.vip_offering`

**Also:**
- Use `<Link to>` for SPA nav, never `<a href>` (full page reload kills state)
- Match URL slugs to sidebar labels (`/marketing-v2` after we renamed to "Family Comms" was bad)
- No tech jargon in operator-facing strings — "_internal_admin", "Dedup is per-campaign right now", "admin bootstrap" all leaked today

---

## 8. Patch vs fix — investigate root cause first

When something fails unexpectedly:
- Investigate WHY before adding a workaround
- "Transient" failures are almost never transient — they're consistent bugs you haven't found
- Adding a parallel solution alongside the existing one is hedging, not fixing — pick one, make it right

Today I added a parallel RLS policy "in case the function-based one was failing intermittently." It turned out the failure was a missing GRANT (different gate entirely). I'd hedged when I should have investigated.

**Rule of thumb:** if a fix you're considering would leave the original broken code in place "just in case", you don't understand the bug yet.

---

## 9. Ennie's outputs require active auditing

Ennie hallucinates plausibly. The hallucinations look right at a glance but are wrong against the data:

- "**Real tools**" / "hands-on tools" — wrong for software-based curricula (Minecraft, Block Coding). Only safe if `curriculum_detail` names a physical tool.
- "**Every session wraps with a finished project**" — wrong for multi-week builds. Only safe when the curriculum's `format` field describes per-session deliverables.
- "**Finished project to show off at the end**" — only when `final_showcase` field is set.
- **Specific outcomes** ("your child will master Python") — banned by existing prompt rule; describe what they DO, not what they BECOME.

**After any prompt change to `marketing-draft-campaign`:** redraft a campaign with real data, query the latest 2-3 bodies, read line-by-line against grounded facts. Flag any concrete claim that doesn't map to a data line.

The `GROUNDED LANGUAGE TEST` rule was added today — Ennie should refuse to make specific claims without data backing.

---

## 10. Batch the audit; don't iterate

The pattern that caused the marathon today: I'd fix bug N, claim done, Jessica would find bug N+1, I'd fix, claim done, repeat. ~25 round-trips.

**The fix:** when a multi-step build is "feature-complete", do ONE comprehensive sweep through items 1-9 above. Find everything at once. Fix everything at once. Ship once.

For the Q1 redesign build specifically — after step 6 (end-to-end test) in the build sequence, do this sweep before declaring done. Don't ship piecemeal.

---

## Quick reference: tools that catch these things

- **`deploy-verify`** skill — confirm Netlify deployed before testing prod
- **`tenant-rls-audit`** skill — scan for hardcoded tenant identity + multi-tenant safety issues
- **`code-review`** skill — independent diff review at high effort
- **`verify`** skill — actually run the app and observe behavior
- **Supabase MCP** — query `pg_constraint`, `pg_policies`, `role_table_grants` directly; run `apply_migration` and `execute_sql` against the live project

---

## What to NOT carry forward

A few patches I made today should be cleaned up if you touch them:

1. **`buildVipBlock` has hardcoded "🔑 Want the full year?" wrapper** — works for J2S, wrong for a tenant whose VIP isn't year-shaped. Backlog'd; let `org.vip_offering.description` be the entire paragraph.
2. **`{{sender_name}}` strips " @ Org" suffix in body context** — convenience hack so J2S's "Jessica @ Journey to STEAM" From-header value renders as "Jessica" in sign-offs. Works for now; cleaner answer is a separate `default_sender_short_name` column.
3. **`alert()` everywhere** — replace with a real Toast/Banner component (backlog'd; was punted for FA26).
