// admin-upload-background-check — admin-only endpoint that marks an instructor
// as background-check-cleared using a prior-year report PDF, bypassing Checkr.
//
// Feature A from the 2026-05-22 chunk 3 scope additions. Most current J2S
// instructors already have valid checks on file; re-running them through
// Checkr costs $ per report.
//
// Auth model mirrors contractor-invite: JWT must belong to a caller whose
// org_members row has role IN ('owner', 'admin') AND organization_id matches
// the target instructor's org. Anti-enumeration: missing instructor + non-
// admin caller return the same 403.
//
// Side effects when authorized:
//   - contractor_onboarding_status:
//       background_check_source       = 'admin_uploaded'
//       background_check_file_url     = body.file_url (storage path)
//       background_check_uploaded_by  = caller auth.uid
//       background_check_completed_on = body.completed_on (date of original check)
//       checkr_status                 = 'clear'
//       checkr_completed_at           = now()
//       steps_completed.checkr_submitted = { admin_uploaded_by, completed_at, ip_address }
//   - gate check (may flip overall_status to pending_stripe / complete /
//     pending_background_check depending on other steps)
//
// Body: { instructor_id, file_url, completed_on }  (completed_on = YYYY-MM-DD)
//
// NOT YET DEPLOYED. Deploy via `npx --yes supabase functions deploy
// admin-upload-background-check --project-ref iuasfpztkmrtagivlhtj` after
// Jessica's go-ahead.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient, clientIp } from '../_shared/instructor.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';

interface RequestBody {
  instructor_id?: string;
  file_url?: string;
  completed_on?: string;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // 1. Auth header → JWT → caller's auth.uid()
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // 2. Body parse + light validation
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const instructorId = body.instructor_id?.trim();
    const fileUrl = body.file_url?.trim();
    const completedOn = body.completed_on?.trim();
    if (!instructorId) return json({ error: 'instructor_id_required' }, 400);
    if (!fileUrl) return json({ error: 'file_url_required' }, 400);
    if (!completedOn) return json({ error: 'completed_on_required' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(completedOn)) {
      return json({ error: 'completed_on_must_be_yyyy_mm_dd' }, 400);
    }

    // 3. Look up the target instructor (don't 404 yet — combine with not-
    //    authorized below for anti-enumeration).
    const { data: instructorRow, error: instErr } = await supabase
      .from('instructors')
      .select('id, organization_id')
      .eq('id', instructorId)
      .maybeSingle();
    if (instErr) {
      console.error('instructor lookup failed:', instErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!instructorRow) return FORBIDDEN;

    // 4. Authorize the caller. Must be owner/admin in the instructor's org.
    const { data: orgMemberRow, error: omErr } = await supabase
      .from('org_members')
      .select('organization_id')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', instructorRow.organization_id)
      .in('role', ['owner', 'admin'])
      .maybeSingle();
    if (omErr) {
      console.error('org_members lookup failed:', omErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!orgMemberRow) return FORBIDDEN;

    // 5. Fetch existing onboarding row to merge steps_completed; create if missing.
    const ip = clientIp(req);
    const checkrCompletedAt = new Date().toISOString();
    const stepEntry = {
      completed_at: checkrCompletedAt,
      ip_address: ip,
      admin_uploaded_by: callerAuthId,
    };

    const { data: existing, error: fetchErr } = await supabase
      .from('contractor_onboarding_status')
      .select('steps_completed, overall_status, current_step')
      .eq('instructor_id', instructorId)
      .maybeSingle();
    if (fetchErr) {
      console.error('onboarding fetch failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    const mergedSteps = {
      ...((existing?.steps_completed as Record<string, unknown>) ?? {}),
      checkr_submitted: stepEntry,
    };

    // current_step advances to at least 3 (just past Background Check) but
    // never regresses if the contractor is already further along.
    const newCurrent = Math.max(3, existing?.current_step ?? 1);

    // overall_status: admin uploading a prior BGC is NOT contractor progress.
    // If the contractor hasn't been invited yet, leave them at 'not_invited'.
    // If they've been invited but not started, leave them at 'invited'.
    // Only promote to 'in_progress' from 'invited' if the contractor themselves
    // has done something else (other steps_completed entries) — but they can't
    // have, since contractor-side steps go through update-onboarding-step.
    // So: keep the existing status unchanged; only initialize to 'not_invited'
    // when creating the row from scratch (admin BGC before any contractor-invite).
    const nextOverall = existing?.overall_status ?? 'not_invited';

    const updates = {
      steps_completed: mergedSteps,
      current_step: newCurrent,
      overall_status: nextOverall,
      background_check_source: 'admin_uploaded',
      background_check_file_url: fileUrl,
      background_check_uploaded_by: callerAuthId,
      background_check_completed_on: completedOn,
      checkr_status: 'clear',
      checkr_completed_at: checkrCompletedAt,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error: updErr } = await supabase
        .from('contractor_onboarding_status')
        .update(updates)
        .eq('instructor_id', instructorId);
      if (updErr) {
        console.error('onboarding update failed:', updErr);
        return json({ error: 'update_failed' }, 500);
      }
    } else {
      const { error: insErr } = await supabase
        .from('contractor_onboarding_status')
        .insert({
          ...updates,
          instructor_id: instructorId,
          organization_id: instructorRow.organization_id,
        });
      if (insErr) {
        console.error('onboarding insert failed:', insErr);
        return json({ error: 'insert_failed' }, 500);
      }
    }

    // 6. Gate check — may flip overall_status to pending_stripe / complete /
    //    pending_background_check (it'll see checkr_clear=true now).
    const gate = await runGateCheck(supabase, instructorId);

    return json({ success: true, gate });
  } catch (err) {
    console.error('admin-upload-background-check fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
