# How to run payroll — Week of June 22 camps (for Arielle)

_Last verified against production 2026-06-08._

## Before you start (once, the Friday before)

1. **Log in** at [enrops.com](https://enrops.com) as `arielle@journeytosteam.com` → left nav **Money** → **Payouts** tab → **Payroll** tab.
2. **Check the J2S Stripe balance.** Paying all 5 camps is about **$2,000**. The money comes out of J2S's Stripe balance (where parent payments land), so make sure there's at least that much **available** before you pay.
   - If Stripe is set to auto-pay your balance to the bank, it can leave nothing for instructor pay. In Stripe → Settings → Payouts, set the schedule to **Manual** so funds accumulate. Balance settles ~2 days after each parent payment.
3. You don't need to chase instructors to check in. A nightly job auto-confirms any day they forget, at the correct rate. Their own "I taught today" taps also work.

## When to run it

Run **after the week is taught** — easiest is **Saturday June 27 or later**, once all five days (Mon–Fri, June 22–26) are confirmed. You can also pay mid-week as days complete; the steps are the same.

## What you should see

Set the **From** date at the top to **June 22, 2026**. You'll see one row per instructor per camp. For this week (all half-day Lead instructors, $80/day × 5 days):

| Instructor | Camp · Location | Amount |
|---|---|---|
| Bo | Creative Coders · Forest Grove | **$400** |
| Lance | LEGO Toy Designers · Happy Valley | **$400** |
| Lance | Intro Robotics · Happy Valley | **$400** |
| Tiffany | LEGO Toy Designers · Overlook House | **$400** |
| Tiffany | Robot Ready · Overlook House | **$400** |
| | **Total** | **$2,000** |

> If any amount looks wrong, click the row to expand the day-by-day breakdown. Each half-day should be **$80**. Tell Jessica before paying if a number is off.

## Steps for each instructor

1. **Review the days.** Click the row to expand. Confirm the days taught and the amount.
2. **Didn't actually teach a day?** Click **Withhold** on that day (add a short reason). They won't be paid for it. You can re-approve later.
3. **Approve.** If the row says *Pending*, click **Approve all**. (The nightly job usually pre-approves, so it may already say *Approved* — that's fine.)
4. **Pay.** Click **Pay via Stripe**. A panel opens showing the total and **"Stripe payouts ready: ✓ Yes"**. Click **Send $X**.
   - All three instructors are confirmed Stripe-ready, so this should go straight through.
   - Paying them outside Enrops instead? Use **Mark paid manually** and note how you paid (so records stay clean and no one is double-paid).
5. Repeat for each instructor. Use the **Show paid** toggle to see settled rows.

## If a substitute covered a day

If someone subbed for the assigned instructor on a given day, that day shows up under the **substitute's** name, tagged **"Subbing for [assigned instructor]"**, and pays the **sub's** own rate — a developing-tier sub is **$65** for a half-day, not the lead's $80. That's correct: pay the substitute, and the assigned instructor isn't paid for that day.

- Expand the row to see which day was covered ("Subbing for …").
- A sub only appears here once they've **accepted** the cover. A sub who declined (or was only offered) will **not** show up and will **not** be paid.
- Edge case: if a sub was arranged very last-minute (after that night's auto-confirm ran), the day may still show the originally-assigned instructor at their rate. If you know a sub actually taught and the amount/name looks off, **stop and message Jessica** before paying — she can fix it in seconds.

## If a payment is blocked

The panel tells you why in plain English. Most likely:
- **"Not enough available balance"** → see step 2 above (Manual payout schedule / wait for funds to settle).
- **"Stripe Express account isn't fully set up"** → have that instructor finish Stripe onboarding in their portal (Pay tab → "Open your Stripe Express"), then retry.

Anything you're unsure about — stop and message Jessica before sending.
