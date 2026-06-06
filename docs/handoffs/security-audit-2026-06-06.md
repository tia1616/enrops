# Enrops production security sweep — 2026-06-06

**Project:** Enrops prod (`iuasfpztkmrtagivlhtj`). Read-only sweep. Nothing was changed.
**Run by:** Claude (manual, on Jessica's request). First run of the weekly audit pattern.

> **RESOLVED 2026-06-06:** Findings #1 and #2 (the two SECURITY DEFINER views) were fixed the same day — switched to `security_invoker` on prod + staging via migration `20260606_security_invoker_leaky_views.sql`. Advisor ERRORs cleared. Only the LOW-priority hardening items (#3) remain open.

## Headline
The sensitive stuff is locked. Two database **views** punch a hole through tenant isolation and need attention — one of them exposes **instructor pay data to the public**. No children's-PII leak found (the contractor-documents BGC bucket is private; registrations/students remain org-scoped).

---

## Findings, by priority

### 1. HIGH — `v_effective_pay_lines` exposes instructor pay to anyone
- It's a `SECURITY DEFINER` view, so it **ignores row-level security** and runs with creator privileges.
- It's granted `SELECT` to **`anon`** (not even signed in) and `authenticated`.
- It exposes instructor compensation across **all tenants**: `pay_amount_cents`, adjustments, instructor IDs, payout IDs, org_id, session dates.
- The underlying tables DO have RLS — the view bypasses it.
- **Fix (needs approval):** convert the view to `SECURITY INVOKER` (so the caller's RLS applies), or revoke `anon`/`authenticated` SELECT and serve it through a scoped path. Verify the app still reads pay correctly afterward.

### 2. MODERATE — `program_enrollment` exposes every tenant's fill rates publicly
- Same pattern: `SECURITY DEFINER` view, `SELECT` granted to `anon` + `authenticated`, no org filter.
- Exposes program names, school/location names, capacity, enrolled counts, spots remaining — for **all tenants**, to the public. No child PII, but this is competitive/fill-rate data (part of the moat).
- Likely intended to power a public "spots remaining" badge, but as written it leaks every org's numbers.
- **Fix (needs approval):** `SECURITY INVOKER` + tenant scoping, or a dedicated scoped function for the public registration page.

### 3. LOW — config & hardening (advisor WARN/INFO)
- ✅ **FIXED — 4 functions with mutable `search_path`** (`set_automations_updated_at`, `program_locations_partner_same_org`, `check_camp_assignment_conflict`, `compute_distance_bonus`) — pinned to `public` (migration `20260606_pin_function_search_paths.sql`).
- ✅ **FIXED — public buckets allow listing:** dropped the broad SELECT policies on `org-assets`/`public-assets` (migration `20260606_stop_public_bucket_listing.sql`). Public CDN URL serving unaffected.
- ⏳ **Auth OTP expiry > 1 hour** — NOT SQL-fixable via MCP. Jessica: Dashboard → Authentication → Providers → Email → set OTP expiry < 3600s.
- 🛑 **Extensions in `public`** (`pg_net`, `citext`) — DEFERRED on purpose. Moving extensions risks breaking the `citext` column type and `pg_net` webhook calls for ~zero security value.
- ℹ️ **14 "SECURITY DEFINER function executable" warnings** — left intentionally. These RLS helpers are called inside policy predicates, so the querying role must keep EXECUTE or RLS breaks. They return only caller facts.

---

## Confirmed SAFE (don't be alarmed by the warning count)
- **The 14 "SECURITY DEFINER function executable" warnings** are RLS helper functions (`is_org_member`, `is_org_owner_or_admin`, `is_platform_admin`, `user_org_ids`, `current_parent_id`, `check_org_access`, `link_parent_to_auth_user`). They return only facts **about the caller** (their own org membership/ids) or are triggers — no cross-tenant data. This is the standard, correct Supabase RLS pattern. Optional: revoke `anon` EXECUTE to quiet the advisor.
- **`contractor-documents` (background checks) bucket is PRIVATE** ✓. `curriculum-documents`, `program-documents` also private ✓.
- **`checkout_schedules`** has RLS on with no policy → **default-deny / locked** (only service_role). Safe; confirm the app doesn't need client-side reads.
- **`intelligence.enrollment_events`** RLS on, no policy → intentional (the moat doorway is service_role-only).

---

## vs. the 2026-06-04 baseline
The baseline (sensitive-data posture) confirmed students/registrations/BGC are tenant-isolated — still true. The two SECURITY DEFINER **views** were not captured in that baseline; they are the new actionable items. After fixing, update `project_enrops_sensitive_data_posture.md`.
