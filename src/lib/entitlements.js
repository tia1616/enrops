// entitlements — what an org can DO, resolved from its plan.
//
// Three facts were being conflated across the app: what an org can do, what it
// pays, and which nav shape it gets. They are different axes and were all being
// read off `instructor_pay_model` inline at each gate, which meant "give this
// one tenant more" had no answer that wasn't a hardcoded tenant check.
//
// The split this file enforces:
//   organizations.platform_plan   -> what you can DO      (this file)
//   organizations.platform_fee_*  -> what you PAY         (Finances)
//   instructor_pay_model          -> which NAV SHAPE      (AdminLayout)
//
// Adding the next founding member is a one-row UPDATE, not a code change. That
// is the whole point — see feedback_no_hardcoded_config_single_source and the
// hard rule that we branch on CONFIG, never on tenant.
//
// NOTE ON EXPIRY, AND THE TRAP IT HIDES. Founding deals have an end date (Jeff's
// is 2026-12-31), but the end of the FREE PERIOD is not the end of the
// ENTITLEMENT. Jessica, 2026-08-09: "he's not going to get downgraded, he's going
// to pay for it starting Jan 2027." He keeps everything and starts paying $99/mo.
//
// So DO NOT move a founding org onto a billing-shaped plan when they start
// paying. Every payment-shaped value ('flat_monthly', 'per_registration',
// 'hybrid') resolves to registration_only below, so an honest-looking billing
// flip would revoke the product on the exact day the customer starts paying for
// it. This column answers "what can they do", never "what do they pay".
//
// The correct move on 1 Jan 2027: LEAVE platform_plan as 'founding' and record
// the price in organizations.platform_monthly_cents (9900). That column already
// exists on every org and is 0 everywhere today. Access is untouched.
//
// No automatic expiry is modelled and none should be: there is no subscription
// billing here, so a cron-driven downgrade would silently strip Comms from a
// live operator mid-term and stop their families' emails.

// Plans whose orgs get the whole product. 'founding' is the free-until-agreed
// early-partner deal.
//
// Note what this does NOT cover: a LEAN org on any other plan gets the reduced
// tier, and that includes 'pilot'. The internal Enrops org and the demo tenants
// are lean+pilot, so they see the registration_only surface too. That is correct
// for a demo of the standard tier and wrong for demoing the full one — move the
// org to 'founding' for the day if a full-surface demo is needed.
const FULL_ACCESS_PLANS = new Set(["founding", "enterprise"]);

/**
 * What this org is entitled to. Pure — takes the org row, returns a plain
 * object. Every gate in the app should ask this instead of testing
 * instructor_pay_model or a slug inline.
 *
 * comms:
 *   "full"              — all four Comms tabs, every audience, every automation.
 *   "registration_only" — Contacts (families) + the automations that are part of
 *                         registration working at all. No Campaigns, no
 *                         Templates. This is the standard lean tier.
 */
export function entitlementsFor(org) {
  // Lean registration operators are the only orgs that get a reduced product.
  // Everyone else (J2S / legacy_own_platform, internal) has always had the full
  // surface and must keep it — this function returning "full" for them is what
  // makes this refactor a no-op on their path.
  const isLean = org?.instructor_pay_model === "enrops_platform";
  if (!isLean) return { comms: "full" };

  // A lean org on a full-access plan (Jeff, founding) gets everything a lean
  // NAV can honestly show. Note this is not the same as J2S's surface: the
  // instructor audience stays hidden for every lean org regardless of plan,
  // because those sends fire from a Schedule tab lean nav does not render.
  // That is a truth constraint, not a pricing one — see commsAudiencesFor.
  if (FULL_ACCESS_PLANS.has(org?.platform_plan)) return { comms: "full" };

  return { comms: "registration_only" };
}

/**
 * May this org manage instructors at all — onboarding, the documents they sign,
 * the roster, scheduling?
 *
 * The existing instructor surfaces gate on `instructor_pay_model !==
 * 'enrops_platform'`, which conflates "which nav shape" with "what may you do"
 * and is exactly the split this file exists to undo. It was a safe shortcut only
 * while every enrops_platform org had zero instructors; a founding operator
 * onboarding their own instructors breaks that premise, and gating them out
 * would hide a surface they are entitled to and paying nothing for by agreement.
 *
 * So: everyone on a full nav keeps it, and a lean org gets it when its PLAN says
 * so. Same shape as entitlementsFor above, deliberately — one definition of
 * "full access", not a second one drifting alongside it.
 */
export function canManageInstructors(org) {
  const isLean = org?.instructor_pay_model === "enrops_platform";
  if (!isLean) return true;
  return FULL_ACCESS_PLANS.has(org?.platform_plan);
}

/**
 * Which Comms audience pills this org should see.
 *
 * Two independent reasons an audience is hidden, and they must not be confused:
 *
 *   Instructors — gated on whether this org may manage instructors AT ALL.
 *     This used to be hidden for EVERY lean org, paid or not, and the reason was
 *     a good one: two of the three instructor automations say "send from your
 *     Schedule tab", and lean nav removed that tab, so the pills would have
 *     pointed at a surface the operator could not open. A truth constraint, not
 *     a pricing one.
 *
 *     THAT REASON HAS NOW GONE. shapeNavForOrg renders the Instructors section
 *     for a lean org that passes canManageInstructors, so for those orgs the
 *     tab exists and the automations' instruction is true. Leaving this as-is
 *     would have been the other half of the same bug: the operator gets the
 *     Schedule tab and still no instructor audience, with nothing anywhere
 *     explaining why.
 *
 *     Deliberately expressed as canManageInstructors rather than re-deriving the
 *     plan check. For a lean org that predicate and `comms === "full"` resolve
 *     identically today — but they mean different things, and if the plan sets
 *     ever diverge, "can you email your instructors" must follow "do you have
 *     instructors", not "how much Comms did you buy".
 *
 *   Partners — hidden on the registration_only tier only. The single partner
 *     automation (class roster to the school) is an upgrade, so the pill would
 *     lead to an empty list. Jeff's org sees it; he has 22 partner sites.
 */
export function commsAudiencesFor(org) {
  const isLean = org?.instructor_pay_model === "enrops_platform";
  if (!isLean) return ["families", "instructors", "partners"];

  const { comms } = entitlementsFor(org);
  if (comms !== "full") return ["families"];
  return canManageInstructors(org)
    ? ["families", "instructors", "partners"]
    : ["families", "partners"];
}

/**
 * The automation template keys a registration_only org gets: the ones that are
 * part of a registration actually working. Everything else (retention, nurture,
 * win-back, review asks) is the upgrade.
 *
 * Keys, not ids — automation_templates.key is the stable identifier and the
 * same value the edge functions branch on.
 */
export const REGISTRATION_AUTOMATION_KEYS = new Set([
  "thank_you",           // the confirmation email after payment
  "welcome_afterschool", // "your class starts in X days"
  "welcome_camp",        // same, camp variant
  "no_school_day",       // stops a parent driving to a closed school
]);

/**
 * Automations that fire UNLESS explicitly disabled, i.e. a missing `automations`
 * row means ON, not off. thank_you is the only one: stripe-webhook sends the
 * confirmation whenever the row is absent and skips it only on an explicit
 * enabled === false (see the thank_you branch in stripe-webhook/index.ts).
 *
 * Every other automation is opt-IN — the cron collects rows where enabled is
 * true, so no row means nothing fires.
 *
 * This distinction has to be respected by anything that CREATES an automations
 * row, not just by anything that reads one. Inserting enabled:false for an
 * opt-out automation doesn't leave it as it was, it turns it OFF.
 */
export function isOptOutAutomation(templateKey) {
  return templateKey === "thank_you";
}

/**
 * The confirmation email is not optional on the registration_only tier. It IS
 * the tier's promise, and turning it off has no visible failure mode: the
 * stripe-webhook simply skips the send (see stripe-webhook/index.ts, the
 * thank_you enabled===false branch) and a paying family gets nothing. Operators
 * on this tier can still EDIT the wording; they just cannot switch it off.
 *
 * Orgs with full Comms keep the toggle — they have the rest of the surface to
 * understand what they're turning off.
 */
export function isAlwaysOnAutomation(org, templateKey) {
  return (
    templateKey === "thank_you" &&
    entitlementsFor(org).comms === "registration_only"
  );
}

/**
 * Is this automation ACTUALLY sending right now?
 *
 * Deliberately TIER-INDEPENDENT, and that separation is the whole point. Whether
 * an automation is *sending* is a fact about the stored row plus the template's
 * opt-in/opt-out default. Whether it is *toggleable* is the tier question, and
 * that is isAlwaysOnAutomation's job. Conflating the two produced two opposite
 * bugs at once:
 *
 *   - a full-tier org with no thank_you row was shown "Off" while stripe-webhook
 *     was demonstrably sending (it skips only on an explicit false), which invites
 *     the operator to add a second confirmation of their own so families get two;
 *   - a reduced-tier org with a stored enabled:false was shown "Always on" while
 *     nothing sent at all, with no control anywhere to repair it.
 *
 * @param automationRow the org's `automations` row for this template, or null
 */
export function automationIsSending(automationRow, templateKey) {
  if (automationRow) return !!automationRow.enabled;
  return isOptOutAutomation(templateKey);
}

/**
 * Can this org's registration automations actually fire?
 *
 * All four of the registration_only tier's automations depend on Enrops running
 * the registration: thank_you fires from stripe-webhook, and the three others
 * resolve their audience from `registrations` rows with status='confirmed'. An
 * org with uses_enrops_registration=false (Shoreview Chess, Mrs. Richelle on
 * prod) brings its own registration, so none of them can ever send.
 *
 * Jessica's call, 2026-08-09: keep Comms visible for them and make the page say
 * so, rather than hiding it. Contacts genuinely works for these orgs - it reads
 * uploaded contacts and has nothing to do with registration - so hiding the
 * section would take away something that works in order to hide something that
 * doesn't. The honest notice is also the upgrade argument.
 */
export function registrationAutomationsCanFire(org) {
  return org?.uses_enrops_registration !== false;
}

/**
 * Whether this org can reach a given Comms tab. Used by both the nav and the
 * route guards — a hidden nav item that is still reachable by URL is not a
 * gate, and every previous gate in this app that only hid the link eventually
 * had someone land on it from a bookmark.
 */
export function canReachCommsTab(org, tab) {
  const { comms } = entitlementsFor(org);
  if (comms === "full") return true;
  // registration_only: Contacts + Automations, nothing else.
  return tab === "contacts" || tab === "automations";
}
