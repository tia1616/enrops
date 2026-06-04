# Staging rebuild recipe

How the isolated **staging** Supabase project (`mumfymlapolsfdnpewci`) was built from
**prod** (`iuasfpztkmrtagivlhtj`), and how to rebuild it. Built 2026-06-04.

Staging = real J2S **catalog/config** mirrored from prod (PII/secrets scrubbed) + **100%
synthetic people**. No real families, children, instructors, registrations, or background
checks ever cross over.

> **Do NOT commit the data dump.** `.tmp/catalog_data.sql` (generated in step 3) contains
> real venue contact info — it's gitignored on purpose. Re-generate it from prod each rebuild.

## Order

1. **Schema** — restore `prod_baseline_2026-06-04.sql` (a `pg_dump --schema-only -n public
   -n intelligence -n private` of prod) into a fresh project via `psql`.
   - Pre-enable extensions to match prod: `citext` (in `public`), `pg_net`, `pg_cron`.
   - The baseline already has the psql `\restrict` lines and `ALTER DEFAULT PRIVILEGES`
     lines stripped (the latter fail under the locked-down `postgres` role).

2. **ACL reconcile** — run `staging_acl_reconcile.sql`. **Required:** a fresh Supabase
   project re-grants `anon`/`authenticated` on every restored object via project-level
   default privileges, silently unlocking what prod had explicitly REVOKEd. This re-locks
   them (the moat doorway, vault fns, PII views, marketing tables, program_locations cols).

3. **Real catalog/config** — copy from prod (data-only, whitelist of non-PII tables):
   ```
   pg_dump --data-only --no-owner --column-inserts --rows-per-insert=50 \
     --table=public.organizations --table=public.org_branding ... (28-table whitelist) \
     "<prod conn>" -f .tmp/catalog_data.sql
   ```
   Strip the `\restrict` and `SELECT ... set_config('search_path','',false)` lines
   (UTF-8-safely), then run `load_catalog.sql` (drops FKs, loads, nulls dangling auth refs,
   scrubs org secrets + venue contacts, re-adds FKs). It sets `search_path=public` so
   validation triggers resolve.

4. **Storage policies** — generate from prod with `gen_storage_policies.sql` (run against
   prod, `psql -t -A`), then apply the output to staging. Recreate the 5 buckets separately.

5. **Synthetic people** — run `staging_people_seed.sql` (fake instructors/parents/students/
   registrations linked to the REAL catalog; J2S org `1adf10ad-d091-4aa0-82e3-af331468ea2b`;
   creates auth-user logins). Idempotent.

   *(`staging_seed.sql` is an earlier standalone-synthetic variant — a fully fake org with no
   prod catalog. Superseded by steps 3+5; kept for reference.)*

## Other staging setup (not in these scripts)
- Edge functions: deploy via `npx supabase functions deploy <fn> --project-ref
  mumfymlapolsfdnpewci --use-api` (no Docker). Stripe chain (create-registration,
  create-checkout, stripe-webhook) deployed; secrets `STRIPE_SECRET_KEY` (test) +
  `STRIPE_WEBHOOK_SECRET` set; staging org forced to direct charges.
- Netlify: separate site, `staging` branch, env → staging Supabase URL + anon key.
