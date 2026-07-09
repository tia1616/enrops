// import-partners-extract: takes a CSV, XLSX, or pasted free-text blob and
// asks Claude to extract a structured list of partners + contacts that the
// operator can review before writing to the DB.
//
// Input:
//   {
//     organization_id: string, // the org the operator is importing into
//     source: 'csv' | 'xlsx' | 'text',
//     payload: string,        // CSV/text content directly; XLSX is base64
//     filename?: string,      // optional, surfaced in the prompt for hints
//   }
//
// Output:
//   {
//     partners: [{ partner_name, partner_type, ..., contacts: [...] }, ...],
//     notes?: string,
//   }
//
// Auth: caller must be owner/admin of the specified organization_id. The
// extraction itself reads no tenant data (it only parses the operator's own
// uploaded payload), but we scope the gate to the target org so the call
// can't be made by an admin of some unrelated org.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import Anthropic from 'npm:@anthropic-ai/sdk@0.96.0';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Canonical schema the LLM must produce.
const SCHEMA = {
  partners: [
    {
      partner_name: 'string (REQUIRED; the organisation name e.g. "Cherry Creek School District")',
      partner_type: "enum: 'public_school' | 'private_school' | 'charter_school' | 'school_district' | 'church' | 'parks_rec' | 'community_org' — null if unsure (do NOT invent values)",
      location_area: 'string — neighbourhood / city / region (null if not present)',
      locations_managed: 'string — comma-separated school/site names this partner runs (null if unsure)',
      marketing_notes: 'string or null',
      invoicing_notes: 'string or null',
      planning_notes: 'string or null',
      implementation_notes: 'string or null',
      other_notes: 'string or null — anything unclassified',
      location_address: 'string — street address of the physical venue (school building, rec center). null if not present. Only fill for single-venue partners (schools, community orgs, churches) — leave null for districts or umbrella partners that cover multiple sites.',
      location_room_number: 'string — room/classroom/suite identifier at the venue (e.g. "Room 12", "Gym B", "Suite 201"). null if not present.',
      location_district: 'string — school district or governing body the venue belongs to (e.g. "Portland Public", "Beaverton SD"). null if not present.',
      contacts: [
        {
          contact_name: 'string or null',
          contact_email: 'string — REQUIRED to keep this contact row; skip rows without an email',
          contact_phone: 'string or null',
          contact_role: "enum: 'operational' | 'marketing' | 'invoicing' | 'approval_gatekeeper'. operational = day-to-day site logistics / signups / families. marketing = flyer/email distribution to families. invoicing = billing/AP. approval_gatekeeper = principal/director who must approve any communications before they go out.",
          role_description: 'string or null — free-text description of what this contact actually handles',
          is_org_inbox: 'boolean — true if this is a shared inbox (info@, contact@, ops@) rather than a person',
        },
      ],
    },
  ],
};

const EXTRACTION_PROMPT = `You are extracting partner organisations and their logistics contacts from data the operator has supplied. Each "partner" is an external organisation that hosts or signs up families for our programs — typically a school, school district, parks & rec department, community org, or church.

Your output MUST be valid JSON matching this exact schema (no markdown, no commentary, just the JSON object):

${JSON.stringify(SCHEMA, null, 2)}

Rules:
1. Skip any contact row that has no email.
2. If two rows clearly refer to the same partner organisation, merge them into ONE partner with multiple contacts.
3. partner_type: only use one of the listed enums; null if unsure. Do NOT invent new types. Distinctions that matter:
   - 'parks_rec' = the umbrella Parks & Recreation department/agency (e.g. "City of Portland Parks & Rec", "Beaverton Parks & Recreation Dept"). Use this ONLY when the partner runs many venues.
   - 'community_org' = a single named community venue (e.g. "Riverbend Community Rec Center", "Mt Scott Community Center", a YMCA branch). Even if Parks & Rec operates it, the named building itself is community_org.
   - 'school_district' = the umbrella district office; never an individual school.
   - 'public_school' / 'private_school' / 'charter_school' = a single named school building.
4. contact_role: only use 'operational', 'marketing', 'invoicing', or 'approval_gatekeeper'. Default to 'operational' if the role is "logistics", "site coordinator", "registrar", "afterschool coordinator", or similar. Use 'marketing' for "flyer distribution", "communications", "PTO president". Use 'approval_gatekeeper' for principals/directors who must sign off on communications. Use 'invoicing' only for billing/AP roles.
5. is_org_inbox: true for emails like info@, contact@, hello@, ops@, mainoffice@. False for a named person's email.
6. Preserve every distinct contact you see — do NOT dedupe across partners.
7. If the data is messy or freeform (e.g. an email thread), do your best to identify school/org names + the relevant people; ignore unrelated conversation.
8. location_address / location_room_number / location_district: extract these when they appear NEAR the partner name (signature blocks, address lines, "Room X" mentions). Only attach them to SINGLE-VENUE partners (schools, community centers, churches). For multi-site partners (school districts, Parks & Rec departments that run several venues), leave all three null — the operator will add the individual venue addresses separately. Do not invent or guess; if you don't see it in the text, return null.

Return ONLY the JSON, starting with { and ending with }.`;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const organizationId: string = body.organization_id ?? '';
    const source: 'csv' | 'xlsx' | 'text' = body.source;
    const payload: string = body.payload ?? '';
    const filename: string | undefined = body.filename;

    if (!organizationId) return json({ error: 'organization_id is required' }, 400);
    if (!['csv', 'xlsx', 'text'].includes(source)) return json({ error: 'unknown source' }, 400);
    if (!payload) return json({ error: 'payload is empty' }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Auth: caller must be owner/admin of THIS organization.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    const { data: memberships } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', organizationId)
      .in('role', ['owner', 'admin']);
    if (!memberships || memberships.length === 0) return json({ error: 'forbidden' }, 403);

    // ── Normalise source to a single text-or-grid representation ─────────
    let modelInput: string;
    if (source === 'text') {
      // Strip pasted Drive doc artifacts (image refs, "Open in Docs" links).
      modelInput = `Pasted text${filename ? ` (from ${filename})` : ''}:\n\n${payload.slice(0, 60000)}`;
    } else if (source === 'csv') {
      const grid = csvToGrid(payload);
      modelInput = renderGridForModel(grid, filename);
    } else {
      // xlsx — payload is base64
      const bytes = base64ToBytes(payload);
      const wb = XLSX.read(bytes, { type: 'array' });
      const grids: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        // deno-lint-ignore no-explicit-any
        const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }) as any[][];
        if (grid.length === 0) continue;
        grids.push(`### Sheet: ${sheetName}\n\n${renderGridForModel(grid, undefined)}`);
      }
      modelInput = grids.join('\n\n');
    }

    if (!modelInput.trim()) return json({ error: 'no usable content found in payload' }, 400);

    // ── Call Claude ──────────────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: modelInput }],
    });

    // Concatenate text blocks.
    let raw = '';
    for (const block of resp.content) {
      if (block.type === 'text') raw += block.text;
    }
    raw = raw.trim();
    // Strip stray markdown fences if the model added them despite the rule.
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      return json({ error: 'model returned non-JSON', raw: raw.slice(0, 1000) }, 502);
    }

    const partners = sanitisePartners((parsed as { partners?: unknown }).partners ?? []);
    return json({ partners });
  } catch (err) {
    console.error('[import-partners-extract] unexpected', err);
    return json({ error: (err as Error).message ?? 'unexpected error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function base64ToBytes(b64: string): Uint8Array {
  // Strip data-url prefix if present
  const clean = b64.includes(',') ? b64.split(',', 2)[1] : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Tiny CSV parser; quoted fields with "" escapes + CRLF/LF.
function csvToGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* swallow */ }
      else field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Render a 2D grid in a compact form the model can read. Pipes are fine
// here because we're not enforcing a strict CSV roundtrip; the model just
// needs to see headers + rows.
function renderGridForModel(grid: string[][], filename?: string): string {
  const trimmed = grid.filter((r) => r.some((c) => (c ?? '').trim().length > 0));
  if (trimmed.length === 0) return '';
  const out: string[] = [];
  if (filename) out.push(`File: ${filename}`);
  for (let i = 0; i < trimmed.length; i++) {
    const row = trimmed[i];
    out.push(row.map((c) => (c ?? '').toString().replace(/\s+/g, ' ').trim()).join(' | '));
    // Soft cap: 1000 rows is plenty; the token budget is the real ceiling.
    if (i >= 1000) { out.push('… (truncated)'); break; }
  }
  return out.join('\n');
}

// Drop anything that doesn't have at least one usable field, normalise
// enums, and discard contacts with no email.
function sanitisePartners(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  const PARTNER_TYPES = new Set(['public_school','private_school','charter_school','school_district','church','parks_rec','community_org']);
  const ROLES = new Set(['operational','marketing','invoicing','approval_gatekeeper']);
  const out: unknown[] = [];
  for (const p of input as Record<string, unknown>[]) {
    const name = strOrNull(p.partner_name);
    if (!name) continue;
    const contactsRaw = Array.isArray(p.contacts) ? p.contacts : [];
    const contacts: Record<string, unknown>[] = [];
    for (const c of contactsRaw as Record<string, unknown>[]) {
      const email = strOrNull(c.contact_email);
      if (!email) continue;
      const role = strOrNull(c.contact_role);
      contacts.push({
        contact_name: strOrNull(c.contact_name),
        contact_email: email.toLowerCase(),
        contact_phone: strOrNull(c.contact_phone),
        contact_role: role && ROLES.has(role) ? role : 'operational',
        role_description: strOrNull(c.role_description),
        is_org_inbox: !!c.is_org_inbox,
      });
    }
    const partnerType = strOrNull(p.partner_type);
    out.push({
      partner_name: name,
      partner_type: partnerType && PARTNER_TYPES.has(partnerType) ? partnerType : null,
      location_area: strOrNull(p.location_area),
      locations_managed: strOrNull(p.locations_managed),
      marketing_notes: strOrNull(p.marketing_notes),
      invoicing_notes: strOrNull(p.invoicing_notes),
      planning_notes: strOrNull(p.planning_notes),
      implementation_notes: strOrNull(p.implementation_notes),
      other_notes: strOrNull(p.other_notes),
      location_address: strOrNull(p.location_address),
      location_room_number: strOrNull(p.location_room_number),
      location_district: strOrNull(p.location_district),
      contacts,
    });
  }
  return out;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}
