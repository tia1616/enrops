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

// --- the contractor-status step --------------------------------------------
//
// Screen 3 became a document screen on 2026-08-21. Until then it was
// UNCONDITIONAL: every instructor at every provider saw hardcoded platform text
// backed by nothing, which is exactly why no provider could find it in Settings.
// It is now one document on its own step, so a single toggle removes it.
//
// THE DEFAULT IS THE IMPORTANT HALF. Every existing org has no value for this key,
// so `true` here is what keeps today's behaviour for every provider on both
// environments. If this ever defaults false, Screen 3 silently disappears for
// everyone and nothing errors.
ok('contractor status is present by default', dflt.includes(STEP_KEYS.ORS_CERTIFICATION));

const noContractorStatus = effectiveStepOrder({ contractorStatusEnabled: false });
ok('contractorStatusEnabled:false drops the contractor status screen',
  !noContractorStatus.includes(STEP_KEYS.ORS_CERTIFICATION));
eq('...and removes exactly one step', noContractorStatus.length, dflt.length - 1);
ok('...and still signs the agreement',
  noContractorStatus.includes(STEP_KEYS.AGREEMENT_SIGNED));
ok('...and leaves the other document screens alone',
  noContractorStatus.includes(STEP_KEYS.POLICIES_ACKNOWLEDGED)
    && noContractorStatus.includes(STEP_KEYS.ADDITIONAL_ACKS));
ok('...and welcome is still first', noContractorStatus[0] === STEP_KEYS.WELCOME);
// Composes with the others rather than fighting them: all three document steps off
// leaves the agreement, which is never toggleable.
const noDocs = effectiveStepOrder({
  contractorStatusEnabled: false, policiesEnabled: false, additionalEnabled: false,
});
eq('all three document steps off removes exactly three', noDocs.length, dflt.length - 3);
ok('...and the agreement survives all three', noDocs.includes(STEP_KEYS.AGREEMENT_SIGNED));

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
// background check and the policies/additional screens leaves 5: welcome,
// independent contractor status, the agreement, payment setup, emergency contact.
// (`lean` passes nothing for contractorStatusEnabled, so that step stays — which is
// the default this file pins above.)
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
// THE HALF THAT STRANDS PEOPLE SILENTLY. The wizard dropping Screen 3 is the easy
// half; if gateCheck keeps 'ors_certification' in requiredSteps, a provider who
// switches this document off has every instructor finish every screen they are shown
// and never reach 'complete' — no error, no email, nothing to click, and the only
// visible symptom is a status that never moves. Pinned as three separate facts
// because each can be edited away on its own.
ok('gateCheck still knows the contractor status step key',
  gate.includes(`'${STEP_KEYS.ORS_CERTIFICATION}'`));
ok('gateCheck resolves the contractor status document group',
  /contractorStatusRequired\s*=\s*stepHasEnabledDocuments\(\s*docCfg\s*,\s*'contractor_status'\s*\)/.test(gate));
ok('gateCheck drops the contractor status step when its document is off',
  /!contractorStatusRequired[\s\S]{0,120}ors_certification/.test(gate));
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
import { DOCUMENT_KEYS, documentKeysForStep, INSTRUCTOR_DOCUMENTS } from './instructorDocuments.js';

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
  // EVERY STEP, and the list is written down once. Spelled inline three times, this
  // block quietly stopped covering the whole contract the moment a FOURTH step
  // existed: `contractor_status` became its own step on 2026-08-21, both sides
  // omitted it from these three lists, and "the two sides cover exactly the same key
  // set" went on passing because it compared two equally incomplete sets. A coverage
  // assertion that silently narrows is worse than none — it reads as proof.
  //
  // Cross-checked against the browser module below, so adding a fifth step to
  // instructorDocuments.js and not to this list fails here instead of going unnoticed.
  const ALL_STEPS = ['contractor_status', 'agreement', 'policies', 'additional'];
  eq('this test knows about every step the browser module declares',
    [...new Set(INSTRUCTOR_DOCUMENTS.map((d) => d.step))].sort().join(','),
    [...ALL_STEPS].sort().join(','));

  for (const step of ALL_STEPS) {
    const server = parseGroup(step);
    ok(`server mirror declares the '${step}' group`, Array.isArray(server) && server.length > 0);
    eq(`'${step}' group matches the browser definition exactly`,
      (server ?? []).join(','), documentKeysForStep(step).join(','));
  }
  // Nothing extra, nothing missing, across the whole file.
  const allServer = ALL_STEPS.flatMap((s) => parseGroup(s) ?? []);
  const allBrowser = ALL_STEPS.flatMap((s) => documentKeysForStep(s));
  eq('the two sides cover exactly the same key set',
    [...allServer].sort().join(','), [...allBrowser].sort().join(','));
  // ...and that set is the WHOLE document list, not a subset both happen to share.
  eq('and that set is every document the browser defines',
    [...allBrowser].sort().join(','), [...DOCUMENT_KEYS].sort().join(','));
  // The step union must also match the TYPE the server declares, or a group can be
  // present in DOCUMENTS_BY_STEP while DocumentStep refuses to accept its name and
  // gateCheck cannot ask about it. deno check catches this one; pinned here too
  // because CI runs deno with --no-check.
  ok('the server DocumentStep type names every step',
    ALL_STEPS.every((s) => new RegExp(`DocumentStep\\s*=[^;]*'${s}'`).test(serverSrc)));
  ok('the server mirror pins the agreement as always-on',
    /ALWAYS_ON[\s\S]{0,120}contractor_agreement/.test(serverSrc));

  // THE OPT-IN MECHANISM IS GONE FROM BOTH SIDES, as of 2026-08-21.
  // contractor_status was the only key that ever needed an explicit true, so the
  // DEFAULT_OFF set existed for it alone. The document was deleted as redundant with
  // the contractor agreement and then RESTORED the same day as an ordinary default-ON
  // document backing its own screen — the DEFAULT_OFF set did not come back with it,
  // and this block is what keeps it from creeping back on one side only.
  //
  // These pin the ABSENCE ON BOTH SIDES, not the removal on one, because the drift
  // this block has always guarded is bad in both directions and a HALF-REMOVAL is
  // the same defect as a half-addition: if only the browser dropped the mechanism,
  // the gate would keep requiring a screen the wizard now skips and onboarding
  // would stall at 100% forever; if only the server dropped it, every instructor
  // would be shown a document their provider never wrote, and the fetch would 404
  // them into a dead end.
  //
  // COMMENTS STRIPPED FIRST. This repo has already shipped a raw grep that matched
  // the comment explaining the very thing it was meant to catch, and the server
  // mirror now carries a paragraph naming contractor_status as deleted — so an
  // unstripped absence check would be held green by the obituary itself.
  const serverCode = serverSrc
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
  ok('the comment stripper ran and left the code intact',
    serverCode.length < serverSrc.length
      && /export function isDocumentEnabled/.test(serverCode));

  // The server mirror MUST name the restored key in code, not only in its comment
  // history. If it does not, gateCheck asks stepHasEnabledDocuments about a step
  // whose group is undefined, `.some()` on undefined throws, and runGateCheck dies
  // for every instructor at every org — so this is asserted against comment-stripped
  // source, the same way its "is it absent" predecessor was.
  ok('the server mirror knows the restored key',
    /contractor_status/.test(serverCode));
  ok('the server mirror has no opt-in set left', !/DEFAULT_OFF/.test(serverCode));
  ok('the browser half has no opt-in flag left',
    INSTRUCTOR_DOCUMENTS.every((d) => d.defaultOff === undefined));

  // ...and neither side kept a strict-true branch, which is now the only place the
  // two rules could still diverge. Both must read plain `!== false`: absent means
  // ON, with nothing to remember.
  ok('the server mirror tests only for an explicit false',
    /return\s+config\?\.\[key\]\s*!==\s*false/.test(serverCode));
  ok('the server mirror has no strict-true branch left',
    !/===\s*true/.test(serverCode));
}

// --- the agreement tick boxes and the server gate must name the SAME keys ---
//
// submit-agreement keeps its own list of required confirms and returns 400
// all_confirms_required for any key that is absent. It is a GATE, not a mirror
// of the screen — so the failure is asymmetric and brutal:
//
//   key on the screen but not the server -> the extra tick is never recorded
//   key on the server but not the screen -> NOBODY CAN SIGN, AT ALL. Every
//     contractor hits 400 on the last action of the agreement screen, with
//     nothing on the page to correct.
//
// Two tick boxes were retired on 2026-08-12 and a third earlier. Each time, both
// sides had to move together. Nothing enforced that until this test.
//
// Parsed off disk: the edge function is Deno source. Both regexes are asserted
// to have matched, so a rename fails loudly rather than silently comparing two
// empty lists — which would "pass" forever.
const screenSrc = readFileSync(
  new URL('../pages/onboarding/screens/Screen4Agreement.jsx', import.meta.url), 'utf8');
const agreementFnSrc = readFileSync(
  new URL('../../supabase/functions/submit-agreement/index.ts', import.meta.url), 'utf8');

const confirmsBlock = /const CONFIRMS = \[([\s\S]*?)\n\];/.exec(screenSrc);
ok('Screen 4 CONFIRMS list was found', Boolean(confirmsBlock));
const serverBlock = /const confirms = \{([\s\S]*?)\n\s*\};/.exec(agreementFnSrc);
ok('submit-agreement required-confirms block was found', Boolean(serverBlock));

if (confirmsBlock && serverBlock) {
  const screenKeys = [...confirmsBlock[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const serverKeys = [...serverBlock[1].matchAll(/([a-z_]+):\s*body\./g)].map((m) => m[1]);
  ok('the screen actually lists some tick boxes', screenKeys.length > 0);
  ok('the server actually requires some confirms', serverKeys.length > 0);
  eq('screen tick boxes and server required confirms match exactly',
    [...screenKeys].sort().join(','), [...serverKeys].sort().join(','));

  // The retired ones must not have crept back into EITHER side. If one returns
  // to the server only, nobody can sign.
  for (const retired of ['confirm_pay_structure', 'confirm_confidentiality_ip', 'confirm_supersedes_prior']) {
    ok(`${retired} is not required by the server`, !serverKeys.includes(retired));
    ok(`${retired} is not a tick box on the screen`, !screenKeys.includes(retired));
  }

  // A retired column must never be WRITTEN true — it has to fall to its NOT NULL
  // DEFAULT false, i.e. "not separately attested". Writing true would fabricate
  // an attestation nobody was shown, which is the exact bug removed from the ORS
  // certification.
  const insertBlock = /\.insert\(\{([\s\S]*?)\n\s*\}\)/.exec(agreementFnSrc);
  ok('submit-agreement insert block was found', Boolean(insertBlock));
  if (insertBlock) {
    for (const retired of ['confirm_pay_structure', 'confirm_confidentiality_ip', 'confirm_supersedes_prior']) {
      ok(`${retired} is not written on insert (falls to DEFAULT false)`,
        !new RegExp(`^\\s*${retired}\\s*:`, 'm').test(insertBlock[1]));
    }
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
