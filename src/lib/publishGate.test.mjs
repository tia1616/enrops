// Regression tests for the Stripe publish gate. Pure - inline fixtures, no deps.
// Run: `node src/lib/publishGate.test.mjs`
//
// The rule is enforced TWICE (screens + a database trigger) because a UI-only
// gate shipped the morning of 2026-08-09 and was bypassable from devtools by
// that afternoon. Most of the risk in this feature is therefore drift: the two
// copies of the rule disagreeing. The source-reading assertions at the bottom
// are the ones that catch that; the pure ones pin the rule itself.
import { readFileSync } from 'node:fs';
import {
  takesMoneyThroughEnrops,
  publishBlockedByStripe,
  publishErrorMessage,
  PUBLISH_GATE_SQLSTATE,
  STRIPE_CONNECT_ROUTE,
} from './publishGate.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

const NO_STRIPE   = { uses_enrops_registration: true, stripe_charges_enabled: false };
const WITH_STRIPE = { uses_enrops_registration: true, stripe_charges_enabled: true };
// shoreview-chess / mrs-richelle: families register somewhere else entirely.
const OWN_REG_ORG = { uses_enrops_registration: false, stripe_charges_enabled: false };
const PAID        = { price_cents: 15000, runs_own_registration: false };
const FREE        = { price_cents: 0, runs_own_registration: false };
const PARTNER_RUN = { price_cents: 15000, runs_own_registration: true };

// --- the rule ---
eq('paid + enrops-run + no Stripe -> BLOCKED', publishBlockedByStripe(NO_STRIPE, PAID), true);
eq('paid + Stripe connected -> allowed',       publishBlockedByStripe(WITH_STRIPE, PAID), false);

// The three exemptions. Each is a real row on prod, not a hypothetical.
eq('free class needs no Stripe',        publishBlockedByStripe(NO_STRIPE, FREE), false);
eq('school collects -> needs no Stripe', publishBlockedByStripe(NO_STRIPE, PARTNER_RUN), false);
eq('org registers elsewhere -> exempt',  publishBlockedByStripe(OWN_REG_ORG, PAID), false);

// price_cents is NOT NULL on programs, but the builders call this with in-progress
// form values where the field can still be blank. Blank is not "paid".
eq('missing price is not paid', takesMoneyThroughEnrops(NO_STRIPE, {}), false);
eq('null price is not paid',    takesMoneyThroughEnrops(NO_STRIPE, { price_cents: null }), false);
eq('NaN price is not paid',     takesMoneyThroughEnrops(NO_STRIPE, { price_cents: NaN }), false);

// --- fails OPEN while the org is still loading, on purpose ---
// undefined means the org row (or the charges lookup) has not resolved. Blocking
// then would strand a CONNECTED operator behind a button that cannot explain
// itself; allowing it costs one honest error from the trigger, which is the real
// gate. This mirrors every other Stripe check in the admin (=== false, not !).
eq('org still loading -> not blocked', publishBlockedByStripe(undefined, PAID), false);
eq('charges unknown -> not blocked',   publishBlockedByStripe({ uses_enrops_registration: true }, PAID), false);
eq('charges null -> not blocked',      publishBlockedByStripe({ stripe_charges_enabled: null }, PAID), false);

// uses_enrops_registration is NOT NULL DEFAULT true, so an org row that simply
// omits it is an org that DOES take registrations here.
eq('unset uses_enrops_registration still gated', publishBlockedByStripe({ stripe_charges_enabled: false }, PAID), true);

// --- error surfacing ---
eq('the trigger message is passed through',
   publishErrorMessage({ code: PUBLISH_GATE_SQLSTATE, message: 'Connect Stripe before you publish a paid class.' }),
   'Connect Stripe before you publish a paid class.');
eq('an unrelated failure keeps its own text',
   publishErrorMessage({ code: '23505', message: 'duplicate key value' }),
   'duplicate key value');
eq('no error -> empty string', publishErrorMessage(null), '');

// --- DRIFT PINS: the same rule, written twice, must stay the same rule ---
const sql = readFileSync(
  new URL('../../supabase/migrations/20260810c_require_stripe_to_publish.sql', import.meta.url),
  'utf8',
);
// Every input of the JS rule has to appear in the SQL one. Drop an exemption
// from the trigger and an operator gets a green button and a Postgres error.
for (const col of ['runs_own_registration', 'price_cents', 'uses_enrops_registration', 'stripe_charges_enabled']) {
  eq(`trigger still reads ${col}`, sql.includes(col), true);
}
// The SQLSTATE the frontend recognises. Change it in one place only and every
// publish failure starts reading like Postgres prose again.
eq('trigger raises the SQLSTATE the frontend matches',
   sql.includes(`errcode = '${PUBLISH_GATE_SQLSTATE}'`), true);
// BEFORE UPDATE must not be narrowed to "OF status": pricing a free open class
// and taking over a partner-run one both open a money path without touching status.
eq('update trigger is not narrowed to OF status',
   /before update on public\.programs/.test(sql) && !/before update of [a-z_]+ on public\.programs/.test(sql), true);
// Grandfathering is the shape of the whole rule, not a detail: only the
// TRANSITION into open+paid is blocked, so a live class survives a disconnect.
eq('trigger grandfathers rows that were already gated', sql.includes('v_old_gated'), true);

// The gate reads two org columns. Neither reaches a screen unless AdminLayout
// selects it, and a missing column resolves to undefined -> fails open -> the
// gate silently does nothing. No pure assertion can see that.
const adminLayout = readFileSync(new URL('../layouts/AdminLayout.jsx', import.meta.url), 'utf8');
const orgSelect = adminLayout.match(/\.select\(\s*"([^"]*instructor_pay_model[^"]*)"\s*\)/);
eq('AdminLayout org query was found', Boolean(orgSelect), true);
eq('AdminLayout still selects stripe_charges_enabled',
   Boolean(orgSelect && orgSelect[1].includes('stripe_charges_enabled')), true);
eq('AdminLayout still selects uses_enrops_registration',
   Boolean(orgSelect && orgSelect[1].includes('uses_enrops_registration')), true);

// All three publish paths must go through this module. A fourth publish button
// written later that hand-rolls the check is how the rule starts to rot.
for (const f of ['QuickProgramBuilder.jsx', 'ProgramWizardNew.jsx', 'ProgramsCalendar.jsx']) {
  const src = readFileSync(new URL(`../pages/admin/programs/${f}`, import.meta.url), 'utf8');
  eq(`${f} uses the shared gate`, /from ["'][^"']*lib\/publishGate(\.js)?["']/.test(src), true);
}

// The only route in the app that starts the Stripe redirect. A gate that sends
// an operator anywhere else is a dead end they cannot clear.
eq('connect route is Finances', STRIPE_CONNECT_ROUTE, '/admin/finances');

// The step strip must not promise an order the gate forbids. It used to read
// Enter -> Publish -> Connect Stripe, which since the gate is not merely stale
// but impossible: a paid class cannot leave draft until charges are on, so an
// operator following the pips hits a wall at step 2 that the strip called step 3.
const steps = readFileSync(new URL('../components/ProgramSteps.jsx', import.meta.url), 'utf8');
const gated = steps.match(/const STEPS_NEEDING_STRIPE\s*=\s*\[([^\]]*)\]/);
eq('the Stripe step list was found', Boolean(gated), true);
eq('Connect Stripe comes BEFORE Publish when Stripe is needed',
   Boolean(gated) && gated[1].indexOf('CONNECT_STRIPE') < gated[1].indexOf('PUBLISH_IT'), true);
// And the success screen must not tick that step off while charges are still off:
// a FREE class is exempt from the gate, so it can go live with Stripe missing.
const builder = readFileSync(new URL('../pages/admin/programs/QuickProgramBuilder.jsx', import.meta.url), 'utf8');
eq('success screen does not hardcode the step past Connect Stripe',
   /current=\{notConnected \? 2 : 3\}/.test(builder), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
