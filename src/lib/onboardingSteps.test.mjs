// Pins effectiveStepOrder — which screens an instructor is actually walked
// through for a given org.
//
// This is the browser half of a two-sided contract. gateCheck.ts computes the
// SAME required set server-side, and the two must agree exactly: if the wizard
// drops a step the gate still requires, the step key is never written and
// onboarding sits at 'in_progress' forever with nothing left to click. If the
// wizard shows a step the gate has dropped, the instructor does harmless extra
// work. The first failure is silent and permanent, which is why this is pinned.

import { STEP_KEYS, STEP_ORDER, effectiveStepOrder, stepIndex, stepNumber } from './onboardingSteps.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// --- defaults --------------------------------------------------------------
//
// A caller that passes nothing must get today's behaviour. Every existing org
// has an empty document config, so this IS the shape production runs in.
const dflt = effectiveStepOrder();
ok('no args keeps the policies step', dflt.includes(STEP_KEYS.POLICIES_ACKNOWLEDGED));
ok('no args keeps the additional step', dflt.includes(STEP_KEYS.ADDITIONAL_ACKS));
ok('no args drops training (opt-in)', !dflt.includes(STEP_KEYS.TRAINING_COMPLETED));
ok('no args keeps the background check (opt-out)', dflt.includes(STEP_KEYS.CHECKR_SUBMITTED));

// --- the document steps ----------------------------------------------------
const noPolicies = effectiveStepOrder({ policiesEnabled: false });
ok('policiesEnabled:false drops the policies screen',
  !noPolicies.includes(STEP_KEYS.POLICIES_ACKNOWLEDGED));
ok('...and leaves the additional screen alone',
  noPolicies.includes(STEP_KEYS.ADDITIONAL_ACKS));
ok('...and leaves the agreement alone — it is never toggleable',
  noPolicies.includes(STEP_KEYS.AGREEMENT_SIGNED));
eq('...and removes exactly one step', noPolicies.length, dflt.length - 1);

const noAdditional = effectiveStepOrder({ additionalEnabled: false });
ok('additionalEnabled:false drops the additional screen',
  !noAdditional.includes(STEP_KEYS.ADDITIONAL_ACKS));
ok('...and leaves the policies screen alone',
  noAdditional.includes(STEP_KEYS.POLICIES_ACKNOWLEDGED));

const neither = effectiveStepOrder({ policiesEnabled: false, additionalEnabled: false });
eq('both off removes exactly two steps', neither.length, dflt.length - 2);
ok('both off still signs the agreement', neither.includes(STEP_KEYS.AGREEMENT_SIGNED));
ok('both off still collects emergency contact',
  neither.includes(STEP_KEYS.EMERGENCY_AND_PREFS));

// --- the Stripe payment step -----------------------------------------------
//
// The step that was unconditional longest. Only a provider who actually pays
// instructors through Stripe should ever show it; for everyone else it walked
// their instructor into handing over an SSN and bank details for payouts that
// would never arrive.
ok('stripe payment setup is present by default', dflt.includes(STEP_KEYS.STRIPE_SUBMITTED));

const noStripe = effectiveStepOrder({ stripePayEnabled: false });
ok('stripePayEnabled:false drops the payment step',
  !noStripe.includes(STEP_KEYS.STRIPE_SUBMITTED));
eq('...and removes exactly one step', noStripe.length, dflt.length - 1);
ok('...and still signs the agreement', noStripe.includes(STEP_KEYS.AGREEMENT_SIGNED));
ok('...and still collects the emergency contact',
  noStripe.includes(STEP_KEYS.EMERGENCY_AND_PREFS));
ok('...and leaves the document screens alone',
  noStripe.includes(STEP_KEYS.POLICIES_ACKNOWLEDGED) && noStripe.includes(STEP_KEYS.ADDITIONAL_ACKS));

// The shape a provider like Jeff actually has: pays instructors himself, uses
// some documents, no training.
const jeffish = effectiveStepOrder({
  stripePayEnabled: false, additionalEnabled: false, trainingEnabled: false,
});
ok('a no-Stripe provider never shows payment setup',
  !jeffish.includes(STEP_KEYS.STRIPE_SUBMITTED));
eq('...and the wizard is shorter by exactly the two dropped steps',
  jeffish.length, dflt.length - 2);
eq('...emergency contact is still last', jeffish[jeffish.length - 1], STEP_KEYS.EMERGENCY_AND_PREFS);

// --- the toggles compose, they do not fight --------------------------------
const lean = effectiveStepOrder({
  bgcEnabled: false, trainingEnabled: false,
  policiesEnabled: false, additionalEnabled: false,
});
ok('a fully pared-down org drops the background check', !lean.includes(STEP_KEYS.CHECKR_SUBMITTED));
ok('...drops both document screens',
  !lean.includes(STEP_KEYS.POLICIES_ACKNOWLEDGED) && !lean.includes(STEP_KEYS.ADDITIONAL_ACKS));
// STEP_ORDER is 9; training is opt-in so the default is 8. Dropping the
// background check and both document screens leaves 5: welcome, business
// eligibility, the agreement, payment setup, emergency contact.
eq('...and still leaves a real wizard', lean.length, 5);
eq('...welcome first', lean[0], STEP_KEYS.WELCOME);
eq('...emergency last', lean[lean.length - 1], STEP_KEYS.EMERGENCY_AND_PREFS);

const everything = effectiveStepOrder({
  bgcEnabled: true, trainingEnabled: true,
  policiesEnabled: true, additionalEnabled: true,
});
eq('everything on is the full order plus training', everything.length, STEP_ORDER.length);
ok('everything on includes training', everything.includes(STEP_KEYS.TRAINING_COMPLETED));

// --- order is never scrambled ---------------------------------------------
//
// Screens are filtered out, never reordered. Signing the agreement after the
// emergency contact would be nonsense, and stepNumber drives the "step 3 of 7"
// label the instructor reads.
for (const opts of [
  {}, { policiesEnabled: false }, { additionalEnabled: false },
  { policiesEnabled: false, additionalEnabled: false },
  { bgcEnabled: false, policiesEnabled: false },
]) {
  const order = effectiveStepOrder(opts);
  const canonical = STEP_ORDER.filter((k) => order.includes(k));
  ok(`order preserved for ${JSON.stringify(opts)}`, order.join() === canonical.join());
  ok(`no duplicates for ${JSON.stringify(opts)}`, new Set(order).size === order.length);
  ok(`every entry is a real step for ${JSON.stringify(opts)}`,
    order.every((k) => STEP_ORDER.includes(k)));
}

// --- numbering follows the effective order, not the canonical one ----------
//
// Otherwise an org with two screens switched off tells the instructor they are
// on "step 6 of 9" while showing them the fourth thing they have seen.
const trimmed = effectiveStepOrder({ policiesEnabled: false, additionalEnabled: false });
eq('emergency is the 8th step by default',
  stepNumber(STEP_KEYS.EMERGENCY_AND_PREFS, effectiveStepOrder()), 8);
eq('emergency renumbers to 6 when two screens are dropped',
  stepNumber(STEP_KEYS.EMERGENCY_AND_PREFS, trimmed), 6);
eq('a dropped step has no index', stepIndex(STEP_KEYS.POLICIES_ACKNOWLEDGED, trimmed), -1);
eq('a dropped step has no number', stepNumber(STEP_KEYS.POLICIES_ACKNOWLEDGED, trimmed), null);

// --- the server agrees ------------------------------------------------------
//
// gateCheck.ts holds its own copy of the required-step list. A rename here that
// is not mirrored there resurrects the exact stall this build exists to avoid,
// and no build or type check would notice. Cheap to pin the two strings.
import { readFileSync } from 'node:fs';
const gate = readFileSync(new URL('../../supabase/functions/_shared/gateCheck.ts', import.meta.url), 'utf8');
ok('gateCheck still knows the policies step key',
  gate.includes(`'${STEP_KEYS.POLICIES_ACKNOWLEDGED}'`));
ok('gateCheck still knows the additional step key',
  gate.includes(`'${STEP_KEYS.ADDITIONAL_ACKS}'`));
ok('gateCheck drops the policies step when its documents are all off',
  /policiesRequired[\s\S]{0,200}policies_acknowledged/.test(gate));
ok('gateCheck drops the additional step when its documents are all off',
  /additionalRequired[\s\S]{0,200}additional_acks/.test(gate));
ok('gateCheck reads the document config column',
  gate.includes('instructor_document_config'));

// The Stripe step needs BOTH halves server-side, and the second is the one that
// silently strands people: drop the step but leave stripeReady demanding
// stripe_payouts_enabled, and every instructor at a no-Stripe provider finishes
// the wizard and parks on 'pending_stripe' — whose only recovery is a payment
// screen they are no longer shown.
ok('gateCheck reads the instructor pay flag',
  gate.includes('instructor_pay_enabled'));
ok('gateCheck drops the stripe step when the provider does not use Stripe pay',
  /stripePayRequired[\s\S]{0,160}stripe_submitted/.test(gate));
ok('gateCheck ALSO relaxes the payouts-live condition',
  /stripeReady\s*=\s*!stripePayRequired\s*\|\|/.test(gate));
ok('...and still requires payouts live when the provider DOES use Stripe pay',
  /stripeReady[\s\S]{0,80}stripe_payouts_enabled === true/.test(gate));

// --- the server's copy of the step grouping must match the browser's ---------
//
// instructorDocumentConfig.ts holds DOCUMENTS_BY_STEP, duplicating what lives on
// INSTRUCTOR_DOCUMENTS[].step. Its own header says "change one, change the
// other" — a rule enforced, until now, by nothing.
//
// The failure that allows: add an 8th document with step:'policies' to
// instructorDocuments.js and forget this file. The wizard then fetches and
// requires FOUR policy documents while the gate computes policiesRequired from a
// three-key list. A provider who switches the original three off gets the screen
// rendered by the wizard while 'policies_acknowledged' is dropped from the
// required set — or, with the edit made the other way round, the gate waits
// forever for a step key nobody can write. Both are silent and neither a build
// nor a type check would notice.
//
// Parsed off disk rather than imported: the .ts is Deno source with type
// annotations node will not run. The regex match is asserted, so a rename fails
// loudly instead of quietly testing nothing.
import { documentKeysForStep } from './instructorDocuments.js';

const serverSrc = readFileSync(
  new URL('../../supabase/functions/_shared/instructorDocumentConfig.ts', import.meta.url),
  'utf8',
);
const byStepMatch = /DOCUMENTS_BY_STEP[^=]*=\s*\{([\s\S]*?)\n\};/.exec(serverSrc);
ok('DOCUMENTS_BY_STEP was found in the server mirror', Boolean(byStepMatch));

if (byStepMatch) {
  const parseGroup = (step) => {
    const m = new RegExp(`${step}\\s*:\\s*\\[([^\\]]*)\\]`).exec(byStepMatch[1]);
    if (!m) return null;
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  for (const step of ['agreement', 'policies', 'additional']) {
    const server = parseGroup(step);
    ok(`server mirror declares the '${step}' group`, Array.isArray(server) && server.length > 0);
    eq(`'${step}' group matches the browser definition exactly`,
      (server ?? []).join(','), documentKeysForStep(step).join(','));
  }
  // Nothing extra, nothing missing, across the whole file.
  const allServer = ['agreement', 'policies', 'additional'].flatMap((s) => parseGroup(s) ?? []);
  const allBrowser = ['agreement', 'policies', 'additional'].flatMap((s) => documentKeysForStep(s));
  eq('the two sides cover exactly the same key set',
    [...allServer].sort().join(','), [...allBrowser].sort().join(','));
  ok('the server mirror pins the agreement as always-on',
    /ALWAYS_ON[\s\S]{0,120}contractor_agreement/.test(serverSrc));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
