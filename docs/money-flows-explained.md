# How Money Flows In and Out of Enrops

*A plain-language guide for understanding and explaining the money side of the platform.*
*Written 2026-06-08. Numbers verified against the live production database and the actual payment code.*

---

## The one idea to hold onto

**Enrops never holds your money.** This is the single most important thing to understand, and the thing that makes everything else make sense.

Think of Enrops like a really smart cash register and bookkeeper sitting on top of *your own* Stripe account. When a parent pays, the money lands in **the operator's** bank account (through their own Stripe account), not Enrops'. When an instructor gets paid, the money leaves **the operator's** balance, not Enrops'. Enrops just takes a small slice as it passes through, and keeps the records straight.

Why this matters when you explain it:
- The operator (the enrichment business) is the "merchant" — they are legally the one selling to parents. That means **they** own the customer relationship, the tax responsibility, and the risk if a card is disputed. Enrops is the tooling, not the bank.
- It keeps Enrops out of a whole category of legal and regulatory headaches (holding other people's money is heavily regulated). This is the standard, safe way modern software platforms handle payments.

Everything below is just the detail of *how* the money passes through.

---

## Part 1 — Money coming IN (parents paying for programs)

### 1a. A parent registers and pays — **LIVE** ✅

This has been live with real money since **June 3, 2026**.

Here's the journey of a single payment:

1. A parent fills out the registration form on the operator's Enrops page and clicks pay.
2. Enrops sends them to a secure **Stripe Checkout** page to enter their card.
3. The money is charged and routed **straight into the operator's own Stripe account** (this is a Stripe feature called a "destination charge" — the operator is the destination).
4. As the money passes through, two slices come off the top:
   - **Stripe's processing fee** (roughly 2.9% + 30¢ on a card — this is Stripe's standard charge, not Enrops').
   - **Enrops' platform fee** (see the numbers below).
5. The operator keeps the rest. Enrops records the registration, the child, the program, and the payment automatically.

**The card statement** the parent sees shows the operator's business name (e.g. "Journey to STEAM"), not "Enrops." Good for the operator's brand and reduces "what is this charge?" confusion.

### 1b. Payment plans / installments — **LIVE** ✅

Parents can choose to split a payment into **3 installments** instead of paying all at once.

- They pay the first installment today, and their card is securely saved.
- Enrops automatically charges installments 2 and 3 on their due dates — the parent doesn't have to do anything.
- Each installment takes its own small Enrops fee as it processes.

This is a real selling point for families and is fully working.

### 1c. What Enrops actually earns on each payment — **the real numbers**

These are the live settings in production right now:

| | Rate | Cap (maximum) |
|---|---|---|
| Card payment | **2%** | **$5.00 per transaction** |
| Bank transfer (ACH) | **0.5%** | **$5.00 per transaction** |

So on a **$300 camp paid by card**: 2% would be $6, but the cap kicks in, so **Enrops earns $5.00**. On a $150 after-school program: 2% = $3, so Enrops earns $3.

**Who pays Enrops' fee today?** Right now it's set so the **operator absorbs** the Enrops fee (a setting called "fee pass-through" is turned OFF). The parent pays the program price; the operator's take is reduced by Enrops' slice. There's a built-in option to flip this so the parent pays the fee instead — it just isn't switched on. (See the suggestions section.)

This is the "**Free to start. We earn when you earn.**" model — no upfront cost to the operator, Enrops only makes money when a real registration with real money happens.

---

## Part 2 — Money going OUT to instructors (payroll)

After camps and classes run, the operator owes their instructors. Enrops calculates exactly who is owed what (flat day rates for camps, per-session rates for after-school) and then pays them one of **three ways**.

Again: the money leaves the **operator's** Stripe balance, never Enrops' bank account.

### Route 1 — "I paid them outside Enrops" (manual record) — **LIVE** ✅

The operator pays the instructor however they already do — Gusto, a check, Venmo, bank transfer — and then just **records in Enrops** that it's been paid, with a note. No money moves through Enrops; this is pure bookkeeping so the records stay complete. **Available to every tenant today.**

### Route 2 — Pay instantly through the operator's own Stripe — **LIVE (J2S only)** ✅

The operator clicks "Pay via Stripe" and the money is sent directly from their Stripe balance to the instructor's connected Stripe account. The instructor gets paid into their bank.

The catch: this currently only works for **Journey to STEAM**, because J2S happens to run its own Stripe "platform" set up earlier (a technical arrangement called `legacy_own_platform`). It's been tested end-to-end with a real $1 payout. **A brand-new tenant cannot use this route yet** — see Route 3.

### Route 3 — "Enrops moves the money" — **COMING SOON** 🔜

This is the route a normal new tenant *will* use. The idea: instructor pay is sent automatically from the operator's Enrops-connected balance (the money that built up from parent payments) to the instructor — all inside the Enrops system, no separate Stripe platform needed.

**It is not built yet.** The code is sketched in but deliberately switched off — if you try it, the system returns a polite "this payout route isn't supported yet" message. **This is the single biggest gap for onboarding tenant #2.** (More in the suggestions section.)

> **So, for a brand-new tenant today:** they can take money IN through Stripe immediately, but the only way to pay instructors OUT is the **manual record** route until Route 3 ships.

---

## Part 3 — Money going BACK OUT to parents (refunds & cancellations)

When a family cancels, the operator can refund them. The refund flows backward through the same Stripe pipe, back to the parent's card.

Enrops has a built-in **cancellation admin fee** — for Journey to STEAM it's set to **$35.00**. The pattern the team uses: if a parent cancels and the operator keeps roughly $35 while refunding the rest, that's treated as a cancellation-with-admin-fee (the child comes off the roster). A small refund that keeps most of the money is treated as a discount (the child stays). This admin fee is configurable per tenant.

---

## Part 4 — How Enrops itself makes money (the business model)

Putting it together, **today** Enrops' revenue is essentially one thing:

- **The platform fee on every registration payment** (2% card / 0.5% bank, capped at $5 each).

There is no monthly subscription fee being charged today. The longer-term vision includes a paid "**Boss Mode**" tier (premium AI features) on top of the always-free base — but that's not switched on yet. The free tier is intentional: it gets operators in the door, and Enrops earns as they earn.

---

## Quick reference: what's LIVE vs COMING SOON

| Money flow | Status |
|---|---|
| Parent pays full price by card → operator's Stripe | ✅ **Live** (June 3) |
| Parent pays in 3 installments | ✅ **Live** |
| Enrops takes its 2% / $5-cap platform fee | ✅ **Live** |
| Operator records a manual instructor payment | ✅ **Live** (all tenants) |
| Operator pays instructor via their *own* Stripe | ✅ **Live** (J2S only — special setup) |
| **Enrops auto-pays instructors for any tenant** | 🔜 **Coming soon** (switched off, returns "not supported") |
| Refund a parent (with optional admin fee) | ✅ **Live** |
| Pass Enrops/card fees to the parent instead of operator | ⚙️ **Built but turned off** |
| Paid "Boss Mode" subscription tier | 🔜 **Future** |

---

## Part 5 — Sanity check: is this how the industry does it?

**Short answer: yes, the architecture is solid and standard. The pricing is unusually generous (maybe too generous), and there's one important gap.**

### What's done the right way ✅

- **Enrops never holding the money (destination charges + operator as merchant of record).** This is *exactly* how respected marketplace and platform companies do it — Stripe built "Connect" specifically for this, and it's the same pattern used by Sawyer, CampMinder, Jackrabbit, and most modern enrichment-software companies. It keeps Enrops clear of money-transmitter regulation and puts tax/chargeback responsibility where it belongs (the operator). This is the part that's hardest to get right, and it's right.
- **The operator's name on the card statement.** Standard best practice, reduces disputes.
- **Installments via saved cards charged automatically.** Standard and a genuine competitive feature.
- **A cancellation admin fee.** Completely normal in the camps/enrichment world.
- **Calculating exact pay automatically and then paying through Connect transfers.** This is the standard, correct direction.

### Where I'd push back or flag a risk ⚠️

1. **Your pricing is very thin — possibly too thin.** A $5 cap means on a $300 camp you earn **1.6%**, and on a $600 camp you earn **0.8%**. Meanwhile Stripe's own processing fee (~2.9% + 30¢) is *larger than your entire take*. Most comparable platforms charge **3–6%**, or a per-registration fee of **$1–$3 with no cap**, or a monthly subscription, or some combination. A $5 cap is a great *adoption* tool for a white-glove alpha, but it will not fund the business at scale. **This is fine as an intro rate — just make sure it's a deliberate, temporary choice, not a permanent default.**

2. **The operator currently eats both fees.** Because pass-through is off, the operator absorbs Stripe's ~3% *and* your 2%. That's ~5% off their revenue. Many competitors let the operator pass a "convenience fee" to the parent at checkout. You already built the toggle — consider whether absorbing the fee is the message you want, or whether pass-through should be the default.

3. **The payroll gap is the real blocker.** Today a brand-new tenant can collect money but can only pay instructors *manually*. The automatic "Enrops moves the money" route (Route 3) is the one a normal tenant needs, and it's switched off. For tenant #2 this will be felt immediately. Of everything here, **this is the thing most worth finishing.**

---

## Part 6 — Concrete suggestions

In rough priority order:

1. **Finish "Enrops moves the money" payroll (Route 3) before onboarding tenant #2.** Without it, every new tenant is stuck on manual payouts. This is the biggest functional gap, not a pricing nicety.

2. **Decide your real pricing on purpose.** Model a few scenarios (a $300 camp, a $150 class, a $600 full-summer registration) at: current 2%/$5-cap, vs. 3% no-cap, vs. a flat $2/registration. Pick the number that funds the business, and treat the current generous rate as a named "alpha intro rate" with an end date. *(This is a decision for you, not something I should pick.)*

3. **Reconsider fee pass-through.** Letting operators optionally pass the platform/card fee to parents is industry-standard and removes the "Enrops costs me money" objection. The toggle exists — the question is just what the default should be.

4. **Nail down the refund edge cases.** When you refund a parent, make sure (a) Enrops' platform fee is refunded proportionally, and (b) if the instructor was *already paid* for that child, the system flags or reverses that. Money flowing backward is where bookkeeping bugs hide.

5. **Think about chargeback risk and reserves.** Because the operator is the merchant of record, a disputed charge weeks later pulls money from *their* balance — possibly after they've already paid the instructor. Worth a short written policy on how that's handled before it happens for real.

---

## A 30-second version you can say out loud

> "Enrops sits on top of each business's own Stripe account. When a parent pays, the money goes straight to the operator — Enrops just takes a tiny 2% slice (capped at $5) as it passes through, and records everything. Parents can pay in installments. When it's time to pay instructors, Enrops figures out exactly who's owed what; today the operator either records that they paid outside the system, or — for us — pays instantly through Stripe. The 'Enrops pays your instructors automatically' button is the next big thing to finish. We never hold anyone's money, which keeps us safe and keeps each business in control of their own brand and bank account."
