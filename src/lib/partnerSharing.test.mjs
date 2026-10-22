// Pins the partner-sharing wording and its version. The database records which
// version each instructor agreed to and agree_partner_sharing() accepts only
// the current version, so a change to the sentence without a version bump (and
// a migration) would make the record claim people agreed to words they never saw.
import { readFileSync } from 'node:fs';
import { PARTNER_SHARING_VERSION, partnerSharingText } from './partnerSharing.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

// Arielle's wording, roadmap thread 2026-10-21, verbatim with {provider} = the business.
const V2 =
  'I agree that Acme Kids may share my name, email, phone, screening status, ' +
  'screening date and expiry, the screening company, and my training and acknowledgment dates ' +
  'with the schools and programs where I teach. ' +
  'Acme Kids never shares my background check report. ' +
  'I can stop this at any time.';

ok('version is v2', PARTNER_SHARING_VERSION === 'v2');
ok('v2 wording unchanged', partnerSharingText('Acme Kids') === V2);
ok('name is trimmed', partnerSharingText('  Acme Kids ') === V2);
ok('no name falls back to true wording', partnerSharingText('').startsWith('I agree that the program provider may'));
ok('both name slots filled', !partnerSharingText('Acme Kids').includes('{{'));
ok('dollar signs in a name are literal', partnerSharingText('Kids $$ Co').includes('Kids $$ Co may share'));

// The database function must accept exactly the version the page sends. The
// LATEST migration that redefines agree_partner_sharing is the live one.
const sql = readFileSync(new URL('../../supabase/migrations/20261022a_partner_sharing_v2_and_stop.sql', import.meta.url), 'utf8');
ok('migration accepts the current version', sql.includes(`p_version is distinct from '${PARTNER_SHARING_VERSION}'`));
ok('the promise "stop at any time" has a function behind it', sql.includes('function public.stop_partner_sharing('));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
