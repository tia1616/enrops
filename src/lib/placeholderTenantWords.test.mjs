// Guards the CLASS, not the instance: no real tenant's brand or domain may appear in a
// placeholder anywhere in src.
//
// Twice now a live provider's business has been the platform's example. The
// registration-wording fields on /admin/branding said "After-school ukulele classes in
// Portland", and the automations link box offered that provider's actual shop domain -
// both live on prod, both shown to every OTHER operator as our suggestion. Jessica,
// 2026-08-11: "don't have his real website on there either as the example."
//
// WHY THIS LIST IS NOT referral.test.mjs's TENANT_WORDS. That one guards a list of
// answers a FAMILY picks from, so it also bans cities and publications ('portland',
// 'pdx'). Here the risk is narrower and the false-positive cost is higher: "STEAM" and
// "chess" are ordinary words for a kind of programme, and a placeholder is allowed to
// say "e.g. STEAM camp". So this list holds only strings that identify a specific
// tenant - brand names and domains. Keep the two lists separate on purpose; merging
// them would either block legitimate wording here or weaken the referral guard there.
//
// WHAT THIS DOES NOT COVER — do not read a green run as "no tenant is named anywhere".
// It scans only INLINE string literals in a placeholder attribute. A placeholder passed
// as a variable (placeholder={cfg.subjectPlaceholder} in TemplatesTab,
// placeholder={defaultIntro} on the schedule screens) is invisible to it, as are labels,
// help text and default body copy. Those were checked BY HAND on 2026-08-11 and were all
// tenant-neutral — TemplatesTab's examples correctly use {{org_name}} rather than naming
// anyone. If that check needs to be automatic, the honest way is to resolve the constant,
// not to widen this regex until it matches things it cannot understand.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// EVERY live provider, verified against the prod `organizations` table 2026-08-11.
// A previous version of this list held only three of six, so "Mrs. Richelle's math club"
// or "yogaplaygrounds.com/schedule" would have passed the guard whose entire job is to
// stop exactly that. The false-positive argument above justifies leaving BARE ordinary
// words alone ('chess', 'steam', 'yoga', 'chase') — it never justified omitting a brand
// phrase or a domain, which carry no false-positive risk at all.
//
// ⚠ ONBOARDING A PROVIDER MEANS ADDING THEM HERE. Nothing enforces that, and it is the
// weak point of this guard: deriving the list automatically would need the organizations
// table, which a unit test running in CI has no credentials for, and src/lib/tenants.js
// is a v1 single-tenant shim that only knows J2S. So it is a checked-in list, and
// docs/onboarding-checklist.md carries the reminder.
const TENANT_IDENTIFIERS = [
  // Journey to STEAM
  'journeytosteam', 'journey to steam', 'j2s',
  // The Ukulele Project — bare 'ukulele' included because the instrument IS their brand
  'ukulele', 'theukuleleproject', 'the-ukulele-project',
  // Shoreview Chess — bare 'chess' deliberately allowed, the brand phrase is not
  'shoreview', 'shoreview chess', 'shoreviewchess', 'shoreview-chess',
  // Mrs. Richelle
  'richelle',
  // Yoga Playgrounds — bare 'yoga' deliberately allowed. NOTE referral.test.mjs DOES ban
  // bare 'yoga'; that list guards answers a FAMILY reads, where a category word is
  // already too identifying. Different surface, different threshold, both intentional.
  'yoga playgrounds', 'yogaplaygrounds', 'yoga-playgrounds',
  // Chase Youth Programs — bare 'chase' deliberately allowed (it is a verb)
  'chase youth', 'chaseyouth', 'chase-youth',
  // Prospect, not yet a tenant, but named in call notes
  'kumon',
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

// placeholder="..." | placeholder='...' | placeholder={"..."} | placeholder={'...'}
// | placeholder={`...`}  — the attribute an operator actually reads.
const PLACEHOLDER = /placeholder\s*=\s*(?:\{?\s*)(["'`])([\s\S]*?)\1/g;

// The OTHER shape, and the one both real bugs actually took: the copy lives in a named
// constant and the attribute just points at it —
//   const defaultIntro = "After-school ukulele classes in Portland";
//   <textarea placeholder={defaultIntro} />
// So also read string literals assigned to a name that reads like example copy. Matches
// `const x = "…"`, `x: "…"` in a config object, and `x = "…"`. Scoped by NAME rather
// than scanning every string in src, which would be unreadably noisy.
const NAMED_EXAMPLE = /([A-Za-z_$][\w$]*)\s*[:=]\s*(["'`])([\s\S]*?)\2/g;
const EXAMPLE_NAME = /placeholder|intro|hint|example|sample|suggest/i;

let pass = 0, fail = 0;
const offenders = [];

// Deduped by file+line+value: NAMED_EXAMPLE also matches `placeholder="…"` (a valid
// identifier followed by `=`), so without this every attribute is reported twice and the
// output reads like twice as many defects as exist.
const seen = new Set();

function checkValue(file, text, index, value, what) {
  const hit = TENANT_IDENTIFIERS.find((w) => value.toLowerCase().includes(w));
  if (!hit) return;
  const line = text.slice(0, index).split('\n').length;
  const key = `${file}:${line}:${value}`;
  if (seen.has(key)) return;
  seen.add(key);
  offenders.push(`${file.replace(SRC, 'src')}:${line} -> ${what} "${value}" contains "${hit}"`);
}

for (const file of walk(SRC)) {
  // This file necessarily contains the words it bans.
  if (file.endsWith('placeholderTenantWords.test.mjs')) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(PLACEHOLDER)) {
    checkValue(file, text, m.index, m[2], 'placeholder');
  }
  for (const m of text.matchAll(NAMED_EXAMPLE)) {
    if (!EXAMPLE_NAME.test(m[1])) continue;
    checkValue(file, text, m.index, m[3], `${m[1]}`);
  }
}

if (offenders.length === 0) {
  pass++;
  console.log('PASS  no placeholder in src names a real tenant');
} else {
  fail++;
  console.error('FAIL  a placeholder names a real tenant — use generic wording:');
  for (const o of offenders) console.error(`      ${o}`);
}

// Prove the scanner actually scans: if the regex ever stops matching, the check above
// would pass vacuously and report green while guarding nothing.
const totalPlaceholders = walk(SRC)
  .filter((f) => !f.endsWith('placeholderTenantWords.test.mjs'))
  .reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(PLACEHOLDER)].length, 0);
if (totalPlaceholders > 50) {
  pass++;
  console.log(`PASS  scanner is live (${totalPlaceholders} placeholders inspected)`);
} else {
  fail++;
  console.error(`FAIL  only ${totalPlaceholders} placeholders found — the regex has stopped matching, so the guard above proves nothing`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
