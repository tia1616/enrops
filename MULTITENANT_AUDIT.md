# Enrops Multi-Tenant Audit

Running list of hardcoded J2S references that need extraction to config/DB before tenant 2 onboards (target: July 31, 2026).

## Frontend
- [ ] Home.jsx has J2S-hardcoded copy, hero, tagline
- [ ] Home page term filter is FA26-only
- [ ] tenants.js district map is J2S-only

## Pricing & terms
- [ ] Term codes (FA26, SP26, WI27) are J2S-specific naming conventions
- [ ] VIP $240/term pricing hardcoded
- [ ] Distance bonus amount `5000` cents hardcoded in DB trigger — should be `organizations.default_distance_bonus_cents`
- [ ] Cycle naming logic (`SU26` → "Summer 2026") works for J2S's quarter system, may break for tenants on different cadences

## Email & comms
- [ ] Email templates name J2S explicitly in body copy
- [ ] Resend send domain `updates.journeytosteam.com` — needs `org_branding.send_domain` per-tenant

## Cron & scheduling
- [ ] Reminder cron deadline (3 days) hardcoded — fine for v1, revisit before tenant 2

## Curricula Onboarding — Chunk 2 (2026-05-14)
- [ ] (Append any new hardcoded references found or introduced during this chunk)
