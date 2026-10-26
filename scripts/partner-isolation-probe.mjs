// Partner portal isolation + no-PII proof (spec v3 §10, Oct 30 criteria 2, 3, 5 and 6).
//
// Criterion 2 asks for isolation "by impersonation against the database rules,
// not by hidden screens". So this never looks at a page. It signs in as every
// host login that exists (a real session, minted with the admin API; no email
// is sent), then calls the SAME API the partner pages call, plus everything else
// a signed-in user could ask for, and asserts on what comes back:
//
//   - each host gets only its own partner's grant, documents, files and
//     instructors, and nothing of any other partner's (in either direction);
//   - every instructor row is at one of that partner's own sites;
//   - tables a host has no business reading (instructors, checks, families,
//     the audit log, contacts, team) return nothing;
//   - criterion 6, checked on the API RESPONSES not the screen: every field a
//     host can receive is on an allowlist, and no value looks like an SSN.
//     A new column reaching partners fails this until someone reviews it;
//   - CONTROLS: each host must actually SEE its own data. A probe where nobody
//     sees anything would "pass" isolation trivially, so that is a failure.
//
// It writes nothing of its own. Two side effects come from the product itself,
// exactly as on a real sign-in: partner_portal_memberships() claims an
// unclaimed grant and stamps last_signed_in_at. It never calls
// log_partner_portal_event for a partner the host holds, so it adds no visits.
//
// STAGING ONLY. On prod it would sign in as real people at real parks
// departments; that is a separate decision, not a flag.
//
// Run: node scripts/partner-isolation-probe.mjs
// Needs in the main clone's .env.local: SUPABASE_STAGING_SERVICE_KEY,
// SUPABASE_STAGING_ANON_KEY. Exit code 1 on any failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const URL_BASE = 'https://mumfymlapolsfdnpewci.supabase.co';
const BUCKET = 'provider-documents';

function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  // Worktrees have no .env.local of their own; the main clone holds it.
  for (const p of [join(here, '..', '.env.local'), join(here, '..', '..', 'enrops', '.env.local')]) {
    try {
      const txt = readFileSync(p, 'utf8');
      const get = (k) => txt.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^"|"$/g, '');
      const service = get('SUPABASE_STAGING_SERVICE_KEY');
      const anon = get('SUPABASE_STAGING_ANON_KEY');
      if (service && anon) return { service, anon };
    } catch { /* try the next */ }
  }
  console.error('Missing SUPABASE_STAGING_SERVICE_KEY / SUPABASE_STAGING_ANON_KEY in .env.local');
  process.exit(2);
}
const { service: SERVICE, anon: ANON } = loadEnv();

// ---------------------------------------------------------------- reporting
let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`); }
}

// ---------------------------------------------------------------- HTTP
async function call(path, { token, method = 'GET', body, key = ANON } = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      'Content-Type': 'application/json',
      // Without this a write that DID succeed answers 204 with no body, which
      // reads exactly like "0 rows changed". Ask for the changed rows back.
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const asService = (path, opts = {}) => call(path, { ...opts, key: SERVICE, token: SERVICE });
const rows = (r) => (Array.isArray(r.json) ? r.json : []);
// "Got nothing": an empty list, or refused outright (401/403/404 or an error body).
const gotNothing = (r) => (r.status >= 400) || rows(r).length === 0;

async function signIn(email) {
  const link = await asService('/auth/v1/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email } });
  const tokenHash = link.json?.properties?.hashed_token ?? link.json?.hashed_token;
  if (!tokenHash) return null;
  const v = await call('/auth/v1/verify', { method: 'POST', body: { type: 'magiclink', token_hash: tokenHash } });
  return v.json?.access_token ?? null;
}

// ---------------------------------------------------------------- criterion 6
// Every field a host can receive. Anything else fails until a person decides it
// is safe to show a parks department.
const INSTRUCTOR_FIELDS = new Set([
  'instructor_id', 'first_name', 'last_name', 'sites', 'shared', 'email', 'phone',
  'background_check_completed_on', 'background_check_expires_on', 'background_check_status',
  'background_check_vendor', 'background_check_as_of', 'training_completed_on', 'training_as_of',
  'code_of_conduct_on', 'mandatory_reporter_on', 'agreement_signed_on',
]);
const DOCUMENT_FIELDS = new Set([
  'id', 'organization_id', 'partner_id', 'doc_type', 'title', 'received_on', 'effective_on',
  'expires_on', 'storage_path', 'original_filename', 'created_by', 'created_at', 'updated_at', 'expiry_status',
]);
const MEMBERSHIP_FIELDS = new Set(['partner_id', 'partner_name', 'organization_id', 'organization_name', 'organization_slug']);
// Belt and braces on top of the allowlists: these names are never acceptable.
const FORBIDDEN_KEY = /(^|_)(dob|birth|birthday|date_of_birth|ssn|social|address|street|zip|postal|report)(_|$)/i;
// Full SSN, or a masked one ending in the last four.
const SSN_VALUE = /\b(?:\d{3}|[X*]{3})-(?:\d{2}|[X*]{2})-\d{4}\b/;

function scanFields(label, list, allowed) {
  const extra = new Set();
  const forbidden = new Set();
  let ssn = 0;
  for (const row of list) {
    for (const [k, v] of Object.entries(row ?? {})) {
      if (!allowed.has(k)) extra.add(k);
      if (FORBIDDEN_KEY.test(k)) forbidden.add(k);
      if (SSN_VALUE.test(JSON.stringify(v ?? ''))) ssn++;
    }
  }
  ok(`${label}: every field is on the allowlist`, extra.size === 0, [...extra].join(', '));
  ok(`${label}: no birth date / address / SSN / report field`, forbidden.size === 0, [...forbidden].join(', '));
  ok(`${label}: no value shaped like an SSN`, ssn === 0, `${ssn} value(s)`);
}

// ---------------------------------------------------------------- ground truth (service role)
const grantsRes = await asService(
  '/rest/v1/partner_portal_access?select=id,partner_id,organization_id,role,contact_id,contact:partner_contacts(contact_email)',
);
const allGrants = rows(grantsRes);
const docsRes = await asService(`/rest/v1/provider_documents?select=id,organization_id,partner_id,storage_path`);
const allDocs = rows(docsRes);
const locRes = await asService('/rest/v1/program_locations?select=name,partner_id&partner_id=not.is.null');
const sitesByPartner = new Map();
for (const l of rows(locRes)) {
  if (!sitesByPartner.has(l.partner_id)) sitesByPartner.set(l.partner_id, new Set());
  sitesByPartner.get(l.partner_id).add(l.name);
}
const partnerIdsInPlay = [...new Set(allGrants.map((g) => g.partner_id))];
// The ground truth must load, or every CONTROL below passes against nothing.
ok('ground truth: grants loaded', grantsRes.status === 200 && allGrants.length > 0, `status ${grantsRes.status}`);
ok('ground truth: documents loaded (some stored file to try)', docsRes.status === 200 && allDocs.some((d) => d.storage_path),
  `status ${docsRes.status}, ${allDocs.length} document(s)`);
ok('ground truth: sites loaded', locRes.status === 200 && sitesByPartner.size > 0, `status ${locRes.status}`);
// The instructor RPC returns site NAMES, not ids, so the own-sites check is by
// name. A name used at two partners in play would make it unprovable.
const nameOwners = new Map();
for (const p of partnerIdsInPlay) for (const n of sitesByPartner.get(p) ?? []) nameOwners.set(n, (nameOwners.get(n) ?? 0) + 1);
const shared = [...nameOwners].filter(([, c]) => c > 1).map(([n]) => n);
ok('site names are unique across partners in play (own-sites check is by name)', shared.length === 0, shared.join(', '));

// Sign in every grant whose contact ALREADY has an account. A contact without
// one (e.g. the allowlist-blocked fixture) is skipped, by name: asking the auth
// API for a magic link to an unknown address can CREATE the account, which
// would quietly break that fixture.
const existing = new Set();
for (let page = 1; page < 50; page++) {
  const r = await asService(`/auth/v1/admin/users?page=${page}&per_page=500`);
  const users = r.json?.users ?? [];
  for (const u of users) if (u.email) existing.add(u.email.toLowerCase());
  if (users.length < 500) break;
}
const hosts = [];
const byEmail = new Map();
for (const g of allGrants) {
  const email = g.contact?.contact_email;
  if (!email) continue;
  if (!byEmail.has(email)) byEmail.set(email, []);
  byEmail.get(email).push(g);
}
for (const [email, grants] of byEmail) {
  if (!existing.has(String(email).toLowerCase())) { console.log(`skip  ${email}: no account to sign in`); continue; }
  const token = await signIn(email);
  if (!token) { console.log(`skip  ${email}: no account to sign in`); continue; }
  hosts.push({ email, token, grants, partners: new Set(grants.map((g) => g.partner_id)), orgs: new Set(grants.map((g) => g.organization_id)) });
}
const distinctPartners = new Set(hosts.flatMap((h) => [...h.partners]));
ok('at least two host logins at two different partners to compare', hosts.length >= 2 && distinctPartners.size >= 2,
  `${hosts.length} signed in, ${distinctPartners.size} partner(s)`);

// ---------------------------------------------------------------- per host
for (const h of hosts) {
  const who = `${h.email} (${h.grants.map((g) => g.role).join('/')})`;
  console.log(`\n== ${who}`);

  // Memberships: the portal's own entry point. Claims the grant on first sign-in.
  const mem = await call('/rest/v1/rpc/partner_portal_memberships', { token: h.token, method: 'POST', body: {} });
  const memRows = rows(mem);
  ok(`${who} CONTROL: sees its own partner`, memRows.some((m) => h.partners.has(m.partner_id)), `status ${mem.status}`);
  ok(`${who} memberships name no other partner`, memRows.every((m) => h.partners.has(m.partner_id)),
    memRows.filter((m) => !h.partners.has(m.partner_id)).map((m) => m.partner_name).join(', '));
  scanFields(`${who} memberships`, memRows, MEMBERSHIP_FIELDS);

  // Instructors, for EVERY partner with a grant.
  const ownInstructorRows = [];
  for (const p of partnerIdsInPlay) {
    const r = await call('/rest/v1/rpc/partner_portal_instructors', { token: h.token, method: 'POST', body: { p_partner_id: p } });
    if (h.partners.has(p)) {
      const list = rows(r);
      ownInstructorRows.push(...list);
      const sites = sitesByPartner.get(p) ?? new Set();
      // An empty or missing sites list is a failure too: every() is true for [].
      const offSite = list.filter((x) => !(x.sites?.length > 0 && x.sites.every((s) => sites.has(s))));
      ok(`${who} instructors are only at its own sites`, offSite.length === 0,
        offSite.map((x) => `${x.first_name} @ ${(x.sites ?? []).join('/')}`).join('; '));
    } else {
      ok(`${who} gets no instructors for another partner (${p.slice(0, 8)})`, gotNothing(r), `${rows(r).length} row(s)`);
    }
  }
  ok(`${who} CONTROL: sees at least one instructor`, ownInstructorRows.length > 0);
  scanFields(`${who} instructors`, ownInstructorRows, INSTRUCTOR_FIELDS);

  // Documents: the view the page reads AND the base table, every column.
  for (const rel of ['provider_documents_with_status', 'provider_documents']) {
    const r = await call(`/rest/v1/${rel}?select=*`, { token: h.token });
    const list = rows(r);
    const foreign = list.filter((d) => !h.orgs.has(d.organization_id) || (d.partner_id && !h.partners.has(d.partner_id)));
    ok(`${who} ${rel}: no other partner's document`, foreign.length === 0, foreign.map((d) => d.title).join(', '));
    const expected = allDocs.filter((d) => h.orgs.has(d.organization_id) && (!d.partner_id || h.partners.has(d.partner_id)));
    ok(`${who} ${rel} CONTROL: sees every document meant for it`, expected.every((e) => list.some((d) => d.id === e.id)),
      `${list.length} of ${expected.length}`);
    scanFields(`${who} ${rel}`, list, DOCUMENT_FIELDS);
  }

  // Files: try to open EVERY stored document. Only its own may sign.
  for (const d of allDocs.filter((x) => x.storage_path)) {
    const mine = h.orgs.has(d.organization_id) && (!d.partner_id || h.partners.has(d.partner_id));
    // Encoded per segment: a raw '#', '?' or space would break the request, and a
    // broken request would read as "refused".
    const path = d.storage_path.split('/').map(encodeURIComponent).join('/');
    const r = await call(`/storage/v1/object/sign/${BUCKET}/${path}`, { token: h.token, method: 'POST', body: { expiresIn: 60 } });
    const signed = r.status === 200 && !!(r.json?.signedURL ?? r.json?.signedUrl);
    if (mine) ok(`${who} CONTROL: can open its own file ${d.id.slice(0, 8)}`, signed, `status ${r.status}`);
    else ok(`${who} cannot open another partner's file ${d.id.slice(0, 8)}`, !signed, `status ${r.status}`);
  }

  // What each partner requires (20261026a): its own list, nobody else's, and
  // it cannot change any list.
  for (const p of partnerIdsInPlay) {
    const r = await call('/rest/v1/rpc/partner_requirements_for', { token: h.token, method: 'POST', body: { p_partner_id: p } });
    if (h.partners.has(p)) {
      ok(`${who} CONTROL: reads its own requirements`, rows(r).length > 0, `status ${r.status}`);
      scanFields(`${who} requirements`, rows(r), new Set(['requirement_key', 'required']));
    } else {
      ok(`${who} reads no requirements of another partner (${p.slice(0, 8)})`, gotNothing(r), `${rows(r).length} row(s)`);
    }
    const set = await call('/rest/v1/rpc/set_partner_requirement', {
      token: h.token, method: 'POST', body: { p_partner_id: p, p_requirement_key: 'business_license', p_required: true },
    });
    ok(`${who} cannot change requirements (${p.slice(0, 8)})`, set.json !== true, `got ${set.text.slice(0, 40)}`);
  }

  // Grants: only its own.
  const acc = await call('/rest/v1/partner_portal_access?select=id,partner_id', { token: h.token });
  ok(`${who} partner_portal_access: only its own grant`, rows(acc).every((a) => h.partners.has(a.partner_id)),
    `${rows(acc).length} row(s)`);

  // Partners table: never another partner.
  const prt = await call('/rest/v1/partners?select=id,partner_name', { token: h.token });
  ok(`${who} partners: no other partner`, rows(prt).every((p) => h.partners.has(p.id)),
    rows(prt).filter((p) => !h.partners.has(p.id)).map((p) => p.partner_name).join(', '));

  // Tables a host must never read at all.
  for (const t of ['instructors', 'contractor_onboarding_status', 'contractor_acknowledgments', 'students',
    'parents', 'registrations', 'audit_events', 'partner_contacts', 'org_members', 'program_assignments',
    'partner_requirements']) {
    const r = await call(`/rest/v1/${t}?select=*&limit=5`, { token: h.token });
    // A missing table (404 / PGRST205) tests nothing; it must not read as a pass.
    const missing = r.status === 404 || r.json?.code === 'PGRST205';
    ok(`${who} reads nothing from ${t}`, !missing && gotNothing(r),
      missing ? 'table not found - update the list' : `${rows(r).length} row(s), status ${r.status}`);
  }

  // Criterion 3: a host (admin or viewer) cannot change the team or the record.
  // Each attempt is harmless if the rules were wrong: the PATCH writes back the
  // value already there, and the DELETE targets only this host's own grant.
  const ownGrant = h.grants[0];
  const addTeam = await call('/rest/v1/partner_portal_access', {
    token: h.token, method: 'POST', body: { contact_id: ownGrant.contact_id, role: 'host_admin' },
  });
  // Must be refused by the RULES (42501). Any other error proves nothing: this
  // contact already has a grant, so a permitted insert would still fail 409.
  ok(`${who} cannot add anyone to the team (refused by RLS)`, addTeam.json?.code === '42501',
    `status ${addTeam.status} ${addTeam.json?.code ?? ''}`);
  const promote = await call(`/rest/v1/partner_portal_access?id=eq.${ownGrant.id}`, {
    token: h.token, method: 'PATCH', body: { role: ownGrant.role },
  });
  ok(`${who} cannot change a team role`, promote.status >= 400 || rows(promote).length === 0, `status ${promote.status}`);
  const removeSelf = await call(`/rest/v1/partner_portal_access?id=eq.${ownGrant.id}`, { token: h.token, method: 'DELETE' });
  ok(`${who} cannot remove a team member`, removeSelf.status >= 400 || rows(removeSelf).length === 0, `status ${removeSelf.status}`);
  const ownDoc = allDocs.find((d) => h.orgs.has(d.organization_id) && (!d.partner_id || h.partners.has(d.partner_id)));
  if (ownDoc) {
    const edit = await call(`/rest/v1/provider_documents?id=eq.${ownDoc.id}`, {
      token: h.token, method: 'PATCH', body: { partner_id: ownDoc.partner_id },
    });
    ok(`${who} cannot edit a document`, edit.status >= 400 || rows(edit).length === 0, `status ${edit.status}`);
  }

  // Cannot write a visit into another partner's log.
  for (const p of partnerIdsInPlay.filter((x) => !h.partners.has(x))) {
    const r = await call('/rest/v1/rpc/log_partner_portal_event', {
      token: h.token, method: 'POST', body: { p_partner_id: p, p_action: 'portal_viewed' },
    });
    ok(`${who} cannot log a visit to another partner (${p.slice(0, 8)})`, r.json !== true, `got ${r.text.slice(0, 40)}`);
  }
}

// ---------------------------------------------------------------- signed out
console.log('\n== signed out (anon key only)');
const anonMem = await call('/rest/v1/rpc/partner_portal_memberships', { method: 'POST', body: {} });
ok('anon: no memberships', gotNothing(anonMem), `status ${anonMem.status}`);
for (const p of partnerIdsInPlay) {
  const r = await call('/rest/v1/rpc/partner_portal_instructors', { method: 'POST', body: { p_partner_id: p } });
  ok(`anon: no instructors for ${p.slice(0, 8)}`, gotNothing(r), `status ${r.status}`);
}
const anonDocs = await call('/rest/v1/provider_documents_with_status?select=id');
ok('anon: no documents', gotNothing(anonDocs), `status ${anonDocs.status}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
