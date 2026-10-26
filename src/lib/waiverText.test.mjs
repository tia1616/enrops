// Pins renderWaiverText, which had NO tests at all despite rendering the business
// name into every signed waiver — and, since 2026-08-13, into an instructor's
// consent checkbox on Screen 6.
//
// The bug that prompted these: the org name was passed as the second argument to
// String.replace, where it is a PATTERN, not a literal. `$&`, `$'`, "$`" and `$$`
// are substitution directives there. A business called "Kids & Co. $$$", or one
// with an apostrophe-dollar in it, silently rewrote the sentence around itself
// inside a legal document. The fix is the function form of replace; these
// assertions are what stop it being "simplified" back.

import { readFileSync } from 'node:fs';
import { renderWaiverText, splitOnOrgToken, hasOrgToken } from './waiverText.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// --- the ordinary case ----------------------------------------------------
eq('substitutes the name',
  renderWaiverText('I consent to {{org}} recording me', 'Cascade Enrichment'),
  'I consent to Cascade Enrichment recording me');
eq('content with no token is untouched',
  renderWaiverText('No token here', 'Anything'), 'No token here');
eq('every occurrence, not just the first',
  renderWaiverText('{{org}} and {{org}}', 'X'), 'X and X');
eq('tolerates inner whitespace in the token',
  renderWaiverText('{{ org }}', 'X'), 'X');

// --- trimming, which the checkbox depends on ------------------------------
eq('trims a padded name',
  renderWaiverText('by {{org}} today', '  Cascade  '), 'by Cascade today');
// A whitespace-only name is NOT a name. Before this was routed through here, a
// hand-rolled truthiness check let "   " through and rendered
// "I consent to     photographing/recording me" on a legal attestation.
eq('whitespace-only name falls back',
  renderWaiverText('by {{org}} today', '   '), 'by the program provider today');
eq('empty name falls back', renderWaiverText('{{org}}', ''), 'the program provider');
eq('null name falls back', renderWaiverText('{{org}}', null), 'the program provider');
eq('undefined name falls back', renderWaiverText('{{org}}'), 'the program provider');
eq('non-string name falls back', renderWaiverText('{{org}}', 42), 'the program provider');

// --- THE REGRESSION: the name must be a LITERAL, never a pattern ----------
//
// Each of these silently mangled the sentence while the string form was in use.
// They are ordinary things to find in a business name.
eq('$& does not re-insert the token',
  renderWaiverText('by {{org}} today', 'A $& B'), 'by A $& B today');
eq("$' does not insert the following text",
  renderWaiverText('by {{org}} today', "Tom $' Co"), "by Tom $' Co today");
eq('$` does not insert the preceding text',
  renderWaiverText('by {{org}} today', 'A $` B'), 'by A $` B today');
eq('$$ does not collapse to a single dollar',
  renderWaiverText('by {{org}} today', 'Kids & Co. $$$'), 'by Kids & Co. $$$ today');
eq('$1 does not resolve to a capture group',
  renderWaiverText('by {{org}} today', 'Studio $1'), 'by Studio $1 today');
// The fallback goes through the same replace, so it needs the same guarantee.
eq('the fallback is literal too', renderWaiverText('a {{org}} b', null), 'a the program provider b');

// --- the other exports, used by the waiver editor --------------------------
eq('splitOnOrgToken splits', splitOnOrgToken('a {{org}} b').join('|'), 'a | b');
eq('splitOnOrgToken with no token', splitOnOrgToken('plain').join('|'), 'plain');
eq('splitOnOrgToken of empty', splitOnOrgToken('').join('|'), '');
ok('hasOrgToken finds one', hasOrgToken('x {{org}} y'));
ok('hasOrgToken tolerates whitespace', hasOrgToken('{{  org  }}'));
ok('hasOrgToken is false without one', !hasOrgToken('x org y'));
ok('hasOrgToken is false for a non-string', !hasOrgToken(null));

// --- the server twin must not drift ---------------------------------------
//
// supabase/functions/_shared/waiverText.ts renders the SAME token into the same
// legal documents from the edge functions. Fixing only the browser half would
// leave every server-rendered waiver carrying the bug, which is where the signed
// snapshot actually comes from.
{
  const serverSrc = readFileSync(
    new URL('../../supabase/functions/_shared/waiverText.ts', import.meta.url),
    'utf8',
  );
  ok('the server twin uses the function form of replace',
    /\.replace\(\s*ORG_TOKEN\s*,\s*\(\)\s*=>/.test(serverSrc));
  ok('the server twin trims the name',
    /orgName\s*===\s*'string'\s*\?\s*orgName\.trim\(\)/.test(serverSrc));
  ok('the server twin keeps the same fallback wording',
    /'the program provider'/.test(serverSrc));
}

console.log(fail === 0 ? `\nALL PASS  (${pass} passed, 0 failed)` : `\nFAILURES  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
