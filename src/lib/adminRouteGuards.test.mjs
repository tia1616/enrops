// src/lib/adminRouteGuards.test.mjs
//
// THE INVARIANT: an admin route may not quietly ship without a decision about
// whether it needs a guard.
//
// WHY THIS EXISTS. Across twelve /code-review runs the single most common
// finding — roughly one in three — was a change applied to one of the N places
// that needed it, and this pair was the repeat offender:
//
//   2026-08-11  the Money nav item was gated for lean orgs; the bare /admin/*
//               routes underneath it were not
//   2026-08-12  canManageInstructors gated the Settings CARD that links to
//               /admin/instructor-documents while the route stayed open by URL
//   2026-08-13  the nav half of the Money fix landed; the route half did not
//
// Hiding a link is not a gate: a bookmark, a shared URL or browser autocomplete
// all still land on the page. App.jsx says this in its own words above the four
// Comms routes — "the next Comms route would copy a neighbour and quietly ship
// ungated". That is the mechanism. A new route is written by copying the line
// above it, and the line above it is usually bare.
//
// WHAT IT CHECKS. It parses App.jsx's own route table (so the route list is
// derived, never retyped) and classifies every admin route as guarded, a
// redirect, or bare. BARE_ROUTES below is a ledger of the ones bare TODAY. The
// test is green on the current tree and goes red the moment a NEW bare route
// appears — at which point the author either wraps it or adds one line here,
// which shows up in the diff as a decision somebody made rather than a default
// nobody noticed.
//
// It is checked in both directions: a stale entry (a route since guarded, or
// deleted) fails too, so the ledger can never outlive the thing it describes.
//
// WHAT IT DOES NOT CHECK. It cannot tell you a route SHOULD be guarded — that
// is a product judgement. See KNOWN_OPEN_FINDINGS at the bottom for the five
// routes /code-review flagged on 2026-08-13 that are still bare on purpose,
// pending Jessica's call.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const appSrc = readFileSync(join(here, '..', 'App.jsx'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// ---------------------------------------------------------------------------
// Admin routes that render a page with NO wrapper today.
//
// Adding a line here is a decision: you are saying this surface is safe for
// every org and role that can reach /admin at all. Most are — the gates that
// matter for them live in AdminLayout's role guard or in RLS. Say which.
// ---------------------------------------------------------------------------
const BARE_ROUTES = new Set([
  // Programs + scheduling — every org that reaches /admin has these.
  'class-schedule', 'programs', 'programs/quick-new',
  'programs/:programId/roster', 'curricula', 'curricula/new', 'curricula/:id/extracting',
  'curricula/:id/review', 'curricula/:id/edit', 'schools', 'calendars', 'rosters',
  // THE INSTRUCTOR SURFACES CAME OFF THIS LIST on 2026-08-13. schedule,
  // schedule/print, instructors, availability, class-reports and pay-rates are
  // now wrapped in InstructorRoute — the /code-review finding this ledger's
  // KNOWN_OPEN_FINDINGS was holding open. `payouts` stays bare: its hole was the
  // ROLE one (staff/viewer reading pay), and that is closed at the nav layer by
  // giving the tabless Money item a `match` so the viewMoney block card fires.
  'payouts',
  // The section index and the classic wizard. Both reachable only from inside an
  // authenticated admin shell; the wizard has its own ProgramWizardRoute redirect
  // for lean orgs, which this parser reads as bare because it is a lone
  // self-closing element rather than a wrapper with a child.
  '/admin', 'programs/new',
  // Money + settings. Role is gated by AdminLayout's `gate`/`match` guard, which
  // is a ROLE check (viewMoney / settings), not an entitlement one.
  'finances', 'discounts', 'team', 'time-saved', 'settings', 'survey-settings',
  'registration-questions', 'waivers', 'email-sender',
  'background-checks', 'training', 'branding',
  // Dev + platform consoles. No nav entry by design; gated by platform_admins in
  // the UI and again in the database.
  'dev/extraction-test', 'dev/refund-watch', 'platform/operators',
]);

// ---------------------------------------------------------------------------
// Parse App.jsx's admin route table. Derived from the source, never retyped.
// ---------------------------------------------------------------------------
function adminRouteBlock(src) {
  const start = src.indexOf('<Route path="/admin" element={<AdminLayout />}>');
  if (start === -1) return null;
  const end = src.indexOf('</Route>', start);
  if (end === -1) return null;
  return src.slice(start, end);
}

const block = adminRouteBlock(appSrc);
ok(block !== null, 'the /admin route block is still findable in App.jsx',
  'the <Route path="/admin" element={<AdminLayout />}> anchor moved or changed shape — fix this parser, do not delete the test');
if (block === null) { console.log(`\nFAILURES  (${pass} passed, ${fail} failed)`); process.exit(1); }

// <Route path="x" element={ ...anything, incl. nested JSX... } />
const ROUTE_RE = /<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g;
const routes = [];
for (const m of block.matchAll(ROUTE_RE)) routes.push({ path: m[1], element: m[2].trim() });

ok(routes.length > 20, 'the parser found the admin routes',
  `only ${routes.length} matched — the route syntax probably changed`);

function classify(element) {
  if (/^<Navigate\b/.test(element)) return 'redirect';
  // Guarded === the element is a wrapper with a child, not a lone self-closing tag.
  return /^<[A-Za-z0-9_]+[^>]*>\s*</.test(element) ? 'guarded' : 'bare';
}

const bare = routes.filter((r) => classify(r.element) === 'bare').map((r) => r.path);
const guarded = routes.filter((r) => classify(r.element) === 'guarded').map((r) => r.path);

// (1) Nothing NEW may be bare.
const surprises = bare.filter((p) => !BARE_ROUTES.has(p));
ok(surprises.length === 0, 'no NEW admin route ships without a guard decision',
  surprises.length
    ? `unclassified bare routes: ${surprises.join(', ')}\n      `
      + `Either wrap it the way InstructorDocsRoute wraps instructor-documents,\n      `
      + `or add it to BARE_ROUTES with a note saying why it is safe.`
    : '');

// (2) The ledger may not outlive the routes it describes.
const stale = [...BARE_ROUTES].filter((p) => !bare.includes(p));
ok(stale.length === 0, 'the BARE_ROUTES ledger has no stale entries',
  stale.length ? `now guarded, redirected or deleted — remove from BARE_ROUTES: ${stale.join(', ')}` : '');

// ---------------------------------------------------------------------------
// (3) The guards that DO exist must keep existing. This is the regression half:
// each of these was a fix, and a fix is not done until it stays done.
// ---------------------------------------------------------------------------
const MUST_STAY_GUARDED = [
  ['instructor-documents', 'entitlement gate added 2026-08-12 after a non-entitled org could publish by URL'],
  ['family-comms/marketing', 'CommsTabRoute'],
  ['family-comms/automations', 'CommsTabRoute'],
  ['family-comms/contacts', 'CommsTabRoute'],
  ['family-comms/templates', 'CommsTabRoute'],
];
for (const [path, why] of MUST_STAY_GUARDED) {
  ok(guarded.includes(path), `/admin/${path} is still wrapped (${why})`,
    `it is now ${routes.find((r) => r.path === path) ? classify(routes.find((r) => r.path === path).element) : 'MISSING'}`);
}

// ---------------------------------------------------------------------------
// (4) Open findings, recorded so they cannot be forgotten a fourth time.
//
// These five are in BARE_ROUTES because they ARE bare, not because that is
// settled. /code-review (max, 2026-08-13) reported them as the unlanded half of
// the Money/Instructors entitlement fix. This assertion does not fail the build;
// it prints, so the gap stays visible on every run instead of living in a chat
// log nobody rereads.
// ---------------------------------------------------------------------------
// CLOSED 2026-08-13. All five entries this list shipped with are resolved, so it
// is empty rather than deleted — the mechanism is worth keeping for the next
// finding, and an empty list is the honest state.
//
// Four of them (schedule, instructors, availability, class-reports — plus
// schedule/print and pay-rates, never listed) are now wrapped in InstructorRoute.
// `payouts` was listed wrongly: its hole was the ROLE one, staff/viewer reading
// pay, and that is closed at the nav layer by giving the tabless Money item a
// `match` so the viewMoney block card fires. It is not hidden by
// canManageInstructors at all, so both halves of the note were false for it.
//
// THIS LIST NEEDS THE SAME BOTH-DIRECTIONS CHECK AS BARE_ROUTES, which is the
// lesson: the file already asserts "a ledger entry may not outlive the thing it
// describes" for BARE_ROUTES, and then carried a second list with no such guard —
// so it spent a commit printing a fixed gap as if it were open. The assertion
// below is that guard.
const KNOWN_OPEN_FINDINGS = [];
const staleFindings = KNOWN_OPEN_FINDINGS.filter((p) => !bare.includes(p));
ok(staleFindings.length === 0,
  'KNOWN_OPEN_FINDINGS has no stale entries',
  `these are no longer bare — remove them: ${staleFindings.join(', ')}`);
const stillOpen = KNOWN_OPEN_FINDINGS.filter((p) => bare.includes(p));
if (stillOpen.length) {
  console.log(`\nNOTE  ${stillOpen.length} surface(s) reported by /code-review remain reachable by URL:`);
  console.log(`      ${stillOpen.join(', ')}`);
  console.log(`      Guard them, or decide they are fine and remove them from the list.`);
  console.log(`      Not failing the build — recorded so the gap stays visible.`);
}

console.log(`\n${routes.length} admin routes: ${guarded.length} guarded, ${bare.length} bare, ${routes.length - guarded.length - bare.length} redirects`);
console.log(`${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
