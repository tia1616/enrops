// upload-class-photo - an instructor files one photo against a class day.
//
// Flow: authenticate the instructor -> check the provider has class photos on
// -> stamp the enrops watermark (plus the provider's logo when they turned it
// on) -> store the marked JPEG in the private
// `class-photos` bucket -> insert the class_photos row AS THE CALLER.
//
// THE INSERT IS THE AUTHORIZATION. The row is written under the instructor's own
// JWT, so the class_photos_instructor_insert policy is what decides whether they
// may photograph this class on this day (regular instructor, or a confirmed sub
// for exactly that date). Nothing here re-derives that rule; a refusal from the
// policy removes the stored file again, so a refused upload leaves nothing behind.
//
// The storage object is written with the service role because the bucket has no
// client INSERT policy on purpose: this function is the only path in, and it
// always watermarks first.
//
// Auth: instructor JWT. verify_jwt = true (pinned in config.toml).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';
import { isJpeg, watermarkJpeg } from '../_shared/classPhotoWatermark.ts';

const BUCKET = 'class-photos';
// The phone sends at most ~1600px / well under 1 MB. This is the ceiling, not the
// expectation; it also bounds the decode memory.
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A logo PNG is tens of KB; this only stops a mistake from decoding something huge.
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * The provider's email logo, which regenerate-email-logo writes to
 * org-assets/<org id>/logo-email.png. logo_email_url is a column the provider can
 * update, so it is fetched ONLY when it points into this provider's own folder in
 * our own public bucket - never an arbitrary URL from this function's network
 * position. Anything else, or any failure, returns null.
 */
// An instructor often uploads several photos in a row; the logo is the same for
// all of them. Kept per isolate for a few minutes, keyed by URL, so a new logo
// (a new URL, or the same one after the TTL) is picked up without a redeploy.
const LOGO_TTL_MS = 10 * 60 * 1000;
const logoCache = new Map<string, { bytes: Uint8Array; at: number }>();

async function fetchProviderLogo(url: unknown, orgId: string): Promise<Uint8Array | null> {
  if (typeof url !== 'string' || !url) return null;
  // Keyed by org AND url: keyed by url alone, a provider who pointed their
  // logo_email_url at another provider's logo would get a cache hit that skips
  // the own-folder check below.
  const key = `${orgId}|${url}`;
  const hit = logoCache.get(key);
  if (hit && Date.now() - hit.at < LOGO_TTL_MS) return hit.bytes;
  const bytes = await fetchProviderLogoUncached(url, orgId);
  if (bytes) logoCache.set(key, { bytes, at: Date.now() });
  return bytes;
}

async function fetchProviderLogoUncached(url: string, orgId: string): Promise<Uint8Array | null> {
  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  const allowed = `${base}/storage/v1/object/public/org-assets/${orgId}/`;
  if (!base || !url.startsWith(allowed) || url.includes('..')) {
    console.error('[upload-class-photo] logo url outside the provider folder, skipped:', url);
    return null;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error('[upload-class-photo] logo fetch', res.status, url);
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) return null;
    return buf;
  } catch (e) {
    console.error('[upload-class-photo] logo fetch failed, stamping enrops only:', e);
    return null;
  }
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: 'invalid_form' }, 400);
    }
    const programId = String(form.get('program_id') ?? '').trim();
    const sessionDate = String(form.get('session_date') ?? '').trim();
    const file = form.get('file');
    if (!UUID_RE.test(programId)) return json({ error: 'program_id_required' }, 400);
    if (!DATE_RE.test(sessionDate) || Number.isNaN(Date.parse(sessionDate))) {
      return json({ error: 'session_date_required' }, 400);
    }
    if (!(file instanceof File)) return json({ error: 'file_required' }, 400);
    if (file.size === 0) return json({ error: 'file_empty' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'file_too_large' }, 413);

    const admin = adminClient();

    // Same-org + feature-on gate, for a readable refusal. The insert policy
    // enforces both again; this only exists so the instructor is told WHY.
    const { data: program, error: pErr } = await admin
      .from('programs')
      .select('id, organization_id')
      .eq('id', programId)
      .maybeSingle();
    if (pErr) {
      console.error('[upload-class-photo] program lookup failed:', pErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!program || program.organization_id !== me.organization_id) {
      return json({ error: 'not_found' }, 404);
    }
    const { data: org, error: oErr } = await admin
      .from('organizations')
      .select('class_photos_enabled, class_photo_show_logo, logo_email_url')
      .eq('id', program.organization_id)
      .maybeSingle();
    if (oErr) {
      console.error('[upload-class-photo] org lookup failed:', oErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!org?.class_photos_enabled) return json({ error: 'class_photos_off' }, 403);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isJpeg(bytes)) return json({ error: 'not_a_jpeg' }, 415);

    // The provider's logo rides along only when they turned it on. Missing,
    // unreachable or oversized, it is skipped and the photo still goes up with
    // the enrops mark: a logo problem must never cost an instructor the photo.
    const providerLogo = org.class_photo_show_logo === true
      ? await fetchProviderLogo(org.logo_email_url, program.organization_id)
      : null;

    let marked: Uint8Array;
    try {
      marked = await watermarkJpeg(bytes, { providerLogo });
    } catch (e) {
      if (e instanceof Error && e.message === 'image_too_large') {
        return json({ error: 'file_too_large' }, 413);
      }
      if (e instanceof Error && e.message === 'watermark_unavailable') {
        return json({ error: 'try_again_later' }, 503);
      }
      console.error('[upload-class-photo] watermark failed:', e);
      return json({ error: 'image_unreadable' }, 422);
    }

    const path = `${program.organization_id}/${programId}/${sessionDate}/${crypto.randomUUID()}.jpg`;
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(path, marked, { contentType: 'image/jpeg', upsert: false });
    if (upErr) {
      console.error('[upload-class-photo] storage upload failed:', upErr);
      return json({ error: 'upload_failed' }, 500);
    }

    // The row, as the caller, so the policy decides.
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      {
        global: { headers: { Authorization: req.headers.get('Authorization')! } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const { data: row, error: insErr } = await userClient
      .from('class_photos')
      .insert({
        program_id: programId,
        session_date: sessionDate,
        storage_path: path,
        uploaded_by_instructor_id: me.id,
      })
      .select('id')
      .single();

    if (insErr || !row) {
      // Nothing may be left behind by a refused upload.
      const { error: rmErr } = await admin.storage.from(BUCKET).remove([path]);
      if (rmErr) console.error('[upload-class-photo] cleanup failed, orphan object:', path, rmErr);
      const code = (insErr as { code?: string } | null)?.code;
      if (code === '42501') return json({ error: 'not_allowed_for_this_class' }, 403);
      if (code === '22007') return json({ error: 'class_day_not_happened' }, 400);
      console.error('[upload-class-photo] insert failed:', insErr);
      return json({ error: 'save_failed' }, 500);
    }

    return json({ ok: true, id: row.id, storage_path: path });
  } catch (e) {
    console.error('[upload-class-photo] unexpected:', e);
    return json({ error: 'internal_error' }, 500);
  }
});
