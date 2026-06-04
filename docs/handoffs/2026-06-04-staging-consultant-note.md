# Enrops Staging — break-test guide (for Darren)

Hi Darren — here's the isolated staging site to poke at while Jessica's away.

## Everything you need

**Site:** https://enrops-staging.netlify.app

**Logins** — password is the same for all five: `EnropsStaging1`

| Role | Email | What it's for |
|---|---|---|
| Admin / operator | `admin@staging.enrops.test` | The operator app — rosters, scheduling, payroll, marketing, finances |
| Instructor | `instructor1@staging.enrops.test` | Instructor portal |
| Instructor | `instructor2@staging.enrops.test` | Second instructor (for cross-user access tests) |
| Parent | `parent1@staging.enrops.test` | Parent portal (has registrations to view) |
| Parent | `parent2@staging.enrops.test` | Second parent (for cross-family access tests) |

**Stripe test card** (payments are in test mode — no real money): `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP. (`4000 0000 0000 0002` simulates a decline.)

---

## What this is

An **isolated copy** of Enrops — same code, same database structure, access rules, and
storage policies as production, but:
- **All people are fake.** Every family, child, and instructor is fabricated
  (`@staging.enrops.test`). There is **no real customer data** anywhere.
- **It cannot touch production, real money, or real email.** Separate database, Stripe in
  test mode, no email sending. Break it freely.

The program catalog (curricula, venues, programs, camps) mirrors the real provider's setup
so it feels realistic.

## What we'd love you to do

1. **Roam every screen and try to break the UI** — weird inputs, huge values, empty states,
   rapid clicks, browser back/forward, deep links, refreshes mid-flow. Note anything that
   crashes, shows a raw error, hangs, or behaves oddly.
2. **Test the access controls — this is the priority.** Try to reach data you *shouldn't*,
   both in the UI and by calling the API directly:
   - As **parent1**, try to view **another family's child** (parent2's kids), or any
     roster/admin screen. You should get nothing.
   - As **instructor1**, try to view **another instructor's background check** or personal
     info, or browse the full list of children. You should get nothing.
   - **Logged out / direct API calls:** try to pull students, registrations, parents, or
     background-check records without signing in. You should get nothing.
   - Anything involving **minors' data or instructor background checks** is the most
     sensitive — reaching any of it from a role that shouldn't have it is the most important
     kind of finding. (Also worth probing: any endpoint that returns *all* minors at once
     rather than in pages.)
3. **Exercise the money path** — register a fake child and pay with the test card above.
   Try to break registration/checkout however you like.
4. **Report what broke and how you got there** — steps to reproduce, screenshots, the
   URL/role you used. (Data is fake, so paste anything you see.)

## Known / expected (not bugs)

- **Instructor payroll payouts and email/marketing "send" buttons may error or do nothing** —
  those backends aren't wired in staging on purpose (no real payouts or emails). A one-line
  note is plenty; no need to dig into those.
- Some uploaded files/documents are missing — staging has no uploaded files.

## How to report
Keep a running list (doc or email): what you did → what you expected → what happened →
how bad it seems. Send it to Jessica.
