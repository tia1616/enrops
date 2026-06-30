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
