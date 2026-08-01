// backup-storage-objects
//
// Weekly OFF-SITE backup of Enrops's three PRIVATE storage buckets
// (contractor-documents, curriculum-documents, program-documents) to a
// Cloudflare R2 bucket. Supabase PITR backs up Postgres but NOT storage
// objects, and the BGC PDFs / signed agreements can't be re-created — so
// this is Darren's pre-launch must-do #1.
//
// PROD-ONLY infra (like replay-digest): staging holds only synthetic data.
//
// Auth: verify_jwt=false. The endpoint authenticates the caller itself
// against the Vault secret `backup_cron_secret` (Bearer), so only the pg_cron
// job (which reads the same secret from Vault) can invoke it.
//
// Secrets (Vault, read via public.app_secret()):
//   backup_cron_secret  — gate secret for this endpoint
//   r2_backup_config    — JSON: { endpoint, bucket, access_key_id, secret_access_key }
//
// R2 layout: object is stored at  <r2-bucket>/<source-bucket>/<source-path>.
// We NEVER delete from R2 — so a file deleted/corrupted in prod still survives
// in the backup. Re-runs overwrite the same key (idempotent).
//
// Body — three mutually exclusive modes, checked in this order:
//   { dry_run: true }                    list/count what WOULD be copied, copy nothing.
//   { restore_check: true, sample?: n }  RESTORE DRILL: pull n objects (1-5, default 3,
//                                        spread across the buckets) back OUT of R2 and
//                                        prove each is byte-identical to the live source
//                                        by SHA-256. This is the only mode that tests
//                                        RECOVERY rather than backup, so it is the one
//                                        worth running by hand periodically. Nothing
//                                        calls it on a schedule.
//   {} (or no body)                      do the actual backup.
//
// The header used to document only dry_run, which is how restore_check ended up
// missing from the body type as well.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CONCURRENCY = 5;

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

// `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`. Newer lib types make
// Uint8Array generic over its backing store, and the default
// `Uint8Array<ArrayBufferLike>` includes SharedArrayBuffer-backed views, which
// crypto.subtle.digest's BufferSource does not accept. Narrowing the PARAMETER
// is the honest fix: both callers build theirs from `await blob.arrayBuffer()`
// / `await res.arrayBuffer()`, which are plain ArrayBuffers, so they already
// satisfy it — no cast needed, and a genuinely shared buffer would now be
// rejected at the call site instead of here.
async function sha256hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // --- authenticate against the gate secret ---
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const { data: gate, error: gateErr } = await admin.rpc('app_secret', { p_name: 'backup_cron_secret' });
  if (gateErr) return json({ error: 'gate secret read failed', detail: gateErr.message }, 500);
  if (!token || token !== gate) return json({ error: 'unauthorized' }, 401);

  // All three modes are declared here. `restore_check` and `sample` were read
  // below but missing from this type, which is what `deno check` was reporting.
  //
  // It was ONLY a declaration gap, not a dead feature: `req.json()` is `any`, so
  // the assignment is allowed, Deno strips types at runtime, and
  // `body.restore_check` has always read the real posted value. Verified rather
  // than assumed — a standalone Deno script with the same narrow annotation
  // still reports the property as present and the branch as taken.
  let body: { dry_run?: boolean; restore_check?: boolean; sample?: number } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  // --- R2 config ---
  const { data: cfgRaw, error: cfgErr } = await admin.rpc('app_secret', { p_name: 'r2_backup_config' });
  if (cfgErr || !cfgRaw) return json({ error: 'r2 config read failed', detail: cfgErr?.message }, 500);
  const cfg = JSON.parse(cfgRaw as string);
  const aws = new AwsClient({
    accessKeyId: cfg.access_key_id,
    secretAccessKey: cfg.secret_access_key,
    region: 'auto',
    service: 's3',
  });
  const base = `${String(cfg.endpoint).replace(/\/$/, '')}/${cfg.bucket}`;

  // --- enumerate what to back up ---
  const { data: objects, error: listErr } = await admin.rpc('list_private_backup_objects');
  if (listErr) return json({ error: 'list failed', detail: listErr.message }, 500);
  const rows = (objects || []) as Array<{ bucket_id: string; name: string; mimetype: string | null }>;

  if (body?.dry_run === true) {
    const byBucket: Record<string, number> = {};
    for (const o of rows) byBucket[o.bucket_id] = (byBucket[o.bucket_id] || 0) + 1;
    return json({ ok: true, dry_run: true, total: rows.length, by_bucket: byBucket });
  }

  // --- restore drill: pull sample objects BACK from R2 and prove they are
  //     byte-identical to the live source (SHA-256). This is the real recovery test.
  if (body?.restore_check === true) {
    const n = Math.max(1, Math.min(5, Number(body?.sample) || 3));
    // spread the sample across the three buckets
    const seen = new Set<string>();
    const sample: typeof rows = [];
    for (const o of rows) {
      if (!seen.has(o.bucket_id)) { seen.add(o.bucket_id); sample.push(o); }
    }
    for (const o of rows) { if (sample.length >= n) break; if (!sample.includes(o)) sample.push(o); }
    const checks = [];
    for (const o of sample.slice(0, n)) {
      const key = `${o.bucket_id}/${o.name}`;
      const url = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const { data: blob, error: dlErr } = await admin.storage.from(o.bucket_id).download(o.name);
        if (dlErr || !blob) throw new Error(`source download: ${dlErr?.message || 'no data'}`);
        const src = new Uint8Array(await blob.arrayBuffer());
        const r2res = await aws.fetch(url, { method: 'GET' });
        if (!r2res.ok) throw new Error(`r2 get ${r2res.status}`);
        const r2 = new Uint8Array(await r2res.arrayBuffer());
        const srcHash = await sha256hex(src);
        const r2Hash = await sha256hex(r2);
        checks.push({ key, source_bytes: src.length, r2_bytes: r2.length, sha256_match: srcHash === r2Hash });
      } catch (e) {
        checks.push({ key, error: String((e as Error)?.message || e) });
      }
    }
    return json({ ok: checks.every((c) => (c as { sha256_match?: boolean }).sha256_match === true), restore_check: true, samples: checks });
  }

  // --- copy each object to R2 (bounded concurrency) ---
  const results = { uploaded: 0, failed: 0, bytes: 0, errors: [] as Array<{ key: string; error: string }> };
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const o = rows[idx++];
      const key = `${o.bucket_id}/${o.name}`;
      try {
        const { data: blob, error: dlErr } = await admin.storage.from(o.bucket_id).download(o.name);
        if (dlErr || !blob) throw new Error(`download: ${dlErr?.message || 'no data'}`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const putUrl = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
        const res = await aws.fetch(putUrl, {
          method: 'PUT',
          body: bytes,
          headers: { 'Content-Type': o.mimetype || 'application/octet-stream' },
        });
        if (!res.ok) throw new Error(`r2 put ${res.status}: ${(await res.text()).slice(0, 200)}`);
        results.uploaded++;
        results.bytes += bytes.length;
      } catch (e) {
        results.failed++;
        results.errors.push({ key, error: String((e as Error)?.message || e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  // --- verify: authoritative count of objects now in R2 (eat the cooking) ---
  let r2ObjectCount: number | null = null;
  try {
    const listRes = await aws.fetch(`${base}?list-type=2`, { method: 'GET' });
    if (listRes.ok) {
      const xml = await listRes.text();
      const m = xml.match(/<KeyCount>(\d+)<\/KeyCount>/);
      r2ObjectCount = m ? parseInt(m[1], 10) : null;
    }
  } catch { /* verification is best-effort */ }

  return json({
    ok: results.failed === 0,
    source_objects: rows.length,
    uploaded: results.uploaded,
    failed: results.failed,
    bytes_uploaded: results.bytes,
    r2_object_count: r2ObjectCount,
    errors: results.errors.slice(0, 20),
    ran_at: new Date().toISOString(),
  });
});
