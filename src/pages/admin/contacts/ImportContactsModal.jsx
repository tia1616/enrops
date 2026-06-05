// ImportContactsModal — multi-step bulk import of partners + contacts.
//
// Steps:
//   1. source   — pick "Upload file" or "Paste text"
//   2. extracting — sends payload to import-partners-extract; waits for
//                   structured rows back from Claude
//   3. review   — show extracted partners + contacts, with new/match badges
//                 and per-row checkboxes; let operator edit obvious mistakes
//                 (rename a partner, change a role) before write
//   4. writing  — sends accepted rows to import-partners-write
//   5. done     — success summary
//
// Multi-tenant: all writes go through edge fns that validate org membership.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import ElapsedTimer from '../../../components/ElapsedTimer';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const CREAM = '#FBFBFB';
const OK = '#3a7c3a';
const AMBER = '#b67e00';
const RED = '#b53737';

const PARTNER_TYPES = [
  { v: '', label: '—' },
  { v: 'public_school', label: 'Public school' },
  { v: 'private_school', label: 'Private school' },
  { v: 'charter_school', label: 'Charter school' },
  { v: 'school_district', label: 'School district' },
  { v: 'parks_rec', label: 'Parks & Rec' },
  { v: 'community_org', label: 'Community org' },
  { v: 'church', label: 'Church' },
];

const ROLES = [
  { v: 'operational', label: 'Operational (site logistics)' },
  { v: 'marketing', label: 'Marketing (flyer distribution)' },
  { v: 'invoicing', label: 'Invoicing (billing)' },
  { v: 'approval_gatekeeper', label: 'Approval gatekeeper' },
];

// Deterministic column mapping for the file path (no AI). Each row in the
// upload is one contact; rows sharing a partner name group into one partner.
const PARTNER_FIELDS = [
  { key: 'partner_name', label: 'Partner / school name', required: true,
    aliases: ['partner', 'partnername', 'school', 'schoolname', 'organization', 'organisation', 'org', 'site', 'sitename', 'venue', 'district', 'company'] },
  { key: 'partner_type', label: 'Partner type',
    aliases: ['type', 'partnertype', 'category', 'schooltype'] },
  { key: 'location_area', label: 'Area / city',
    aliases: ['area', 'city', 'region', 'locationarea', 'neighborhood', 'neighbourhood', 'town'] },
  { key: 'contact_name', label: 'Contact name',
    aliases: ['contactname', 'name', 'contact', 'fullname', 'person', 'contactperson'] },
  { key: 'contact_email', label: 'Contact email',
    aliases: ['email', 'contactemail', 'emailaddress', 'email_address', 'e-mail', 'mail'] },
  { key: 'contact_phone', label: 'Contact phone',
    aliases: ['phone', 'contactphone', 'phonenumber', 'tel', 'telephone', 'mobile', 'cell'] },
  { key: 'contact_role', label: 'Contact role / title',
    aliases: ['role', 'contactrole', 'title', 'position', 'jobtitle', 'job', 'responsibility'] },
  { key: 'role_description', label: 'Role description',
    // Conservative aliases — generic words like `notes`/`description`/`details`
    // substring-match too aggressively and grab columns like `marketing_notes`.
    aliases: ['roledescription', 'rolenotes', 'responsibilities'] },
  // Location fields — written to program_locations when the partner is a venue
  // (school / community org) and we auto-create or fill in a location row.
  // Auto-create: all three are persisted. Link-existing: only fills blanks.
  { key: 'location_address', label: 'Street address',
    aliases: ['address', 'streetaddress', 'street', 'addr', 'addressline', 'mailingaddress'] },
  { key: 'location_room_number', label: 'Room number',
    aliases: ['room', 'roomnumber', 'roomno', 'roomname', 'classroom', 'suite'] },
  { key: 'location_district', label: 'School district',
    aliases: ['schooldistrict', 'district', 'districtname'] },
];

function normHeader(h) {
  return (h ?? '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function autoMapColumns(headers) {
  // Match real-world headers like "School or organization", "Contact's Email
  // Address", "Phone #". Strategy: longest alias that appears as a substring
  // of the normalized header wins. Falls back to exact equality.
  const map = {};
  const norm = headers.map(normHeader);
  const claimedHeaders = new Set();
  for (const def of PARTNER_FIELDS) {
    // Try aliases in order: longest first (more specific beats more generic).
    const aliases = [...def.aliases].sort((a, b) => b.length - a.length);
    let pickIdx = -1;
    for (const alias of aliases) {
      const a = normHeader(alias);
      // Exact match first.
      const exact = norm.findIndex((h, i) => h === a && !claimedHeaders.has(headers[i]));
      if (exact !== -1) { pickIdx = exact; break; }
      // Then substring (so "schoolororganization" matches "school", "Phone Number" → "phone").
      const sub = norm.findIndex((h, i) => h.includes(a) && !claimedHeaders.has(headers[i]));
      if (sub !== -1) { pickIdx = sub; break; }
    }
    if (pickIdx !== -1) {
      map[def.key] = headers[pickIdx];
      claimedHeaders.add(headers[pickIdx]);
    }
  }
  return map;
}

// "Confident enough to skip the mapping step": we have partner_name AND
// either (a) a contact field auto-mapped, or (b) no contact-looking column
// exists in the file at all (a partner-only import — no need to map
// something that isn't there). Operators can still edit on the review screen.
function autoMapIsConfident(mapping, headers) {
  if (!mapping.partner_name) return false;
  if (mapping.contact_email || mapping.contact_name) return true;
  const fileHasContactLikeColumn = (headers ?? []).some((h) => {
    const n = normHeader(h);
    return n.includes('email') || n.includes('phone') || n.includes('contact');
  });
  return !fileHasContactLikeColumn;
}

// Map a free-text role/title to one of the four enum roles, deterministically
// (mirrors the rules the AI extractor used).
function normalizeRole(raw) {
  const s = (raw ?? '').toString().toLowerCase();
  if (/market|flyer|\bpto\b|communicat|newsletter|outreach/.test(s)) return 'marketing';
  if (/invoic|billing|\bap\b|account|payable|finance|bursar/.test(s)) return 'invoicing';
  if (/principal|director|head of school|superintend|approv|gatekeep|admin head/.test(s)) return 'approval_gatekeeper';
  return 'operational';
}

function looksLikeOrgInbox(email) {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  return ['info', 'office', 'contact', 'hello', 'ops', 'mainoffice', 'main', 'admin',
    'frontoffice', 'reception', 'enrollment', 'enrolment', 'registration', 'registrar', 'team']
    .some((p) => local === p);
}

function normalizePartnerType(raw) {
  const s = (raw ?? '').toString().toLowerCase();
  if (/public/.test(s)) return 'public_school';
  if (/private|independent/.test(s)) return 'private_school';
  if (/charter/.test(s)) return 'charter_school';
  if (/district/.test(s)) return 'school_district';
  if (/church|parish|faith|temple|synagogue|mosque/.test(s)) return 'church';
  if (/parks|recreation|\brec\b/.test(s)) return 'parks_rec';
  if (/community|nonprofit|non-profit|\borg\b/.test(s)) return 'community_org';
  return null;
}

// Group mapped rows into the same partners[] shape the AI extractor returns,
// so the existing review + write steps work unchanged.
function buildPartnersFromGrid(headers, rows, mapping) {
  const idx = {};
  for (const f of PARTNER_FIELDS) idx[f.key] = mapping[f.key] ? headers.indexOf(mapping[f.key]) : -1;
  const at = (row, key) => (idx[key] >= 0 ? (row[idx[key]] ?? '').toString().trim() : '');
  const byKey = new Map();
  const order = [];
  for (const row of rows) {
    const pname = at(row, 'partner_name');
    if (!pname) continue;
    // Skip comment / instruction rows (common spreadsheet conventions).
    if (/^[#/]/.test(pname.trim())) continue;
    const key = normName(pname);
    let p = byKey.get(key);
    if (!p) {
      p = {
        partner_name: pname,
        partner_type: normalizePartnerType(at(row, 'partner_type')),
        location_area: at(row, 'location_area') || null,
        locations_managed: null, marketing_notes: null, invoicing_notes: null,
        planning_notes: null, implementation_notes: null, other_notes: null,
        // Location fields — first non-empty wins (rows-per-contact repeat them).
        location_address: at(row, 'location_address') || null,
        location_room_number: at(row, 'location_room_number') || null,
        location_district: at(row, 'location_district') || null,
        contacts: [],
        _selected: true,
      };
      byKey.set(key, p);
      order.push(p);
    } else {
      // Fill any partner-level location fields the first row left blank.
      if (!p.location_address) p.location_address = at(row, 'location_address') || null;
      if (!p.location_room_number) p.location_room_number = at(row, 'location_room_number') || null;
      if (!p.location_district) p.location_district = at(row, 'location_district') || null;
    }
    const email = at(row, 'contact_email').toLowerCase();
    if (email && !p.contacts.some((c) => c.contact_email === email)) {
      p.contacts.push({
        contact_name: at(row, 'contact_name') || null,
        contact_email: email,
        contact_phone: at(row, 'contact_phone') || null,
        contact_role: normalizeRole(at(row, 'contact_role')),
        role_description: at(row, 'role_description') || null,
        is_org_inbox: looksLikeOrgInbox(email),
        _selected: true,
      });
    }
  }
  return order;
}

export default function ImportContactsModal({ orgId, onClose, onImported }) {
  const [step, setStep] = useState('source'); // source | parsing | mapping | extracting | review | writing | done
  // Elapsed-time counter for the AI extraction step. Memory rule
  // feedback_ai_wait_ui: any AI extract/generate must show a live m:ss timer
  // alongside the recommended duration so the operator knows we're alive.
  const [extractElapsed, setExtractElapsed] = useState(0);
  useEffect(() => {
    if (step !== 'extracting') { setExtractElapsed(0); return; }
    const startedAt = Date.now();
    const id = setInterval(() => setExtractElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [step]);
  const [mode, setMode] = useState('file'); // file | text
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [extracted, setExtracted] = useState([]); // partners array
  const [existingByName, setExistingByName] = useState(new Map());
  // partner_name (normalized) → { address, room_number, district } for any
  // existing partner whose linked location has data. Used to show "Already
  // on file:" hints under the Location details inputs so the operator can
  // see what's already saved (the edge fn never overwrites existing values).
  const [existingLocByPartner, setExistingLocByPartner] = useState(new Map());
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  // Deterministic file path: raw grid + column mapping.
  const [rawHeaders, setRawHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [mapping, setMapping] = useState({});

  // Pre-load existing partners + their linked location data so the review
  // screen can show match badges AND "Already on file:" hints for venue
  // partners with addresses/rooms/districts already saved.
  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const [{ data: partners }, { data: locs }] = await Promise.all([
        supabase.from('partners').select('id, partner_name').eq('organization_id', orgId),
        supabase.from('program_locations').select('partner_id, address, room_number, district').eq('organization_id', orgId).not('partner_id', 'is', null),
      ]);
      const m = new Map();
      const partnerNameById = new Map();
      for (const p of partners ?? []) {
        m.set(normName(p.partner_name), { id: p.id, name: p.partner_name });
        partnerNameById.set(p.id, p.partner_name);
      }
      setExistingByName(m);
      const lm = new Map();
      for (const l of locs ?? []) {
        const pname = partnerNameById.get(l.partner_id);
        if (!pname) continue;
        if (!(l.address || l.room_number || l.district)) continue;
        lm.set(normName(pname), { address: l.address, room_number: l.room_number, district: l.district });
      }
      setExistingLocByPartner(lm);
    })();
  }, [orgId]);

  // FILE path (default): parse the upload deterministically on our own server
  // (no AI), then map columns. The file never leaves our infrastructure.
  async function startParse() {
    setError('');
    if (!file) { setError('Pick a file first.'); return; }
    setStep('parsing');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');

      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      let source, payload;
      if (ext === 'csv' || ext === 'txt') {
        source = 'csv';
        payload = await file.text();
      } else if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
        source = 'xlsx';
        payload = await fileToBase64(file);
      } else {
        throw new Error(`Unsupported file type: .${ext}. Use CSV or XLSX.`);
      }

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-partners-parse`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ source, payload, filename: file.name }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        setError(json?.error || `Couldn't read that file (${resp.status}).`);
        setStep('source');
        return;
      }
      const headers = json.headers ?? [];
      const rows = json.rows ?? [];
      if (headers.length === 0 || rows.length === 0) {
        setError("That file didn't have any rows we could read.");
        setStep('source');
        return;
      }
      setRawHeaders(headers);
      setRawRows(rows);
      const guessed = autoMapColumns(headers);
      setMapping(guessed);
      // If we confidently mapped the required + contact fields, skip the
      // mapping screen entirely. Operators can still fix anything in review.
      if (autoMapIsConfident(guessed, headers)) {
        const partners = buildPartnersFromGrid(headers, rows, guessed);
        if (partners.length > 0) {
          setExtracted(partners);
          setStep('review');
          return;
        }
      }
      setStep('mapping');
    } catch (e) {
      console.error('[ImportContactsModal] parse failed', e);
      setError(e.message ?? "Couldn't read that file.");
      setStep('source');
    }
  }

  // Turn the confirmed column mapping into partners[] (same shape the review
  // step expects), entirely client-side.
  function applyMapping() {
    setError('');
    if (!mapping.partner_name) {
      setError('Map the “Partner / school name” column first.');
      return;
    }
    const partners = buildPartnersFromGrid(rawHeaders, rawRows, mapping);
    if (partners.length === 0) {
      setError('No partners found with the current mapping — check the partner-name column.');
      return;
    }
    setExtracted(partners);
    setStep('review');
  }

  // TEXT path (fallback only): freeform paste has no columns, so we ask Claude
  // to extract structure. This is the only place that uses the AI.
  async function startExtract() {
    setError('');
    if (!text.trim()) { setError('Paste some text first.'); return; }
    setStep('extracting');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-partners-extract`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ source: 'text', payload: text.slice(0, 60000) }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        setError(json?.error || `Extract failed (${resp.status}).`);
        setStep('source');
        return;
      }
      const partners = (json.partners ?? []).map((p) => ({
        ...p,
        _selected: true,
        contacts: (p.contacts ?? []).map((c) => ({ ...c, _selected: true })),
      }));
      if (partners.length === 0) {
        setError("We couldn't find any partner organisations or contacts in that text.");
        setStep('source');
        return;
      }
      setExtracted(partners);
      setStep('review');
    } catch (e) {
      console.error('[ImportContactsModal] extract failed', e);
      setError(e.message ?? 'Extract failed.');
      setStep('source');
    }
  }

  async function commitImport() {
    setError('');
    setStep('writing');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');

      const partnersPayload = [];
      for (const p of extracted) {
        if (!p._selected) continue;
        const match = existingByName.get(normName(p.partner_name));
        partnersPayload.push({
          partner_name: p.partner_name,
          partner_type: p.partner_type,
          location_area: p.location_area,
          locations_managed: p.locations_managed,
          marketing_notes: p.marketing_notes,
          invoicing_notes: p.invoicing_notes,
          planning_notes: p.planning_notes,
          implementation_notes: p.implementation_notes,
          other_notes: p.other_notes,
          location_address: p.location_address ?? null,
          location_room_number: p.location_room_number ?? null,
          location_district: p.location_district ?? null,
          action: match ? 'merge' : 'create',
          match_partner_id: match?.id ?? null,
          contacts: (p.contacts ?? []).map((c) => ({
            ...c,
            action: c._selected ? 'create' : 'skip',
          })),
        });
      }

      if (partnersPayload.length === 0) {
        setError('No rows selected.');
        setStep('review');
        return;
      }

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-partners-write`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ organization_id: orgId, partners: partnersPayload }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        setError(json?.error || `Import failed (${resp.status}).`);
        setStep('review');
        return;
      }
      setResult(json);
      setStep('done');
    } catch (e) {
      console.error('[ImportContactsModal] write failed', e);
      setError(e.message ?? 'Import failed.');
      setStep('review');
    }
  }

  const selectedCount = useMemo(() => {
    let p = 0, c = 0;
    for (const partner of extracted) {
      if (!partner._selected) continue;
      p++;
      for (const ct of partner.contacts ?? []) if (ct._selected) c++;
    }
    return { p, c };
  }, [extracted]);

  function updatePartner(idx, patch) {
    setExtracted((cur) => cur.map((p, i) => i === idx ? { ...p, ...patch } : p));
  }
  function updateContact(pIdx, cIdx, patch) {
    setExtracted((cur) => cur.map((p, i) => {
      if (i !== pIdx) return p;
      return { ...p, contacts: p.contacts.map((c, j) => j === cIdx ? { ...c, ...patch } : c) };
    }));
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '4vh 16px', zIndex: 200, fontFamily: 'inherit',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, maxWidth: 880, width: '100%',
          padding: 24, maxHeight: '92vh', overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>
              Import partners &amp; contacts
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: MUTED }}>
              {step === 'source' && 'Upload a spreadsheet of your schools and contacts — or paste a list from an email.'}
              {step === 'parsing' && 'Reading your file…'}
              {step === 'mapping' && 'Tell us which column is which, then continue.'}
              {step === 'extracting' && 'Working through the text…'}
              {step === 'review' && 'Review what we found, edit anything that looks off, then save.'}
              {step === 'writing' && 'Saving to your contacts…'}
              {step === 'done' && 'Done.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}
            aria-label="Close"
          >✕</button>
        </div>

        {error && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {step === 'source' && (
          <SourceStep
            mode={mode} setMode={setMode}
            file={file} setFile={setFile}
            text={text} setText={setText}
            onCancel={onClose}
            onNext={() => (mode === 'file' ? startParse() : startExtract())}
          />
        )}

        {step === 'parsing' && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MUTED, fontSize: 14 }}>
            Reading your file…
          </div>
        )}

        {step === 'mapping' && (
          <MappingStep
            headers={rawHeaders}
            rows={rawRows}
            mapping={mapping}
            setMapping={setMapping}
            onBack={() => setStep('source')}
            onContinue={applyMapping}
          />
        )}

        {step === 'extracting' && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
            <div style={{ fontSize: 22, marginBottom: 8 }}>📖</div>
            <div>Reading your text with AI…</div>
            <div style={{ fontSize: 12.5, marginTop: 2 }}>Usually takes 10–30 seconds.</div>
            <div style={{ marginTop: 14 }}>
              <ElapsedTimer seconds={extractElapsed} />
            </div>
          </div>
        )}

        {step === 'review' && (
          <ReviewStep
            partners={extracted}
            existingByName={existingByName}
            existingLocByPartner={existingLocByPartner}
            selectedCount={selectedCount}
            updatePartner={updatePartner}
            updateContact={updateContact}
            onBack={() => setStep('source')}
            onCommit={commitImport}
          />
        )}

        {step === 'writing' && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MUTED, fontSize: 14 }}>
            Saving…
          </div>
        )}

        {step === 'done' && result && (
          <DoneStep result={result} orgId={orgId} onClose={() => { onImported && onImported(); }} />
        )}
      </div>
    </div>
  );
}

// ─── Step components ────────────────────────────────────────────────────────

// Generate a starter CSV with normal-English headers + 2 example rows so a
// non-technical operator has something to fill in. Opens in Google Sheets,
// Excel, and Numbers identically. Kept tiny on purpose.
function downloadTemplate() {
  // Two example rows so operators can see the format (same school, two
  // contacts → folded into one partner). No instruction row — comments in
  // a CSV get treated as data by most spreadsheet apps.
  const csv = [
    'School or organization,Type,City,Street address,Room number,School district,Contact name,Email,Phone,Role',
    'Maplewood Elementary,Public school,Portland,3315 SE Lincoln St,Room 12,Portland Public,Sarah Hill,sarah.hill@maplewood.example,(503) 555-0142,Front office',
    'Maplewood Elementary,Public school,Portland,3315 SE Lincoln St,Room 12,Portland Public,Dr. James Park,james.park@maplewood.example,(503) 555-0148,Principal',
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'enrops-partners-template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function SourceStep({ mode, setMode, file, setFile, text, setText, onCancel, onNext }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 14 }}>
        <TabBtn active={mode === 'file'} onClick={() => setMode('file')} label="Upload a spreadsheet" />
        <TabBtn active={mode === 'text'} onClick={() => setMode('text')} label="My list is in an email or document" />
      </div>

      {mode === 'file' && (
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: INK, lineHeight: 1.55 }}>
            Add all your schools and contacts in one go. Upload a spreadsheet from
            <strong> Google Sheets, Excel, or a CSV</strong> — your column names don’t
            have to match ours exactly, we’ll figure them out. You’ll get to review
            everything before anything saves.
          </p>

          <div style={{ background: `${PURPLE}08`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, color: INK, lineHeight: 1.5 }}>
                <strong>Don’t have a spreadsheet yet?</strong>
                <div style={{ color: MUTED, fontSize: 12.5, marginTop: 2 }}>
                  Download our template, open it in Google Sheets or Excel, fill in your schools, save it, then upload here.
                </div>
              </div>
              <button
                type="button"
                onClick={downloadTemplate}
                style={{ padding: '7px 14px', background: '#fff', color: PURPLE, border: `1px solid ${PURPLE}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >📄 Download template</button>
            </div>
          </div>

          <label
            htmlFor="partner-import-file"
            style={{ display: 'block', fontSize: 12.5, color: MUTED, marginBottom: 6 }}
          >Choose your spreadsheet:</label>
          <input
            id="partner-import-file"
            type="file"
            accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13, marginBottom: 10 }}
          />
          {file && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              Selected: <strong>{file.name}</strong> ({Math.round(file.size / 1024)} KB)
            </div>
          )}
        </div>
      )}

      {mode === 'text' && (
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: INK, lineHeight: 1.55 }}>
            Got your list in an email or a Word doc? Paste the whole thing below and
            we’ll pull out the schools and contacts for you. You’ll review everything
            before it saves.{' '}
            <span style={{ color: MUTED }}>(Uses AI to read messy text, so it’s sent to our AI provider.)</span>
          </p>
          <textarea
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste freeform text here…"
            style={{ width: '100%', padding: 10, fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }}
          />
          <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{text.length.toLocaleString()} characters</div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
        >Cancel</button>
        <button
          type="button"
          onClick={onNext}
          style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
        >{mode === 'file' ? 'Read file →' : 'Read with AI →'}</button>
      </div>
    </div>
  );
}

// Deterministic column-mapping step for the file path. Mirrors the roster CSV
// import: confirm which column maps to each field, see a preview, continue.
function MappingStep({ headers, rows, mapping, setMapping, onBack, onContinue }) {
  const emailCol = mapping.contact_email;
  const nameCol = mapping.contact_name;
  const partnerCol = mapping.partner_name;
  const colIdx = (h) => (h ? headers.indexOf(h) : -1);
  return (
    <div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, lineHeight: 1.5 }}>
        Read <strong>{rows.length}</strong> row{rows.length === 1 ? '' : 's'}. Confirm which column is which —
        we guessed where we could. Rows sharing a partner name are grouped into one partner.
        Only <strong>Partner / school name</strong> is required.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {PARTNER_FIELDS.map((def) => (
          <div key={def.key} style={{ padding: '4px 2px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 2 }}>
              {def.label}{def.required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
            </div>
            <select
              value={mapping[def.key] || ''}
              onChange={(e) => setMapping({ ...mapping, [def.key]: e.target.value || undefined })}
              style={{ width: '100%', padding: '5px 8px', border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 12, fontFamily: 'inherit', background: '#fff', color: INK }}
            >
              <option value="">— not in this file —</option>
              {headers.map((h, i) => <option key={i} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
        Preview (first 3 rows)
      </div>
      <div style={{ background: CREAM, padding: 10, borderRadius: 6, marginBottom: 14, maxHeight: 160, overflow: 'auto' }}>
        {rows.slice(0, 3).map((row, i) => (
          <div key={i} style={{ fontSize: 12, color: INK, padding: '3px 0', borderBottom: i < 2 ? `1px dashed ${RULE}` : 'none' }}>
            <strong>{partnerCol ? row[colIdx(partnerCol)] : <span style={{ color: RED }}>?</span>}</strong>
            {nameCol && <span style={{ color: MUTED }}> · {row[colIdx(nameCol)]}</span>}
            {emailCol && <span style={{ color: MUTED }}> · {row[colIdx(emailCol)]}</span>}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
        >← Back</button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!partnerCol}
          style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: partnerCol ? 'pointer' : 'not-allowed', opacity: partnerCol ? 1 : 0.5 }}
        >Continue →</button>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '8px 14px', background: 'transparent', border: 'none',
        borderBottom: active ? `2px solid ${PURPLE}` : '2px solid transparent',
        color: active ? PURPLE : MUTED, fontSize: 13, fontWeight: 600,
        fontFamily: 'inherit', cursor: 'pointer', marginBottom: -1,
      }}
    >{label}</button>
  );
}

function ReviewStep({ partners, existingByName, existingLocByPartner, selectedCount, updatePartner, updateContact, onBack, onCommit }) {
  const newPartners = partners.filter((p) => !existingByName.has(normName(p.partner_name))).length;
  const matchedPartners = partners.length - newPartners;
  return (
    <div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          Found <strong>{partners.length}</strong> partner{partners.length === 1 ? '' : 's'} ({newPartners} new, {matchedPartners} match existing){' '}
          with <strong>{partners.reduce((s, p) => s + (p.contacts?.length ?? 0), 0)}</strong> contacts total.
          Uncheck anything you don't want to bring in. Matched partners merge — existing data is kept; new contacts add.
        </div>
        <div style={{ fontSize: 12, color: MUTED, whiteSpace: 'nowrap' }}>
          Selected: {selectedCount.p}P / {selectedCount.c}C
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        {partners.map((p, pIdx) => {
          const match = existingByName.get(normName(p.partner_name));
          const existingLoc = existingLocByPartner?.get(normName(p.partner_name));
          return (
            <PartnerCard
              key={pIdx}
              p={p}
              match={match}
              existingLoc={existingLoc}
              onChange={(patch) => updatePartner(pIdx, patch)}
              onContactChange={(cIdx, patch) => updateContact(pIdx, cIdx, patch)}
            />
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '8px 14px', background: 'transparent', color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}
        >← Back</button>
        <button
          type="button"
          onClick={onCommit}
          disabled={selectedCount.p === 0 && selectedCount.c === 0}
          style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', opacity: (selectedCount.p === 0 && selectedCount.c === 0) ? 0.5 : 1 }}
        >Save {selectedCount.p} partner{selectedCount.p === 1 ? '' : 's'} / {selectedCount.c} contact{selectedCount.c === 1 ? '' : 's'}</button>
      </div>
    </div>
  );
}

function PartnerCard({ p, match, existingLoc, onChange, onContactChange }) {
  const isMatch = !!match;
  return (
    <div style={{
      background: '#fff', border: `1px solid ${isMatch ? AMBER + '55' : OK + '55'}`,
      borderLeft: `4px solid ${isMatch ? AMBER : OK}`,
      borderRadius: 8, padding: 14, opacity: p._selected ? 1 : 0.55,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          checked={!!p._selected}
          onChange={(e) => onChange({ _selected: e.target.checked })}
          style={{ marginTop: 6 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={p.partner_name ?? ''}
              onChange={(e) => onChange({ partner_name: e.target.value })}
              style={{ flex: '1 1 240px', fontSize: 14, fontWeight: 600, color: INK, padding: '4px 8px', border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit' }}
            />
            <span style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 99, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
              background: isMatch ? `${AMBER}1A` : `${OK}1A`, color: isMatch ? AMBER : OK,
            }}>
              {isMatch ? 'merge into existing' : 'new partner'}
            </span>
          </div>
          {isMatch && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Existing: <strong>{match.name}</strong> · new contacts will be added under it.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Field label="Type">
              <select
                value={p.partner_type ?? ''}
                onChange={(e) => onChange({ partner_type: e.target.value || null })}
                style={{ padding: '4px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit' }}
              >
                {PARTNER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Area">
              <input
                type="text"
                value={p.location_area ?? ''}
                onChange={(e) => onChange({ location_area: e.target.value || null })}
                placeholder="e.g. Denver"
                style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', width: 130 }}
              />
            </Field>
          </div>

          {/* Location details — shown when the partner is a venue type OR
              the import brought any of the three values OR an existing
              location is already linked with data on file. Existing values
              are surfaced as "Already on file:" hints; the import never
              overwrites them (edge fn fills blanks only). */}
          {(p.location_address || p.location_room_number || p.location_district ||
            existingLoc ||
            (p.partner_type && ['public_school','private_school','charter_school','community_org','church'].includes(p.partner_type))) && (
            <div style={{ marginTop: 10, padding: '8px 10px', background: `${PURPLE}06`, border: `1px dashed ${PURPLE}33`, borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: PURPLE, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                  Location details
                </div>
                {existingLoc && (
                  <div style={{ fontSize: 10.5, color: MUTED, fontStyle: 'italic' }}>
                    Already on file — leave blank to keep as-is.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Field label="Street address">
                  <input
                    type="text"
                    value={p.location_address ?? ''}
                    onChange={(e) => onChange({ location_address: e.target.value || null })}
                    placeholder={existingLoc?.address ? `Already: ${existingLoc.address}` : 'e.g. 3315 SE Lincoln St'}
                    style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', width: 240 }}
                  />
                  {existingLoc?.address && !p.location_address && (
                    <div style={{ fontSize: 10.5, color: OK, marginTop: 2 }}>✓ {existingLoc.address}</div>
                  )}
                </Field>
                <Field label="Room">
                  <input
                    type="text"
                    value={p.location_room_number ?? ''}
                    onChange={(e) => onChange({ location_room_number: e.target.value || null })}
                    placeholder={existingLoc?.room_number ? `Already: ${existingLoc.room_number}` : 'e.g. Room 12'}
                    style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', width: 110 }}
                  />
                  {existingLoc?.room_number && !p.location_room_number && (
                    <div style={{ fontSize: 10.5, color: OK, marginTop: 2 }}>✓ {existingLoc.room_number}</div>
                  )}
                </Field>
                <Field label="District">
                  <input
                    type="text"
                    value={p.location_district ?? ''}
                    onChange={(e) => onChange({ location_district: e.target.value || null })}
                    placeholder={existingLoc?.district ? `Already: ${existingLoc.district}` : 'e.g. Portland Public'}
                    style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 5, fontFamily: 'inherit', width: 160 }}
                  />
                  {existingLoc?.district && !p.location_district && (
                    <div style={{ fontSize: 10.5, color: OK, marginTop: 2 }}>✓ {existingLoc.district}</div>
                  )}
                </Field>
              </div>
            </div>
          )}

          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(p.contacts ?? []).map((c, cIdx) => (
              <ContactRow key={cIdx} c={c} onChange={(patch) => onContactChange(cIdx, patch)} />
            ))}
            {(!p.contacts || p.contacts.length === 0) && (
              <div style={{ fontSize: 12, color: MUTED, fontStyle: 'italic' }}>No contacts extracted for this partner.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactRow({ c, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 8px', background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6,
      opacity: c._selected ? 1 : 0.5,
    }}>
      <input
        type="checkbox"
        checked={!!c._selected}
        onChange={(e) => onChange({ _selected: e.target.checked })}
      />
      <input
        type="text"
        value={c.contact_name ?? ''}
        onChange={(e) => onChange({ contact_name: e.target.value })}
        placeholder="Name"
        style={{ flex: '1 1 120px', minWidth: 0, padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      />
      <input
        type="email"
        value={c.contact_email ?? ''}
        onChange={(e) => onChange({ contact_email: e.target.value })}
        placeholder="email@…"
        style={{ flex: '1 1 180px', minWidth: 0, padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      />
      <input
        type="text"
        value={c.contact_phone ?? ''}
        onChange={(e) => onChange({ contact_phone: e.target.value })}
        placeholder="phone"
        style={{ flex: '0 0 110px', padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      />
      <select
        value={c.contact_role ?? 'operational'}
        onChange={(e) => onChange({ contact_role: e.target.value })}
        style={{ flex: '0 0 150px', padding: '3px 6px', fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4, fontFamily: 'inherit' }}
      >
        {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
      </select>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}

const TYPE_LABEL = {
  public_school: 'Public school', private_school: 'Private school', charter_school: 'Charter school',
  school_district: 'School district', parks_rec: 'Parks & Rec', community_org: 'Community org', church: 'Church',
};

function DoneStep({ result, orgId, onClose }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(() => Array.isArray(result.partners_without_location) ? result.partners_without_location : []);
  const [added, setAdded] = useState([]); // [{ location_id, location_name }]
  const [busyId, setBusyId] = useState(null);
  const [rowErr, setRowErr] = useState(null);

  const locsCreated = result.locations_created ?? 0;
  const locsLinked = result.locations_linked ?? 0;
  const locTotal = locsCreated + locsLinked + added.length;
  // Drive the unlocks card + Create-a-program button off touched locations
  // (which includes idempotent re-imports), not just net-new counts. Otherwise
  // a re-upload with everything already linked leaves only an orphan
  // "I'll do this later" button.
  const hasUsableLocations = locTotal > 0 || (Array.isArray(result.touched_locations) && result.touched_locations.length > 0);
  // All venue locations the import touched + any the operator just added
  // inline. Each gets an "Edit details" link so paragraph fields (arrival
  // instructions, food policy, notes) are one click away.
  const touched = [
    ...((Array.isArray(result.touched_locations) ? result.touched_locations : [])),
    ...added,
  ];

  async function addAsLocation(partner) {
    setBusyId(partner.partner_id);
    setRowErr(null);
    try {
      const base = (partner.partner_name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'venue';
      const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
      const { data, error } = await supabase
        .from('program_locations')
        .insert({ organization_id: orgId, name: partner.partner_name, slug, partner_id: partner.partner_id })
        .select('id')
        .maybeSingle();
      if (error) throw error;
      setAdded((a) => [...a, { location_id: data?.id, location_name: partner.partner_name, was_created: true }]);
      setPending((p) => p.filter((x) => x.partner_id !== partner.partner_id));
    } catch (e) {
      setRowErr(`Couldn't add ${partner.partner_name} as a location: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {/* Celebration */}
      <div style={{ textAlign: 'center', padding: '8px 0 14px' }}>
        <div style={{ fontSize: 40, lineHeight: 1 }}>🎉</div>
        <h3 style={{ margin: '8px 0 2px', fontSize: 18, fontWeight: 800, color: PURPLE }}>Your contacts are in.</h3>
        <p style={{ margin: 0, fontSize: 13, color: MUTED }}>
          {result.partners_created} new partner{result.partners_created === 1 ? '' : 's'}
          {result.partners_merged > 0 && `, ${result.partners_merged} updated`}
          {' · '}{result.contacts_created} contact{result.contacts_created === 1 ? '' : 's'} added
          {result.contacts_skipped > 0 && ` · ${result.contacts_skipped} skipped (already on file)`}
        </p>
      </div>

      {/* Locations narration */}
      {hasUsableLocations && (
        <div style={{ background: `${OK}12`, border: `1px solid ${OK}44`, padding: 14, borderRadius: 8, fontSize: 14, color: INK, lineHeight: 1.6 }}>
          {(locsCreated > 0 || locsLinked > 0) ? (
            <div>
              🏫 We set up{' '}
              {locsCreated > 0 && <strong>{locsCreated} school{locsCreated === 1 ? '' : 's'} as location{locsCreated === 1 ? '' : 's'}</strong>}
              {locsCreated > 0 && locsLinked > 0 && ' and '}
              {locsLinked > 0 && <strong>linked {locsLinked} you already had</strong>}.
            </div>
          ) : (
            <div>🏫 Your <strong>{touched.length} school location{touched.length === 1 ? '' : 's'}</strong> are already set up.</div>
          )}
          {touched.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, color: MUTED }}>
              Add arrival instructions, room numbers, food policies, and more:
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {touched.map((t) => (
                  <button
                    key={t.location_id}
                    type="button"
                    onClick={() => { onClose(); navigate(`/admin/schools?tab=locations&edit=${t.location_id}`); }}
                    style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, color: PURPLE, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
                  >✏️ {t.location_name}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Umbrella partners — invite the operator to add their real venues */}
      {pending.length > 0 && (
        <div style={{ marginTop: 12, border: `1px solid ${RULE}`, borderRadius: 8, padding: 14 }}>
          <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: INK }}>
            Add a location for these?
          </p>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
            A district or Parks &amp; Rec usually covers several sites, so we didn’t guess.
            Add the specific venue where you’ll run programs — or skip and add them later under Locations.
          </p>
          {rowErr && <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12.5, marginBottom: 8 }}>{rowErr}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pending.map((p) => (
              <div key={p.partner_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: '8px 10px' }}>
                <span style={{ fontSize: 13, color: INK }}>
                  {p.partner_name}{' '}
                  <span style={{ fontSize: 11, color: MUTED }}>· {TYPE_LABEL[p.partner_type] ?? p.partner_type}</span>
                </span>
                <button
                  type="button"
                  disabled={busyId === p.partner_id}
                  onClick={() => addAsLocation(p)}
                  style={{ padding: '5px 12px', background: '#fff', color: PURPLE, border: `1px solid ${PURPLE}`, borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', opacity: busyId === p.partner_id ? 0.6 : 1 }}
                >{busyId === p.partner_id ? 'Adding…' : 'Add as location'}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {added.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: OK }}>
          ✓ Added {added.length} more location{added.length === 1 ? '' : 's'}.
        </div>
      )}

      {/* What this unlocks */}
      {hasUsableLocations && (
        <div style={{ marginTop: 14, background: `${PURPLE}0A`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 14 }}>
          <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: PURPLE }}>What this unlocks</p>
          <p style={{ margin: 0, fontSize: 13, color: INK, lineHeight: 1.6 }}>
            With {touched.length} location{touched.length === 1 ? '' : 's'} set up, you’re ready to <strong>schedule programs</strong> there and
            open <strong>registration</strong> to families. And because each school’s contacts are attached, your
            class rosters will email the right people automatically — no lookups.
          </p>
        </div>
      )}

      {Array.isArray(result.errors) && result.errors.length > 0 && (
        <div style={{ marginTop: 10, background: `${AMBER}1A`, color: AMBER, padding: 10, borderRadius: 6, fontSize: 12.5 }}>
          <strong>{result.errors.length} row{result.errors.length === 1 ? '' : 's'} need a second look:</strong>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {result.errors.slice(0, 8).map((e, i) => <li key={i}>{e.partner}: {e.reason}</li>)}
            {result.errors.length > 8 && <li>…and {result.errors.length - 8} more</li>}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ padding: '8px 16px', background: '#fff', color: INK, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
        >I’ll do this later</button>
        {hasUsableLocations && (
          <button
            type="button"
            onClick={() => { onClose(); navigate('/admin/programs/new'); }}
            style={{ padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
          >Create a program →</button>
        )}
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normName(s) {
  return (s ?? '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      // strip data URL prefix
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
