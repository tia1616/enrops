# Enrops — Sensitive-Data Security Sketch (BGC + minors + PII)

**Purpose:** the "think through every piece of sensitive data and prove it's secured" deliverable (pre-Italy item, due 6/9). Hand this to the consultant.
**Scope:** prod (`iuasfpztkmrtagivlhtj`). Enrops is multi-tenant; J2S is tenant #1. The hard rule everywhere: **a tenant can only ever see its own data; minors' info and background checks are the most protected.**
**Status:** posture is **clean and verified**, not assumed — every claim below was checked against the live database/storage. Last verified 2026-06-06.

---

## 1. What counts as sensitive here

| Category | Where it lives | Most-sensitive bits |
|---|---|---|
| **Minors' PII** | `students`, `registrations` (+ roster views) | child name, grade, age, allergies/notes, which school/class |
| **Background checks (BGC)** | `contractor-documents` storage bucket; `contractor_onboarding_status` (status only) | the Checkr report PDF; pass/fail |
| **Instructor PII** | `instructors`, contractor onboarding tables, `contractor-documents` | SSN-adjacent onboarding docs, CPR certs, signed agreements, pay |
| **Parent/guardian PII** | `parents`, `registrations` | contact info, payment history |
| **Payment data** | Stripe (tokenized) + `registrations`/payout tables | amounts, Stripe IDs (no raw card data — Stripe holds it) |
| **Instructor pay** | `payouts`, `v_effective_pay_lines` | per-instructor compensation |
| **Offer/assignment data** *(new, after-school + camps)* | `program_assignments`, `camp_assignments`, `instructor_offer_messages`, `instructor_term_availability`, `instructor_term_area_preferences` | who's offered/assigned which class; instructor↔admin messages |
| **Moat telemetry** | `intelligence.*` (sealed schema) | cross-tenant aggregates only; no PII |

---

## 2. How each is locked (verified)

- **BGC / contractor documents** — in the **private** `contractor-documents` bucket (`public = false`). Storage RLS on `storage.objects`: an instructor can read **only their own folder** (`(foldername)[1] = current_instructor_id()`, which is NULL for anon → anon blocked); an org owner/admin can read **only their own org's instructors**. No "any authenticated user" read. **No edge function mints a signed URL or downloads from this bucket** (grep-confirmed) — so there is no service-role bypass. The admin UI shows Checkr **status**, never the raw report.
- **Minors' data (`students`, `registrations`)** — RLS on, scoped to: the child's **parent**, an **org member** of that tenant, the **platform admin** (Jessica), or an **instructor assigned to that specific class** (incl. subs). Anon = 0 rows. Tenant-isolated.
- **Instructor pay** — `v_effective_pay_lines` and `program_enrollment` were `SECURITY DEFINER` views granted to `anon` (a real public leak of pay + fill-rates). **Fixed 2026-06-06** → `security_invoker` so caller RLS applies; anon/cross-tenant now get 0 rows.
- **Offer/assignment tables (new today)** — RLS on, verified policy predicates:
  - `program_assignments`: org members of the tenant (or platform admin) manage; an instructor can read **their own** assignments. ✓
  - `instructor_offer_messages`: org owner/admin of the tenant manage; instructor reads **their own** thread (camp **and** program). *(Fixed today — the self-read policy was camp-only, which RLS-blocked real after-school instructors from their own threads; now covers `program_assignment_id`.)*
  - `instructor_term_availability` / `instructor_term_area_preferences`: org members manage; instructor reads/writes **their own**. ✓
  - Offer-loop edge functions (`respond-to-assignment`, `send-afterschool-offers`, `offer-message-reply`) use the service role but **self-authorize**: instructor actions match `auth.uid → instructor`, admin/impersonation actions check `org_members.role IN (owner,admin)` for the assignment's org. No cross-tenant path.
- **Locked-by-default (RLS on, no policy = service-role only):** `checkout_schedules`, `intelligence.enrollment_events` (the moat doorway). Intentional.

---

## 3. Role → access matrix (the hand-to-consultant summary)

| Role | Minors' PII | BGC docs | Instructor pay | Other tenants |
|---|---|---|---|---|
| **anonymous** | none | none | none | none |
| **parent** | own children only | — | — | none |
| **instructor** | students in **own confirmed classes** only | **own** BGC/docs only | own pay only | none |
| **substitute** | students in the **subbed** class only | own only | — | none |
| **org owner/admin** | own org's students/regs | own org's instructors' docs | own org's pay | **none** |
| **platform admin** (Jessica) | all orgs | all | all | all (by design) |
| **service role** (edge functions) | full | full | full | full (server-side; each fn self-authorizes) |

---

## 4. Open hardening (deliberate — NOT live leaks)

1. **RLS policies are granted to the `public` role** (anon evaluates them and is blocked only by the predicates nulling out). Best practice = scope to `authenticated`. Whole-schema blast radius → careful staging-tested refactor, not a quick edit. *(Defense-in-depth; current predicates already deny anon.)*
2. **`contractor-documents` MIME allowlist** — `allowed_mime_types` still null; needs a HEIC content-type upload test on staging before locking (browsers are inconsistent). 25MB size limit is set.
3. **`pg_net` + `citext` extensions in `public` schema** — left on purpose (moving them risks breaking the `citext` column type + webhook calls for ~zero security value).
4. **14 "SECURITY DEFINER function executable" advisor warnings** — load-bearing RLS helpers (`is_org_member`, `is_platform_admin`, etc.); they return only caller facts and must keep EXECUTE or RLS breaks. Do not revoke.
5. **`instructor_offer_messages` instructor self-INSERT** stays camp-shaped — fine, because the after-school write path is the service-role `respond-to-assignment` edge fn (RLS-bypassing), not a direct client insert.

---

## 5. Standing rules (the guardrails that keep this true)

- Any **row-returning `SECURITY DEFINER` function _or view_** must self-check org/role or be service-role-locked. (A view leak — pay data to anon — was the 6/6 finding. Audit views too, not just functions.)
- New `public` tables get explicit RLS + grants from creation; run the **security advisor** after any schema change.
- Run the **weekly security sweep** (advisor + this checklist) — extend it to every new endpoint/table as it ships. This sketch was itself extended to today's after-school offer-loop tables and caught one real RLS gap.

**Provenance:** baseline verified 2026-06-04; weekly sweep + view fixes 2026-06-06 (`docs/handoffs/security-audit-2026-06-06.md`); after-school offer-loop surfaces verified + one gap fixed 2026-06-06 (migration `20260606_iom_instructor_self_read_program.sql`). Memory: `project_enrops_sensitive_data_posture`.
