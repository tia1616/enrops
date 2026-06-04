// import-partners-parse: DETERMINISTIC parse of a CSV or XLSX upload into a
// plain { headers, rows } grid. No AI, no Anthropic key — the file is read in
// our own infra and never sent to a third party. The browser then shows a
// column-mapping step (like the roster CSV import) and groups rows into
// partners + contacts locally.
//
// The AI path (import-partners-extract) is kept only for the "paste freeform
// text" case, where there are no columns to map.
//
// Input:  { source: 'csv' | 'xlsx', payload: string, filename?: string }
//         payload = raw CSV text, or base64 for XLSX.
// Output: { headers: string[], rows: string[][], sheet?: string }
//
// Auth: caller must be owner/admin of some org (same gate as the AI extractor).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const source: 'csv' | 'xlsx' = body.source;
    const payload: string = body.payload ?? '';
    if (!['csv', 'xlsx'].includes(source)) return json({ error: 'unknown source' }, 400);
    if (!payload) return json({ error: 'payload is empty' }, 400);

    // Auth — owner/admin of any org (parsing is org-agnostic; the write step
    // re-checks org membership).
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);
    const { data: memberships } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .in('role', ['owner', 'admin']);
    if (!memberships || memberships.length === 0) return json({ error: 'forbidden' }, 403);

    let grid: string[][];
    let sheet: string | undefined;
    if (source === 'csv') {
      grid = csvToGrid(payload);
    } else {
      const bytes = base64ToBytes(payload);
      const wb = XLSX.read(bytes, { type: 'array' });
      // Use the first sheet that has any data.
      let chosen: string[][] = [];
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        const g = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }) as unknown[][];
        const cleaned = (g as unknown[][]).map((r) => (r as unknown[]).map((c) => String(c ?? '')));
        if (cleaned.some((r) => r.some((c) => c.trim().length > 0))) {
          chosen = cleaned;
          sheet = name;
          break;
        }
      }
      grid = chosen;
    }

    // Drop fully-empty rows, find the header row (first non-empty), normalise
    // ragged rows to the header width.
    const nonEmpty = grid.filter((r) => r.some((c) => (c ?? '').trim().length > 0));
    if (nonEmpty.length === 0) return json({ error: 'no rows found in file' }, 400);

    const headers = nonEmpty[0].map((h) => (h ?? '').toString().trim());
    const width = headers.length;
    const rows = nonEmpty.slice(1).map((r) => {
      const out: string[] = [];
      for (let i = 0; i < width; i++) out.push((r[i] ?? '').toString().trim());
      return out;
    }).filter((r) => r.some((c) => c.length > 0));

    if (rows.length > 5000) return json({ error: 'too_many_rows', limit: 5000 }, 413);

    return json({ headers, rows, sheet });
  } catch (err) {
    console.error('[import-partners-parse] unexpected', err);
    return json({ error: (err as Error).message ?? 'unexpected error' }, 500);
  }
});

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.split(',', 2)[1] : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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
