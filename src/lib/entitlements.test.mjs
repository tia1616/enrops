// Regression tests for Comms entitlements. Pure - inline fixtures, no deps.
// Run: `node src/lib/entitlements.test.mjs`
//
// These pin rules that were each a real defect, not hypotheticals:
//   - a missing platform_plan silently downgraded EVERY org (shipped, caught on
//     staging when a 'founding' org rendered the bare-bones surface)
//   - thank_you is opt-OUT, so creating its row with enabled:false switches the
//     confirmation email off; anything that inserts one must know that
//   - hiding an audience pill without clamping the value shows an empty list
import { readFileSync } from 'node:fs';
import {
  entitlementsFor,
  canManageInstructors,
  commsAudiencesFor,
  isAlwaysOnAutomation,
  isOptOutAutomation,
  automationIsSending,
  registrationAutomationsCanFire,
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

// Fails CLOSED when the plan is missing. This documents the resolver's behaviour
// and is NOT a pin on the shipped bug — see the AdminLayout assertion at the end
// of this file, which is. Code review caught that this line alone asserts the
// DEFECT (undefined plan -> reduced tier is exactly what production did) and
// would pass just as happily with the column dropped from the select again.
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

// --- is it SENDING (tier-independent) vs can it be switched OFF (tier-dependent) ---
// The two used to be one value, which produced opposite lies on the two tiers.
eq('no row + opt-out template -> sending',   automationIsSending(null, 'thank_you'), true);
eq('no row + opt-in template  -> not sending', automationIsSending(null, 'welcome_camp'), false);
eq('stored false beats the opt-out default', automationIsSending({ enabled: false }, 'thank_you'), false);
eq('stored true is sending',                 automationIsSending({ enabled: true }, 'welcome_camp'), true);

// --- registration-dependent automations ---
eq('org that brings its own registration cannot fire them',
   registrationAutomationsCanFire({ uses_enrops_registration: false }), false);
eq('org using Enrops registration can',
   registrationAutomationsCanFire({ uses_enrops_registration: true }), true);
eq('unset defaults to CAN (column default is true)',
   registrationAutomationsCanFire({}), true);

// --- THE REAL PIN for the shipped select bug ---
// entitlementsFor is pure, so no assertion about org objects can detect a column
// missing from AdminLayout's query. This reads the source and asserts the column
// is in the select string. Delete platform_plan from that select and this fails,
// which is what the earlier "pinned" comment wrongly claimed of a pure-function
// assertion. Path is resolved from this file so it works from any cwd.
const adminLayout = readFileSync(
  new URL('../layouts/AdminLayout.jsx', import.meta.url),
  'utf8',
);
const orgSelect = adminLayout.match(/\.select\(\s*"([^"]*instructor_pay_model[^"]*)"\s*\)/);
eq('AdminLayout org query was found', Boolean(orgSelect), true);
eq('AdminLayout org query still selects platform_plan',
   Boolean(orgSelect && orgSelect[1].includes('platform_plan')), true);
eq('AdminLayout org query still selects uses_enrops_registration',
   Boolean(orgSelect && orgSelect[1].includes('uses_enrops_registration')), true);

// --- canManageInstructors -------------------------------------------------
// Added 2026-08-11 with the instructor-documents authoring screen. The rule it
// replaces (`instructor_pay_model !== 'enrops_platform'`) hid every instructor
// surface from a lean org, which was safe only while every lean org had zero
// instructors. A founding operator onboarding their own instructors breaks that,
// and the documents screen is the one surface their onboarding cannot run
// without — so gating it on nav shape would have shipped a page the operator
// who needs it most cannot open.
eq('full-nav org may manage instructors', canManageInstructors({ instructor_pay_model: 'legacy_own_platform' }), true);
eq('lean + founding may manage instructors', canManageInstructors(LEAN_FOUNDING), true);
eq('lean + standard may NOT', canManageInstructors(LEAN_STANDARD), false);
eq('lean + pilot may NOT', canManageInstructors({ instructor_pay_model: 'enrops_platform', platform_plan: 'pilot' }), false);
// Fails CLOSED on junk rather than opening a surface to an org that lost its plan.
eq('lean with no plan may NOT', canManageInstructors({ instructor_pay_model: 'enrops_platform' }), false);
// A missing org must not read as lean-and-entitled; it reads as full-nav, which
// matches entitlementsFor's existing treatment of a null org.
eq('null org does not crash', canManageInstructors(null), true);
eq('agrees with comms entitlement for lean orgs',
   [canManageInstructors(LEAN_FOUNDING), canManageInstructors(LEAN_STANDARD)],
   [entitlementsFor(LEAN_FOUNDING).comms === 'full', entitlementsFor(LEAN_STANDARD).comms === 'full']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
