// Regenerates an org's email-safe logo PNG from organizations.logo_url and
// stores the public URL in organizations.logo_email_url. Source can be SVG
// (rasterized via resvg-wasm) or PNG (passed through).
//
// Call this whenever an org's logo_url changes. Sketch of integration:
//   1. Org admin uploads a new logo to the org-assets bucket
//   2. Upload handler sets organizations.logo_url
//   3. Upload handler POSTs to this function with the org_id
//   4. Email templates read logo_email_url (preferred) or logo_url
//
// Auth: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>. Only callers with
// the service role key (i.e. other edge functions / trusted server code) can
// invoke this. verify_jwt is set to false because we authenticate via the
// service-role key directly rather than a user JWT.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { Resvg, initWasm } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WASM_URL = 'https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm';
const BUCKET = 'org-assets';
const DEFAULT_WIDTH = 800;

let wasmReady: Promise<void> | null = null;
async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const buf = await fetch(WASM_URL).then(r => {
        if (!r.ok) throw new Error(`wasm fetch ${r.status}`);
        return r.arrayBuffer();
      });
      await initWasm(buf);
    })();
  }
  return wasmReady;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return json({ error: 'forbidden — service role bearer token required' }, 403);
  }

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const orgId = String(body.org_id ?? '');
    if (!orgId) return json({ error: 'org_id required' }, 400);
    const width = Number(body.width ?? DEFAULT_WIDTH);
    const targetPath = String(body.target_path ?? `${orgId}/logo-email.png`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, logo_url')
      .eq('id', orgId)
      .single();
    if (orgErr || !org) return json({ error: 'org not found', orgErr }, 404);
    if (!org.logo_url) return json({ error: 'org has no logo_url to source from' }, 400);

    const srcRes = await fetch(org.logo_url);
    if (!srcRes.ok) return json({ error: `source fetch ${srcRes.status}` }, 502);
    const srcBytes = new Uint8Array(await srcRes.arrayBuffer());
    const srcContentType = (srcRes.headers.get('content-type') ?? '').toLowerCase();

    const sniff = new TextDecoder('utf-8', { fatal: false }).decode(srcBytes.slice(0, 200));
    const looksLikeSvg =
      srcContentType.includes('svg') ||
      org.logo_url.toLowerCase().endsWith('.svg') ||
      sniff.includes('<svg');
    const looksLikePng =
      srcContentType.includes('png') ||
      org.logo_url.toLowerCase().endsWith('.png') ||
      (srcBytes[0] === 0x89 && srcBytes[1] === 0x50 && srcBytes[2] === 0x4e && srcBytes[3] === 0x47);

    let pngBytes: Uint8Array;
    let mode: 'svg-rasterized' | 'png-passthrough';
    if (looksLikeSvg) {
      await ensureWasm();
      const resvg = new Resvg(srcBytes, { fitTo: { mode: 'width', value: width } });
      pngBytes = resvg.render().asPng();
      mode = 'svg-rasterized';
    } else if (looksLikePng) {
      pngBytes = srcBytes;
      mode = 'png-passthrough';
    } else {
      return json(
        { error: 'source must be SVG or PNG', detected_content_type: srcContentType },
        415,
      );
    }

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(targetPath, pngBytes, { contentType: 'image/png', upsert: true });
    if (upErr) return json({ error: 'upload failed', upErr }, 500);

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(targetPath);
    const publicUrl = pub.publicUrl;

    const { error: updErr } = await supabase
      .from('organizations')
      .update({ logo_email_url: publicUrl })
      .eq('id', orgId);
    if (updErr) return json({ error: 'org update failed', updErr }, 500);

    return json({
      ok: true,
      org_id: orgId,
      mode,
      source_url: org.logo_url,
      logo_email_url: publicUrl,
      storage_path: `${BUCKET}/${targetPath}`,
      png_bytes: pngBytes.length,
      width_px: mode === 'svg-rasterized' ? width : null,
    });
  } catch (e) {
    console.error('regenerate-email-logo error:', e);
    return json({ error: (e as Error).message, stack: (e as Error).stack }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
