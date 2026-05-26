// get-instructor-curriculum-docs — instructor-facing read of curriculum_documents
// for a specific assignment they're confirmed on.
//
// Why this exists: RLS on curriculum_documents and the curriculum-documents
// Storage bucket only grants org_members (admins/owners). Instructors are in
// the `instructors` table — they cannot read either directly. This function
// uses service_role to fetch the docs server-side and generates short-lived
// signed URLs for any upload-source rows so the portal can render Download
// buttons without exposing the bucket to instructor JWTs.
//
// Gate: caller must be a confirmed instructor on an assignment whose
// camp_session.curriculum_id matches the requested curriculum_id. We do not
// trust the client-supplied curriculum_id alone — we re-derive ownership from
// camp_assignments. Without this gate any instructor could read any org's
// curriculum docs by guessing UUIDs.
//
// Auth: verify_jwt: true. Instructor must be active.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

interface GetDocsBody {
  curriculum_id?: string;
}

// Signed URL TTL: 1 hour. Long enough for an instructor to download a few
// files at a time; short enough that a leaked URL goes stale before serious
// harm. Matches the admin-side openDocLink in CurriculumReview.jsx.
const SIGNED_URL_TTL_SECONDS = 60 * 60;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: GetDocsBody;
    try {
      body = (await req.json()) as GetDocsBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const curriculumId = body.curriculum_id?.trim();
    if (!curriculumId) {
      return json({ error: 'curriculum_id_required' }, 400);
    }

    const supabase = adminClient();

    // Ownership check: instructor must be confirmed on at least one
    // camp_assignment whose camp_session.curriculum_id matches. We bounce
    // off camp_sessions because curriculum_id lives there, not on the
    // assignment row.
    const { data: own, error: ownErr } = await supabase
      .from('camp_assignments')
      .select('id, camp_sessions!inner(curriculum_id)')
      .eq('instructor_id', me.id)
      .eq('status', 'confirmed')
      .eq('camp_sessions.curriculum_id', curriculumId)
      .not('published_at', 'is', null)
      .limit(1);
    if (ownErr) {
      console.error('camp_assignments lookup error:', ownErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!own || own.length === 0) {
      // 403 not 404 — the curriculum may exist, but this caller has no
      // confirmed assignment that grants them access to it.
      return json({ error: 'not_assigned_to_curriculum' }, 403);
    }

    // Fetch the docs scoped to the instructor's org too — defense in depth,
    // even though curriculum_id was already validated via the join above.
    const { data: docs, error: docsErr } = await supabase
      .from('curriculum_documents')
      .select('id, doc_type, source_type, storage_path, drive_url, original_filename, mime_type, uploaded_at')
      .eq('curriculum_id', curriculumId)
      .eq('organization_id', me.organization_id)
      .order('doc_type', { ascending: true })
      .order('uploaded_at', { ascending: true });
    if (docsErr) {
      console.error('curriculum_documents lookup error:', docsErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Generate signed URLs for upload-source rows. drive_link rows pass
    // through their drive_url unchanged.
    const enriched = await Promise.all(
      (docs ?? []).map(async (d) => {
        if (d.source_type === 'upload' && d.storage_path) {
          // Omit the `download` option so Supabase returns the file with
          // Content-Disposition: inline (browser-default). PDFs render
          // in the browser's built-in viewer; non-renderable formats
          // (Word, Excel, etc.) still trigger a download because the
          // browser doesn't know how to display them. Either way, the
          // viewer's download button remains available to the user.
          const { data: signed, error: signErr } = await supabase.storage
            .from('curriculum-documents')
            .createSignedUrl(d.storage_path, SIGNED_URL_TTL_SECONDS);
          if (signErr || !signed?.signedUrl) {
            console.warn('createSignedUrl failed for', d.id, signErr);
            return { ...d, download_url: null };
          }
          return { ...d, download_url: signed.signedUrl };
        }
        return { ...d, download_url: d.drive_url ?? null };
      }),
    );

    return json({ documents: enriched });
  } catch (err) {
    console.error('get-instructor-curriculum-docs fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
