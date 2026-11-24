---
stage: 1
title: Get your link
opens_when: signup
goal: One class is live, Stripe is connected, and the link is in a family's hands.
checklist:
  - id: first-program
    label: Build your first class
    done_when: the org has a program
  - id: connect-stripe
    label: Connect Stripe so families can pay you
    done_when: organizations.stripe_charges_enabled is true
  - id: share-link
    label: Publish it and share your link
    done_when: a program is open (published) and Stripe is connected
---

# Get your link

Three things and you're live: build a class, connect Stripe, share the link.

## Sign up {#sign-up}

**Goal:** your own registration page at `enrops.com/your-business`.

**Steps**
1. Go to enrops.com/signup.
2. Tap **Continue with Google**, or type your email and tap **Email me a sign-in link**.
3. Type your business name and tap **Create my free page →**.
4. You'll see "Your registration page is ready." with your page address. Tap **Build your first program →**.

**Ennie's advice**
- No password to remember. Every time you come back, sign in the same way you did today: Google, or an emailed link.
- Your page address comes from your business name. You can change it later in **Settings → Your page address**. Do that before you share any links, because old links stop working when it changes.
- We set you up with starter waivers and a starter cancellation policy so your page isn't missing anything. Read them before you share your link (see **Make it yours**).

**If it goes wrong**
- No email arrived: check spam, then ask for a new link. Links expire, so use the newest one.
- School and work email addresses sometimes block sign-in links. A personal Gmail is the most reliable.

## Build your first class {#first-program}

**Goal:** one class with a name, a place, dates and a price.

**What to have ready:** class name, where it happens, day and time, first class date, price per child, how many kids you can take. A short description and a photo help families decide, but you can add them later.

**Steps**
1. **Programs → Scheduled programs → + New program.** Your very first time, you go straight there from signup.
2. The first time, you get three quick questions:
   - **Where do your classes happen?** At our own space / We go out to schools or other sites / A bit of both.
   - **How do your classes usually run?** A weekly series / One-off workshops / A bit of both.
   - **What ages do you teach?** Leave it blank if it varies.

   Then tap **Next: build my first class →**. (**Not now** skips them, and they come back next time.)
3. Fill in **Program name**, **Price** and **Spots**. Add a **Description** and **Photo** if you have them.
4. Pick the **Location** (or **Which site?**). Use **+ Add a location** (or **+ Add a site**) if it's new. Choose its **District**, or **No district (studio, library, private site)**. If it's at a school, tick **This is at a school or another organization's site** so you can send them rosters. Tap **Save location**.
5. Choose **What kind of thing is this?**
   - **Weekly series:** day of the week, start and end time, **First class date**, **# of classes**.
   - **One-off workshop:** the date.
   - **Camp:** days it runs, half or full day, first and last day, times.
6. Add **Who it's for** (grades or ages) if you like.
7. Tap **Create program & get link**. If Stripe isn't connected yet, the button says **Save draft & connect Stripe →**. It saves your class first, so nothing you typed is lost.

**Ennie's advice**
- Under the price you'll see "Families pay $X". That's the number to put on your flyer, because it's what families actually pay.
- Not sure of your price? Publish your best number. You can change it before families register, and anyone who already registered keeps the price they paid.
- Write the description outcome first: what kids walk away with.
- A weekly class needs a **First class date** before it can go live. You can save a draft without one.
- If the first class date falls on a different weekday than the day you picked, the dates follow the date. Check the dates preview.

**If it goes wrong**
- You see "This location has no district yet, so these class dates won't skip no-school days." Your dates will include school holidays until you fix it. See **Make your dates skip no-school days**.

## Make your dates skip no-school days {#school-calendar}

**Goal:** class dates skip holidays, breaks and teacher work days automatically.

**When you need it:** any class at a school, or any class whose families follow a school calendar. Do it before you share your link, because families see the dates.

**Steps**
1. **Programs → Locations.** Tap **Open** on the site, choose its **District**, and tap **Save changes**. Pick **No district (library, church, private site)** only if it truly doesn't follow a school calendar.
2. **Programs → School calendar.** Find the district and tap **Add calendar**.
3. Under **Pull dates…**, paste a link to the district calendar, upload the PDF, or paste the text, then tap **Extract**.
4. Check **First day of school**, **Last day of school**, **No-school days** and **Early-release days**. Fix anything that's off and tap **Save calendar**.
5. When asked whether you teach on early-release days, choose **Yes, I teach on early-release days** (and the time) or **No, we skip those days**.

**Ennie's advice**
- The district is the piece people miss. Everything looks saved and the dates are simply wrong. Every school site needs one.
- One district calendar covers every school in that district. You only upload it once per school year.
- The early-release answer can be changed later with the **Class times** button on that calendar's row.
- A single day off (a field trip, a snow day): **Programs → Scheduled programs**, open the class, **Mark a no-school day**.

**If it goes wrong**
- The banner says "No calendar saved for (district)": that district's dates are weekly only, with no holidays taken out. Tap the link in the banner to add the calendar.
- An early-release day shows as no class: open the calendar's **Class times** and choose **Yes, I teach on early-release days**.

## Connect Stripe so families can pay you {#connect-stripe}

**Goal:** families pay you by card or bank transfer, and the money goes into your own account.

**What to have ready:** your business's legal name, EIN (or your SSN if you're a sole owner), business address, date of birth, a photo ID, and your bank account and routing number. This is Stripe's standard check for anyone taking card payments.

**Steps**
1. **Money → Payments.**
2. Already use Stripe? Tap **Connect my Stripe account** and pick the account you already have. New to Stripe? Tap **I don't use Stripe yet**.
3. Finish Stripe's form. When you come back, the page shows **Stripe connected · Charges on · Payouts on**.
4. Stopped partway? Come back to **Money → Payments** and tap **Continue setup**. Finished but the page hasn't caught up? Tap **Already finished? Check status**.

**Ennie's advice**
- The screen says connecting takes about a minute if you already use Stripe, and 5 to 10 minutes if not.
- enrops never sees your bank or tax details. They go straight into Stripe's secure form.
- Payment goes into your Stripe account, then Stripe pays it to your bank on its own schedule. On Stripe's standard US schedule a payment arrives about 2 business days later. Your very first payout can take longer while Stripe reviews a new account.
- Pick the right button first time. **I don't use Stripe yet** creates a new Stripe account straight away, and if you already had one you'll need **Disconnect Stripe** to switch.

**If it goes wrong**
- Stripe asks for a code from its phone app or a passkey you don't have: look for another way to verify on that Stripe screen (such as a text message). If there isn't one, stop there and email hello@enrops.com with what the screen says.
- Stripe says your name or address doesn't match government records: fix it on Stripe's account page and upload the document it asks for.
- "This organization already has a Stripe account connected": open **Payment settings** on **Money → Payments** and disconnect the current one first.

## Publish it and share your link {#share-link}

**Goal:** families can find your class and register.

**Steps**
1. **Programs → Scheduled programs.** A draft shows **Publish →**. Tap it and confirm.
2. Tap **Share** on the class (or **Share registration page** at the top for all your classes).
3. **Copy** the link, or tap **QR code → Download PNG** for your flyer.
4. Tap **Preview the registration page ↗** and walk through it on your phone, the way a parent would.
5. Have your own website? On **Programs**, tap **Add to your website** and **Copy code**, then paste it into your site.

**Ennie's advice**
- Check it on your phone too, not just a computer.
- At checkout families see your price plus the enrops service fee on its own line, so nobody is surprised.
- Where to send it: the principal or front office, your school newsletter contact, and the families you already know.
- If families can't see a class, the share panel says **Not open to families** and gives no link. That happens when the class starts more than a year from now, or, if you open one term at a time, when its term isn't open yet. Camps are the exception: their link works as soon as you publish. See **When families see your classes**.

**If it goes wrong**
- The share button says **Connect Stripe to share your link →**: families can't pay until Stripe is connected.
- "Not live yet. Publish this program first": tap **Publish →** on the class.

## Where registrations show up {#see-registrations}

- **Programs → Scheduled programs** shows enrolled / spots for each class.
- **Programs → Class rosters** lists every child. Anyone who registers through enrops shows up automatically.
- "(+N unfinished registrations, not counted)" means a family started but didn't pay. They aren't on your roster yet.
- Payments: **Money → Payments** shows what came in. Your actual bank deposits are in your Stripe dashboard (**Stripe Dashboard ↗**).
