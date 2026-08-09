// Regression tests for Comms entitlements. Pure - inline fixtures, no deps.
// Run: `node src/lib/entitlements.test.mjs`
//
// These pin rules that were each a real defect, not hypotheticals:
//   - a missing platform_plan silently downgraded EVERY org (shipped, caught on
//     staging when a 'founding' org rendered the bare-bones surface)
//   - thank_you is opt-OUT, so creating its row with enabled:false switches the
//     confirmation email off; anything that inserts one must know that
//   - hiding an audience pill without clamping the value shows an empty list
import {
  entitlementsFor,
  commsAudiencesFor,
  isAlwaysOnAutomation,
  isOptOutAutomation,
  canReachCommsTab,
  REGISTRATION_AUTOMATION_KEYS,
} from './entitlements.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

const LEAN_STANDARD = { instructor_pay_model: 'enrops_platform', platform_plan: 'per_registration' };
const LEAN_FOUNDING = { instructor_pay_model: 'enrops_platform', platform_plan: 'founding' };
const LEGACY        = { instructor_pay_model: 'legacy_own_platform', platform_plan: 'free' };

// --- tier resolution ---
eq('lean + standard plan -> registration_only', entitlementsFor(LEAN_STANDARD).comms, 'registration_only');
eq('lean + founding      -> full',              entitlementsFor(LEAN_FOUNDING).comms, 'full');
eq('legacy (J2S)         -> full',              entitlementsFor(LEGACY).comms, 'full');
eq('lean + pilot         -> registration_only', entitlementsFor({ ...LEAN_STANDARD, platform_plan: 'pilot' }).comms, 'registration_only');

// A non-lean org must stay 'full' even with no plan at all - the refactor has to
// be a no-op for J2S, whose surface nobody asked to change.
eq('legacy with plan missing -> still full', entitlementsFor({ instructor_pay_model: 'legacy_own_platform' }).comms, 'full');

// THE SHIPPED BUG: AdminLayout's org select omitted platform_plan, so this was
// undefined for every org and everyone silently fell to the reduced tier. It
// fails closed, which is the safe direction and precisely why nothing surfaced
// it. Pinned so a future select edit that drops the column fails here first.
eq('lean with plan missing -> reduced (fails CLOSED)', entitlementsFor({ instructor_pay_model: 'enrops_platform' }).comms, 'registration_only');
eq('null org             -> full (never lock out a load failure)', entitlementsFor(null).comms, 'full');

// --- audiences ---
// Instructors is hidden for every lean org REGARDLESS of plan: two of its three
// automations send from a Schedule tab lean nav does not render.
eq('lean standard audiences', commsAudiencesFor(LEAN_STANDARD), ['families']);
eq('lean founding audiences (no instructors)', commsAudiencesFor(LEAN_FOUNDING), ['families', 'partners']);
eq('legacy audiences (all three)', commsAudiencesFor(LEGACY), ['families', 'instructors', 'partners']);
eq('lean never sees instructors, any plan',
   ['per_registration', 'founding', 'pilot', 'enterprise']
     .every((p) => !commsAudiencesFor({ instructor_pay_model: 'enrops_platform', platform_plan: p }).includes('instructors')),
   true);

// --- tab reachability (the route guards read this) ---
eq('standard: contacts reachable',    canReachCommsTab(LEAN_STANDARD, 'contacts'), true);
eq('standard: automations reachable', canReachCommsTab(LEAN_STANDARD, 'automations'), true);
eq('standard: campaigns BLOCKED',     canReachCommsTab(LEAN_STANDARD, 'marketing'), false);
eq('standard: templates BLOCKED',     canReachCommsTab(LEAN_STANDARD, 'templates'), false);
eq('founding: campaigns reachable',   canReachCommsTab(LEAN_FOUNDING, 'marketing'), true);
eq('legacy: templates reachable',     canReachCommsTab(LEGACY, 'templates'), true);

// --- the free automation set ---
eq('free set is exactly the registration ones',
   [...REGISTRATION_AUTOMATION_KEYS].sort(),
   ['no_school_day', 'thank_you', 'welcome_afterschool', 'welcome_camp']);
// Retention/nurture/marketing must NOT leak into the free tier.
eq('upgrade automations excluded',
   ['check_in', 'mid_recap', 'final_recap', 'birthday', 'welcome_contact', 'review_request', 'abandoned_registration', 'partner_roster']
     .some((k) => REGISTRATION_AUTOMATION_KEYS.has(k)),
   false);

// --- always-on confirmation ---
eq('thank_you always-on on the reduced tier', isAlwaysOnAutomation(LEAN_STANDARD, 'thank_you'), true);
eq('thank_you toggleable on full tier',       isAlwaysOnAutomation(LEAN_FOUNDING, 'thank_you'), false);
eq('thank_you toggleable for legacy',         isAlwaysOnAutomation(LEGACY, 'thank_you'), false);
eq('welcome is never always-on',              isAlwaysOnAutomation(LEAN_STANDARD, 'welcome_afterschool'), false);

// --- opt-out semantics ---
// stripe-webhook SENDS thank_you when no automations row exists and skips it
// only on an explicit enabled===false. So any code path that CREATES the row
// must write true, or rewording the email turns it off. That was live in
// AutomationEditor's insert.
eq('thank_you is opt-out', isOptOutAutomation('thank_you'), true);
eq('welcome_camp is opt-in', isOptOutAutomation('welcome_camp'), false);
eq('partner_roster is opt-in', isOptOutAutomation('partner_roster'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
