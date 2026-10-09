// upload-class-photo - an instructor files one photo against a class day.
//
// Flow: authenticate the instructor -> check the provider has class photos on
// -> stamp the enrops watermark -> store the marked JPEG in the private
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
      .select('class_photos_enabled')
      .eq('id', program.organization_id)
      .maybeSingle();
    if (oErr) {
      console.error('[upload-class-photo] org lookup failed:', oErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!org?.class_photos_enabled) return json({ error: 'class_photos_off' }, 403);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isJpeg(bytes)) return json({ error: 'not_a_jpeg' }, 415);

    let marked: Uint8Array;
    try {
      marked = await watermarkJpeg(bytes);
    } catch (e) {
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
