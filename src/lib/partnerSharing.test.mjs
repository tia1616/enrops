// Pins the partner-sharing wording and its version. The database records which
// version each instructor agreed to and agree_partner_sharing() accepts only
// 'v1', so a change to the sentence without a version bump (and a migration)
// would make the record claim people agreed to words they never saw.
import { readFileSync } from 'node:fs';
import { PARTNER_SHARING_VERSION, partnerSharingText } from './partnerSharing.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

const V1 =
  'I agree that Acme Kids may share my name, email, phone, background check status and date, ' +
  'and training and acknowledgment dates with the partner organizations ' +
  '(i.e. schools and community centers) where I teach. ' +
  'They will never share my background check report.';

ok('version is v1', PARTNER_SHARING_VERSION === 'v1');
ok('v1 wording unchanged', partnerSharingText('Acme Kids') === V1);
ok('name is trimmed', partnerSharingText('  Acme Kids ') === V1);
ok('no name falls back to true wording', partnerSharingText('').startsWith('I agree that the program provider may'));
ok('dollar signs in a name are literal', partnerSharingText('Kids $$ Co').includes('Kids $$ Co may share'));

// The database function must accept exactly the version the page sends.
const sql = readFileSync(new URL('../../supabase/migrations/20261019a_instructor_partner_sharing.sql', import.meta.url), 'utf8');
ok('migration accepts the current version', sql.includes(`p_version is distinct from '${PARTNER_SHARING_VERSION}'`));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
