# Enrops Operator FAQ

Plain-English answers for providers (operators) using Enrops. Written tenant-neutral
so it can power an in-app help chatbot. Keep each entry self-contained: a clear
question, then steps. No tenant-specific names or branding.

_Last updated: 2026-06-30_

---

## Getting started

### How do I open registration for a program?
There are two one-time setup steps, then the program itself.

**Set up once (per provider):**
1. **Settings → Waivers** — click **"seed an editable starter set"** to get default agreements (or add your own), edit them, and keep at least one active. Families sign these during registration.
2. **Settings → Email sender** — set your sender name and reply-to address so confirmation emails come from you.
3. **Money → Connect Stripe** — connect your payout account through Stripe's secure form. You need this active to collect real payments.

**Open a registration:**
4. **Programs → Offerings tab → Add** — choose **"Don't have a document?"**, name your offering (e.g. a class, club, or tournament), fill in the details, and **Publish**.
5. **Programs → New** — in the wizard, pick that offering, a location, the term (it defaults to the term in progress), a price, day/time, and capacity, then **Open registration**.
6. **Share** — use the Share button to copy your registration link, or send families to your public catalog at `enrops.com/<your-slug>`.
7. **Test it** — open your catalog, register a test student, and walk through Student → Parent → Waivers → Review → Pay. Confirm the automatic confirmation email and the parent portal.

### Why does the waivers step look blank during registration?
Your provider doesn't have any active waivers yet. Go to **Settings → Waivers** and click **"seed an editable starter set"** (or add your own), then keep at least one active. The registration flow will then show your agreement instead of a blank step.

### Where do waiver templates live?
**Settings → Waivers.** If you have none, click **"seed an editable starter set"** to get brand-neutral default agreements you can edit. You can also create your own from scratch, mark each as required or optional, and archive ones you no longer use.

### Do I need a document to create an offering?
No. In **Programs → Offerings tab → Add**, choose **"Don't have a document?"** and just name it. You can attach a curriculum document later if you want.

### How does the term get picked on my Programs and Schedule screens?
Automatically. Term-scoped screens default to the term currently in progress — or, if that term is over, the next one starting. It advances on its own as terms roll over; you don't set it manually.

### Do families pay me directly?
Yes. When a family pays through Enrops, the money routes to the Stripe payout account you connected — minus Stripe's normal processing fee and the Enrops platform fee (which you can absorb or pass on to families). Stripe pays out to your bank on its regular schedule. You never move money by hand, and Enrops never sees your bank or tax details — those go straight into Stripe's secure form.

### Will my registration pages look like another provider's?
No. Each provider's public pages (catalog, registration, parent portal) load only that provider's data and render in clean, neutral styling — not another tenant's brand. Custom per-provider colors and logos are a setting that can be added to your account.

---

## Offerings & programs

### How do I create an offering without a document?
**Programs → Offerings tab → Add**, then choose **"Don't have a document?"**, type a name, and continue. You land on a review screen where you fill in as much or as little as you want (or just keep the name) and **Publish**. You can attach a curriculum document later from the offering's detail page to auto-fill the rest. An offering must be **published** before you can build a program from it.

### How do I create a program and open registration?
First make sure the offering you want is **published** (above). Then **Programs → New** and go through the 3-step wizard:
1. **What & where** — pick the published offering and a location.
2. **When & how many** — start date, number of sessions, day/time, and capacity. You'll see a live preview of the session dates (they default to the current term).
3. **Price & open** — set the price, then click **Open registration** to go live, or **Save as draft** to publish later.

Once it's open, families can register immediately — use the **Share** button to copy the registration link. (If you don't see your offering in step 1, it isn't published yet.)

---

## Money & payouts

### How do I set up payouts (connect Stripe)?
Go to **Money → Connect Stripe**.
1. First choose your **business type and country** and save — the Connect button activates once these are set.
2. Click **Connect Stripe**. You're taken to Stripe's secure hosted form to enter your business details, bank account, and tax info (EIN/SSN). Enrops never sees any of that — it goes straight to Stripe.
3. When you finish, Stripe returns you to Enrops and your account flips to **active** (you can start collecting payments).
4. If it doesn't update immediately, click **"Already finished? Check status"** to refresh it.

You need this connected to collect real payments. Your existing payment setup stays exactly as-is until you're ready to move.

### How does the money reach me, and what does Enrops take?
When a family pays through Enrops, the charge routes to your connected Stripe account, minus Stripe's normal processing fee and the Enrops platform fee (1%). Stripe pays out to your bank on its regular schedule — you never move money by hand. You can choose to absorb the 1% or pass it on to families as a checkout line item (a setting in Money).

---

## Communications & email

### How do I set the email families see (sender name)?
**Settings → Email sender.** Set your **sender display name** and a **reply-to address**. The actual send address is created automatically on Enrops's verified domain, so you never touch DNS and a misconfiguration can't silently break your sending. You'll see a live preview of how your emails appear, and you can send yourself a test before saving. (Owner/admin only.)

---

## Rosters & families

### Where is my class roster, and how does it fill up?
**Programs → Class rosters tab.** Each program or camp shows its enrollment and roster. Rosters **fill in automatically as families register** — you don't build them by hand. From here you can also add a child manually, upload/import a roster, email the roster to enrolled families, or invite families to the parent portal.
