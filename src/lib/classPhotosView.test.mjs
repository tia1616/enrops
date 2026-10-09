// public_org_directory is redefined, whole, by every migration that touches it, and
// each one copies the previous select list by hand. Class photos reads
// class_photos_enabled from it for BOTH portals, and both reads only log a console
// error when the column is missing - so a later migration that copies an older
// definition would switch the feature off for every provider with nothing failing.
// instructorDocuments.test.mjs guards the instructor-document keys the same way.

import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const redefines = /(create\s+(or\s+replace\s+)?view)\s+("?public"?\s*\.\s*)?"?public_org_directory"?(\s|$|;|\()/i;
const touching = files.filter((f) => redefines.test(readFileSync(new URL(f, dir), 'utf8')));
ok('some migration defines public_org_directory', touching.length > 0);

const newest = touching[touching.length - 1];
const src = readFileSync(new URL(newest, dir), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--.*$/gm, '');
ok(`the newest definition (${newest}) still publishes class_photos_enabled`,
  /\bas\s+class_photos_enabled\b/i.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
