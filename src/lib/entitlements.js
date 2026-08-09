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
// NOTE ON EXPIRY: founding deals have an end date (Jeff's is 2026-12-31, after
// which he moves to $99/mo). That date is deliberately NOT modelled here. There
// is no subscription billing in the platform yet, so an automatic downgrade
// would silently strip Comms from a live operator mid-term and stop their
// families' emails — the exact silent-failure class we keep fixing. Expiry is a
// deliberate human flip of platform_plan, not a cron.

// Plans whose orgs get the whole product. 'founding' is the free-until-agreed
// early-partner deal; 'legacy_own_platform' orgs (J2S) and internal orgs reach
// this through the default branch below rather than by plan name.
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
 * Which Comms audience pills this org should see.
 *
 * Two independent reasons an audience is hidden, and they must not be confused:
 *
 *   Instructors — hidden for EVERY lean org, paid or not. Two of the three
 *     instructor automations say "send from your Schedule tab", and lean nav
 *     hides that tab (AdminLayout.shapeNavForOrg). Showing them would be three
 *     cards pointing at a surface the operator cannot open. Truth, not tier.
 *
 *   Partners — hidden on the registration_only tier only. The single partner
 *     automation (class roster to the school) is an upgrade, so the pill would
 *     lead to an empty list. Jeff's org sees it; he has 22 partner sites.
 */
export function commsAudiencesFor(org) {
  const isLean = org?.instructor_pay_model === "enrops_platform";
  if (!isLean) return ["families", "instructors", "partners"];

  const { comms } = entitlementsFor(org);
  return comms === "full" ? ["families", "partners"] : ["families"];
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
