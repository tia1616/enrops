// Pins loadTrainingConfig — the client half of the training step's two-sided
// contract with gateCheck.ts.
//
// The failure this guards is silent and permanent: if the client resolves
// trainingEnabled=false while the server still counts training_completed as
// required, the step is never rendered, its key is never written, and the
// instructor finishes every screen and parks one step short forever. That is
// exactly the state staging `j2s` was left in — training on, 1 active required
// video, 3 open onboardings that had never seen the step — because the
// portal-embedded door simply never passed the prop.

import { loadTrainingConfig } from './instructorTrainingConfig.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// A stub that records the filters applied, so the "same filters as the server"
// claim is pinned rather than asserted in a comment.
function stubClient(result) {
  const applied = {};
  const chain = {
    select() { return chain; },
    eq(col, val) { applied[col] = val; return chain; },
    order() { return chain; },
    then(resolve) { return Promise.resolve(result).then(resolve); },
  };
  return {
    applied,
    from(table) { applied._table = table; return chain; },
  };
}

const ORG = 'org-1';
const twoVideos = { data: [
  { id: 'v1', title: 'Safety', duration_seconds: 60 },
  { id: 'v2', title: 'Dismissal', duration_seconds: 90 },
], error: null };

// --- the flag is off -------------------------------------------------------
{
  const c = stubClient(twoVideos);
  const r = await loadTrainingConfig(c, ORG, false);
  eq('flag false -> disabled', r.trainingEnabled, false);
  eq('flag false -> no videos', r.trainingVideos.length, 0);
  eq('flag false -> does not even query', c.applied._table, undefined);
}

// --- enabled with videos ---------------------------------------------------
{
  const c = stubClient(twoVideos);
  const r = await loadTrainingConfig(c, ORG, true);
  eq('enabled + videos -> enabled', r.trainingEnabled, true);
  eq('enabled + videos -> both returned', r.trainingVideos.length, 2);
  eq('reads the right table', c.applied._table, 'instructor_training_videos');
  eq('scoped to the org', c.applied.organization_id, ORG);
  // These two filters MUST match gateCheck.ts's count query exactly. If either
  // drifts, the wizard and the gate disagree about whether the step exists.
  eq('filters on active, like the server', c.applied.active, true);
  eq('filters on is_required, like the server', c.applied.is_required, true);
  ok('never ships quiz answers to the browser',
    !Object.keys(r.trainingVideos[0]).includes('quiz'));
}

// --- enabled but empty -----------------------------------------------------
//
// Inert on BOTH sides, deliberately: gateCheck only requires the step when the
// count is > 0. This is the state the admin toggle guard now refuses to create,
// but orgs an earlier deploy let into it must still resolve safely.
{
  const c = stubClient({ data: [], error: null });
  const r = await loadTrainingConfig(c, ORG, true);
  eq('enabled but empty -> disabled, matching the server', r.trainingEnabled, false);
  eq('enabled but empty -> no videos', r.trainingVideos.length, 0);
}

// --- a failed read is NOT an empty library ---------------------------------
//
// The whole point. Falling through to "no videos" would drop a step the server
// still requires; callers need to be able to fail visibly instead.
{
  const c = stubClient({ data: null, error: { message: 'boom' } });
  const r = await loadTrainingConfig(c, ORG, true);
  ok('read failure surfaces an error', !!r.error);
  eq('read failure does not claim enabled', r.trainingEnabled, false);
}

// --- missing org -----------------------------------------------------------
{
  const c = stubClient(twoVideos);
  const r = await loadTrainingConfig(c, null, true);
  eq('no org id -> disabled', r.trainingEnabled, false);
  eq('no org id -> does not query', c.applied._table, undefined);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
