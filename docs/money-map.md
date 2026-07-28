# Enrops Money Map

*How money moves through Enrops — for providers and for the Enrops team. This is the source for the in-app PDF (Settings / Money tab) that will be built once all the money pieces are live. Keep it updated as each piece ships.*

*Dollar examples use a $200 registration for illustration. Your actual fee is whatever is set on your account.*

---

## How a registration dollar flows

| Purpose | Direction | If you collect through Enrops (Stripe connected) | If you run money outside Enrops | Built? |
|---|---|---|---|---|
| **Parent registration** | IN | Parent pays your listed price. Stripe's card fee (~2.9% + 30¢) and Enrops's 1% come out of your payout. You keep the rest. | Calculator only — you take payment your own way and mark it paid by hand. | ✅ Built |
| **Refund / withdrawal** | OUT | You refund any amount from the Rosters drawer. The parent is made whole; the registration money is pulled back from your account. **Stripe does not return its original processing fee on a refund — for now Enrops absorbs that small cost, so you are not out-of-pocket on the processing fee for an early refund.** | Refund the parent your own way; mark it in Enrops. | ✅ Charge/refund built · refund fee-handling finalized later |
| **Partner remittance** (you OWE a partner a split) | OUT | Enrops computes what's owed; you pay by check or recorded ACH. Not a Stripe feature. | Same tracker, marked by hand. | ⏳ Not built |
| **Partner invoice** (a partner OWES you a fee) | IN | Send a Stripe invoice from **your own** account so schools/SUN can pay by ACH/check. Auto reminders + status. | Generate a record/PDF; payment tracked by hand. | ⏳ Not built |
| **Instructor payroll** | OUT | Transfer to the instructor's connected account. Transfer fee = $0; money comes from your Stripe **balance**, not your bank. | Record-only with a note. | ✅ Built |
| **Operating expenses** | OUT | Out of scope — your own bank/card. | Same. | — |
| **Accounting sync** (QuickBooks / Xero) | N/A | Enrops does **not** build a QuickBooks integration. It writes clean data onto every Stripe charge + offers a CSV export; an external connector carries it to your books. **You keep your existing accounting.** | CSV export your bookkeeper imports. | ⏳ Not built |

---

## The three numbers on every registration

1. **Parent pays your listed price** — clean, no surprise fee added at checkout.
2. **Stripe takes ~2.9% + 30¢** (card) or **0.8%, capped at $5** (bank/ACH) — the processing cost, out of your payout. *Same as Square, Squarespace, or any payment tool you already use.*
3. **Enrops takes a flat 1%** — our only fee.

> **Example — $200 card registration:** parent pays **$200** → Stripe ~**$6.10** → Enrops **$2.00** → **you net ~$191.90.**

---

## What happens on a refund (provider FAQ)

When you refund a registration, the parent gets their money back and that amount is pulled back from your account. **Stripe keeps its original processing fee even on a refund** (that's Stripe's policy, not Enrops's). For now, **Enrops absorbs that small processing cost** so you're not penalized on the fee for an early refund. The registration's status updates to refunded (or partial), and if you also cancel it, future installments stop automatically.

---

## Good-to-know notes

- **Parents see *your* name on their card statement** — not "Enrops." Your program shows up as the merchant, which keeps it recognizable and cuts down on "what's this charge?" disputes.
- **Stripe's processing fee is charged once**, on the parent's payment. The transfer to an instructor is free.
- **The 1% and Stripe's fee don't compound** — both are figured on the registration amount, separately.
- **Pass-through to parents is off.** We do not add a card surcharge to families (cleaner checkout; avoids state surcharge rules).
- **Before connecting your Stripe:** if your Stripe account is already linked to another platform (Sawyer, ActiveNetwork, etc.), Stripe only allows one platform connection — we check this first.
- **System-of-record:** Enrops owns your registration income, partner billing, and contractor-payout records. Your accounting tool owns tax filing and the general ledger. Sync is one-directional (Enrops → accounting).
- **Merch / physical-product sales:** not built yet.

---

*Status: charge path live; refund fee-handling, partner billing/invoicing, and accounting export are on the roadmap. This doc updates as each ships.*
