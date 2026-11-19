// Provider-record tabs: the dot on a tab and the tab a link opens.
import { alertFor, tabFromHash } from './recordTabs.js';

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

const IDS = ['documents', 'classes', 'instructors', 'emails'];
eq('link opens its tab', tabFromHash('#classes', IDS), 'classes');
eq('no hash: first tab', tabFromHash('', IDS), 'documents');
eq('unknown hash: first tab', tabFromHash('#logins', IDS), 'documents');
eq('a magic-link hash is not a tab', tabFromHash('#access_token=abc&type=magiclink', IDS), 'documents');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
