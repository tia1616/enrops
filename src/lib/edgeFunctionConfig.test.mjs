// A RATCHET ON supabase/config.toml, not a demand that it be finished today.
//
// The 2026-08-13 incident: deploying with --no-verify-jwt turned JWT verification
// OFF on five authed onboarding endpoints, and redeploying "correctly" without
// the flag did NOT put it back — the CLI omits the field for any function with no
// config entry, so the API keeps whatever the last deploy set. The file's header
// note that unlisted functions "default to verify_jwt = true" is true at CREATION
// only, and is not a safety net.
//
// Pinning all 105 is real work with a real trap in it (backup-storage-objects must
// stay false or the only off-site backup of signed agreements dies silently), so it
// is not done in one go. This test freezes today's unlisted set as an allowlist:
// every EXISTING gap stays tolerated, and the next NEW function has to make a
// decision. It fails on function 106, not after all 76 are pinned.
//
// To satisfy it when you add a function: add a [functions.<name>] table with an
// explicit verify_jwt, or — if it genuinely needs no entry — add it to
// KNOWN_UNPINNED below with a reason. The second option is deliberately annoying.

import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

const fnDir = new URL('../../supabase/functions/', import.meta.url);
const configSrc = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');

const dirs = readdirSync(fnDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== '_shared' && !e.name.startsWith('.'))
  .map((e) => e.name)
  .sort();

// Strip comments first: several function names appear only inside explanatory
// notes, and a name in a comment is not a pinned setting. This is the same
// grep-finds/reading-confirms mistake that has bitten twice in this repo.
const tables = [...configSrc.replace(/^\s*#.*$/gm, '').matchAll(/^\[functions\.([\w-]+)\]/gm)]
  .map((m) => m[1]);

ok('config.toml parsed some [functions.*] tables', tables.length > 0);
eq('no function is listed twice', new Set(tables).size, tables.length);

// A table for a directory that does not exist is dead config pointing at nothing.
const orphans = tables.filter((t) => !dirs.includes(t));
eq('every [functions.*] table has a real directory', orphans.join(','), '');

// Every listed function must actually STATE verify_jwt — a table with only a
// comment in it looks pinned and pins nothing.
const unset = tables.filter((t) => {
  const at = configSrc.indexOf(`[functions.${t}]`);
  const next = configSrc.indexOf('\n[', at + 1);
  const block = configSrc.slice(at, next === -1 ? undefined : next);
  return !/^\s*verify_jwt\s*=\s*(true|false)\s*$/m.test(block);
});
eq('every listed function states verify_jwt explicitly', unset.join(','), '');

// The one the header calls out by name. Vault-secret auth; the only off-site
// backup of signed contractor agreements and BGC PDFs. Pinning it TRUE kills it
// with no visible failure, so it gets its own assertion rather than riding along
// in the allowlist.
{
  const at = configSrc.indexOf('[functions.backup-storage-objects]');
  ok('backup-storage-objects is pinned', at > 0);
  if (at > 0) {
    const next = configSrc.indexOf('\n[', at + 1);
    ok('backup-storage-objects is pinned FALSE',
      /verify_jwt\s*=\s*false/.test(configSrc.slice(at, next === -1 ? undefined : next)));
  }
}

// ── the ratchet ───────────────────────────────────────────────────────────
// Frozen 2026-08-13. Shrink it, never grow it.
// GENERATED FROM THE DIRECTORY, not typed from memory. The first draft of this
// list was hand-written and was wrong in both directions at once — 44 functions
// missing and 34 named that were already pinned — which is exactly the failure
// the ratchet exists to prevent, committed while writing the ratchet.
const KNOWN_UNPINNED = new Set([
  'admin-confirm-session', 'admin-import-camp-roster', 'admin-import-program-roster',
  'admin-invite', 'admin-list-members', 'admin-remove-member',
  'admin-remove-registration', 'admin-set-member-role', 'confirm-session-delivery',
  'confirm-session-taught', 'confirm-sub-delivery', 'contractor-invite',
  'create-assignment-substitution', 'create-checkout', 'create-checkr-candidate',
  'create-stripe-connect-account', 'create-stripe-express-login-link', 'create-stripe-operator-login-link',
  'delivery-issue-action', 'email-camp-roster', 'email-program-roster',
  'ennie-recommend', 'export-finances', 'extract-contacts',
  'extract-curriculum-details', 'extract-district-calendar', 'extract-schedule-details',
  'fetch-drive-document', 'get-instructor-curriculum-docs', 'get-legal-document',
  'get-training-video-url', 'google-oauth-callback', 'import-class-schedule',
  'import-contacts', 'import-partners-extract', 'import-partners-parse',
  'import-partners-write', 'invite-parents', 'link-instructor',
  'marketing-delete-draft', 'marketing-touchpoint-cron', 'match-afterschool',
  'match-instructors', 'notify-instructor-removed', 'notify-program-curriculum-change',
  'offer-message-reply', 'offer-reminders-cron', 'pay-instructor',
  'polish-skills', 'refund-registration', 'replay-digest',
  'request-resume-onboarding', 'respond-to-assignment', 'respond-to-sub-offer',
  // The four offer senders came OFF this list on 2026-08-18: a parity sweep found
  // them deployed verify_jwt=false on staging and true on prod, so they are now
  // pinned true in config.toml. The ratchet tightens by four.
  'send-afterschool-survey', 'send-availability-survey',
  'stripe-connect-onboard', 'stripe-oauth-disconnect', 'stripe-oauth-start',
  'submit-acknowledgments', 'submit-agreement', 'submit-feedback',
  'submit-onboarding-declined', 'submit-ors-certification', 'submit-training-quiz',
  'tenant-sender', 'training-progress', 'update-contact',
  'update-instructor-profile', 'update-org-logo', 'wufoo-sync',
]);

const unlisted = dirs.filter((d) => !tables.includes(d));
const newlyUnlisted = unlisted.filter((d) => !KNOWN_UNPINNED.has(d));

ok(`no NEW function was added without a verify_jwt decision${newlyUnlisted.length ? ` — ${newlyUnlisted.join(', ')}` : ''}`,
  newlyUnlisted.length === 0);

// If the allowlist names something that is now pinned (or deleted), shrink it —
// otherwise the ratchet slowly stops meaning anything.
const staleAllowlist = [...KNOWN_UNPINNED].filter((n) => !unlisted.includes(n));
ok(`the allowlist has no stale entries${staleAllowlist.length ? ` — remove: ${staleAllowlist.join(', ')}` : ''}`,
  staleAllowlist.length === 0);

console.log(`\n${dirs.length} functions, ${tables.length} pinned, ${unlisted.length} tolerated by the allowlist`);
console.log(fail === 0 ? `ALL PASS  (${pass} passed, 0 failed)` : `FAILURES  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
