// Provider-record tabs: the dot on a tab and the tab a link opens.
import { alertFor, tabFromHash, sectionFromHash, worstAlert, decisionTag } from './recordTabs.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)})`); }
}

eq('all current: no dot', alertFor([{ tone: 'good' }, { tone: 'good' }]), null);
eq('one missing: red', alertFor([{ tone: 'good' }, { tone: 'bad' }, { tone: 'warn' }]), 'bad');
eq('expiring: amber', alertFor([{ tone: 'good' }, { tone: 'warn' }]), 'attention');
eq('in review: amber', alertFor([{ tone: 'review' }]), 'attention');
eq('neutral is not a problem', alertFor([{ tone: 'neutral' }]), null);
eq('nothing: no dot', alertFor([]), null);
eq('missing list: no dot', alertFor(undefined), null);

eq('no decision: no tag', decisionTag(null), null);
eq('accepted', decisionTag('accepted'), { text: 'Accepted', alert: null });
eq('accepted alongside own form reads Accepted', decisionTag('accepted_alongside_own_form'), { text: 'Accepted', alert: null });
eq('not accepted is red', decisionTag('not_accepted'), { text: 'Not accepted', alert: 'bad' });
eq('withdrawn', decisionTag('withdrawn'), { text: 'Withdrawn', alert: null });

const IDS = ['documents', 'classes', 'instructors', 'emails'];
eq('link opens its tab', tabFromHash('#classes', IDS), 'classes');
eq('no hash: first tab', tabFromHash('', IDS), 'documents');
eq('unknown hash: first tab', tabFromHash('#logins', IDS), 'documents');
eq('a magic-link hash is not a tab', tabFromHash('#access_token=abc&type=magiclink', IDS), 'documents');

// Grouped tabs (Jessica 2026-11-25: "too many tabs"): old links still land.
const PROVIDER = ['todo', 'classes', 'safety', 'people'];
const PA = { documents: 'safety', instructors: 'safety', decision: 'safety', requirements: 'safety', logins: 'people', emails: 'people' };
eq('provider: no hash opens To do', tabFromHash('', PROVIDER, PA), 'todo');
eq('old #documents opens Safety record', tabFromHash('#documents', PROVIDER, PA), 'safety');
eq('old #logins opens People & emails', tabFromHash('#logins', PROVIDER, PA), 'people');
eq('...at the logins section', sectionFromHash('#logins', PROVIDER, PA), 'logins');
eq('a whole tab is not a section', sectionFromHash('#safety', PROVIDER, PA), null);
eq('unknown hash: first tab, no section', [tabFromHash('#nope', PROVIDER, PA), sectionFromHash('#nope', PROVIDER, PA)], ['todo', null]);
eq('an alias never borrows a prototype key', tabFromHash('#constructor', PROVIDER, PA), 'todo');
const PARTNER = ['classes', 'safety', 'emails'];
const PAA = { documents: 'safety', instructors: 'safety', requirements: 'safety', decision: 'safety' };
eq('partner: no hash opens Classes', tabFromHash('', PARTNER, PAA), 'classes');
eq('partner: #emails is a real tab', [tabFromHash('#emails', PARTNER, PAA), sectionFromHash('#emails', PARTNER, PAA)], ['emails', null]);
eq('partner: old #decision opens Safety record at Decision', [tabFromHash('#decision', PARTNER, PAA), sectionFromHash('#decision', PARTNER, PAA)], ['safety', 'decision']);
eq('worst dot', [worstAlert(null, 'attention', null), worstAlert('attention', 'bad'), worstAlert(null, null)], ['attention', 'bad', null]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
