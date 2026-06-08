# How Enrops Keeps Every Provider's Data Safe

**A plain-language security overview**
_Last updated: 2026-06-08 · Prepared for review by our security consultant · Also suitable for sharing with prospective providers_

✅ = in place today &nbsp;&nbsp;|&nbsp;&nbsp; ❌ = not built yet (scheduled before our July 3 launch) &nbsp;&nbsp;|&nbsp;&nbsp; 🔭 = recommended next (post-launch maturity)

---

## The short version

Enrops is a shared platform that many independent enrichment providers ("tenants") use to run their businesses. The promise underneath all of it: **one provider can never see another provider's families, instructors, money, or documents** — and the most sensitive records (children's information and background checks) are locked down tighter than anything else.

Three principles guide every decision:

1. **Walled gardens.** Each provider's data is isolated at the database level, not just hidden in the app.
2. **Least privilege.** Every account — and every piece of automation — can touch only what it genuinely needs.
3. **Card data never lives here.** Payments and payouts run through Stripe, so the most dangerous data never touches our servers.

---

## 1. Keeping each provider's data separate

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Row-Level Security on 100% of data tables.** Every table that holds business data enforces "you may only see rows that belong to your organization" at the database itself — verified, zero exceptions. |
| ✅ | **Tenant isolation tested**, not just assumed. We confirmed one provider's login cannot reach another provider's records. |
| ✅ | **Separate test environment** using fake people and synthetic data, so real families' information is never used for testing. |
| ✅ | **Cross-tenant analytics are aggregate-only and contain no personal information** (used to improve the platform, never to expose individuals). |
| 🔭 | **Automated isolation testing on every update.** An automatic check that re-proves one provider cannot see another's data each time the software changes — so a future code change can't silently weaken the wall. (This is the safeguard that would catch a leak like the two views we found and fixed on 6/6, *before* it ever reaches production.) |

## 2. Who can see and do what

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Role-based access** (owner, admin, instructor, parent) enforced at the database, so a parent can only see their own child, an instructor only their own classes, and so on. |
| ✅ | **Least-privilege cleanup.** We actively remove permissions that aren't needed — e.g., we recently stripped unused write-access from a payments helper table even though other locks already blocked it. |
| ✅ | **Internal access functions reviewed.** The behind-the-scenes functions that decide "is this person allowed?" were audited line-by-line and confirmed to return only the requester's *own* status — never anyone else's data. |
| ✅ | **Public surface scanned for leaks — and the scanning works.** We proactively scan the parts of the system reachable from the internet, and real issues have been found and **closed the same day**: two database views that could have exposed instructor pay and program fill-rates across providers (fixed 2026-06-06), and a contact report (fixed 2026-06-04). |
| ✅ | **Automated security scans run regularly** against the live database to catch new gaps after every change. |

## 3. The most sensitive records: children & background checks

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Children's information** (names, parents, schools, registrations) is locked to the single provider that serves that family. |
| ✅ | **Background-check documents** are stored in a **private** vault, accessible only to the instructor themselves and the admins of their own organization. |
| ✅ | **No back-door links.** We confirmed there's no way to bypass those locks through a shareable file link. |
| ❌ | **Tighten file-access role** from "anyone with a key" to "signed-in users only" on storage (extra layer; locks already hold today). |
| ❌ | **File-type allowlist on uploads**, so only expected document types can be uploaded. |

## 4. Payments & payouts

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Card numbers never touch Enrops.** All payments are handled by Stripe, the same payments provider used by millions of businesses, certified at the highest card-security level (PCI-DSS Level 1). |
| ✅ | **Instructor payouts run through Stripe Connect**, so bank details live with Stripe, not with us. |
| ✅ | **Payment notifications are signature-verified**, so a fake "payment succeeded" message can't trick the system. |

## 5. Encryption & secrets

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Encrypted in transit.** Every connection is protected with the same encryption (TLS/SSL) your bank uses. |
| ✅ | **Encrypted at rest.** Data sitting in the database and file storage is encrypted on disk. |
| ✅ | **Secrets kept in a dedicated vault**, never written into the app's code. |

## 6. Backups & recovery

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Point-in-Time Recovery.** We can rewind the entire database to any moment in the last 7 days, in 2-minute increments — protection against accidental deletion or a bad change. |
| ✅ | **Automatic daily backups** in addition to the above. |
| ❌ | **Off-site copy of uploaded files** (e.g., background-check documents). Database recovery does **not** cover uploaded files, so these need a separate backup — the one document type we can't simply regenerate. |

## 7. Login security

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Passwordless login.** We use one-time email links instead of passwords, so there's no reused password for an attacker to steal. |
| ❌ | **Two-factor authentication (2FA) for admin/operator logins** inside Enrops. The accounts that can see families and move money should require a second factor (a code from your phone). **Building before July 3.** |
| ❌ | **2FA on our backend consoles** (Supabase, Stripe, GitHub, Netlify). Quick provider-side toggles. **Doing before July 3.** |
| ❌ | **Shorten login-code expiry.** One-time email login codes currently stay valid longer than ideal; tightening the window is a quick settings change. **Doing before July 3.** |

## 8. Monitoring & oversight

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Automated weekly security audit.** Every Monday morning, an automated review scans the live production system for new vulnerabilities or misconfigurations and reports any findings in plain English — so security is monitored continuously, not checked once. |
| ✅ | **Key events logged immutably** (registrations, payments) in an append-only record with no personal information. |
| 🔭 | **Admin action audit trail** — a "who changed what, when" log for sensitive admin actions. |
| 🔭 | **Written incident-response plan** — a documented playbook for the unlikely event of a breach, including how/when families are notified. |
| 🔭 | **Independent penetration test** by an outside firm (this consultant review is the first external step). |

## 9. Infrastructure & compliance

| Status | What it means in plain English |
|:---:|---|
| ✅ | **Built on SOC 2 Type II–certified infrastructure** (our database/hosting provider is independently audited). |
| ✅ | **All data access flows through a permission-checked layer** — there's no "open door" to the raw database. |
| 🔭 | **Network restrictions** limiting direct database connections to known sources. |
| 🔭 | **Enrops's own SOC 2 certification** (a milestone for larger district partnerships down the road). |

---

## What's left before July 3 (the ❌ list)

These are the items to complete after Italy, before launch:

1. **Two-factor authentication for admin/operator logins** (in-app build).
2. **Two-factor authentication on backend consoles** (quick toggles: Supabase, Stripe, GitHub, Netlify, Resend).
3. **Off-site backup of uploaded files** (background-check documents especially).
4. **Tighten storage file-access role** to signed-in users only.
5. **File-type allowlist on uploads.**
6. **Shorten login-code (OTP) expiry** to under an hour (dashboard setting).

## Recommended next (🔭 — strengthens security over time; none blocking for July 3)

**Catching problems automatically**
- **Automated tenant-isolation testing** on every software update — re-proves one provider can't see another's data, and would catch a leak like the 6/6 views before it reaches production.
- **Dependency & code vulnerability scanning** — flags known security bugs in the third-party code libraries Enrops relies on (a tool for this is already available to us).
- **Secret scanning on the codebase** — ensures sensitive keys can never be accidentally committed to the code.

**Protecting the master keys**
- **Key-rotation runbook** for the all-powerful "service" key (the one that can bypass every lock) — a documented plan to rotate it fast if it's ever exposed.
- **Network restrictions** limiting direct database connections to known sources.

**Oversight & response**
- **Admin action audit trail** — a "who changed what, when" log for sensitive admin actions.
- **Written incident-response plan** — a documented playbook for the unlikely event of a breach, including how and when families are notified.
- **Independent penetration test** by an outside firm (this consultant review is the first external step).
- **Tested backup-restore drill** — confirming we can actually recover, not just that backups exist.

**People & compliance**
- **Clean admin offboarding** — a defined process to remove access when someone leaves.
- **Data retention & deletion policy** — how long records are kept, and honoring "delete my child's data" requests.
- **Subprocessor list + data-processing agreements** — the third-party services that handle data on our behalf (Stripe, Supabase, Resend, Checkr, Netlify), with signed agreements.
- **Enrops's own SOC 2 certification** — a milestone for larger district partnerships down the road.

---

_This overview reflects the platform's verified state as of the date above. Technical items were confirmed directly against the live production database (Row-Level Security coverage, private storage buckets, recovery settings, and access-control functions) rather than from documentation alone._
