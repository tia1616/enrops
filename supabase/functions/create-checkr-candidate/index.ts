// create-checkr-candidate — Screen 2 of the contractor onboarding wizard.
//
// Calls Checkr's REST API to create a candidate + invitation, stores the IDs
// on contractor_onboarding_status, returns the invitation URL for the wizard
// to open in a new tab.
//
// Env vars required:
//   CHECKR_API_KEY         — Checkr secret key (also used as webhook HMAC secret)
//   CHECKR_API_BASE_URL    — https://api.checkr.com (prod) or https://api.checkr-staging.com
//   CHECKR_PACKAGE_SLUG    — e.g. 'gusto_standard' (J2S's standard package)
//
// Idempotency: if checkr_candidate_id already exists on the onboarding row,
// returns 409 with the current state — the wizard's "already submitted" UI
// path handles this. (Wizard normally avoids the call if a candidate exists,
// per chunk 3 Screen 2 spec, but defensive check here too.)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    const apiKey = Deno.env.get('CHECKR_API_KEY');
    const baseUrl = Deno.env.get('CHECKR_API_BASE_URL');
    const packageSlug = Deno.env.get('CHECKR_PACKAGE_SLUG');

    if (!apiKey || !baseUrl || !packageSlug) {
      console.error('Checkr env vars missing', {
        has_api_key: !!apiKey,
        has_base_url: !!baseUrl,
        has_package_slug: !!packageSlug,
      });
      return json({ error: 'checkr_not_configured' }, 500);
    }

    if (!me.first_name || !me.last_name) {
      return json({ error: 'instructor_missing_name' }, 400);
    }
    if (!me.email) {
      return json({ error: 'instructor_missing_email' }, 400);
    }

    const supabase = adminClient();

    // Defensive idempotency: if candidate already exists, don't recreate.
    const { data: existingOnb, error: onbErr } = await supabase
      .from('contractor_onboarding_status')
      .select('checkr_candidate_id, checkr_invitation_id, checkr_status')
      .eq('instructor_id', me.id)
      .maybeSingle();

    if (onbErr) {
      console.error('onboarding lookup failed:', onbErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    if (existingOnb?.checkr_candidate_id) {
      return json(
        {
          error: 'already_submitted',
          checkr_status: existingOnb.checkr_status,
        },
        409,
      );
    }

    // Checkr uses HTTP Basic auth: API key as username, empty password.
    const basicAuth = btoa(`${apiKey}:`);
    const authHeader = `Basic ${basicAuth}`;

    // Step 1: create the candidate.
    const candidateResp = await fetch(`${baseUrl}/v1/candidates`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        first_name: me.first_name,
        last_name: me.last_name,
        email: me.email,
      }),
    });

    if (!candidateResp.ok) {
      const errText = await candidateResp.text();
      console.error('Checkr candidate create failed:', candidateResp.status, errText);
      return json({ error: 'checkr_candidate_create_failed', status: candidateResp.status }, 502);
    }

    const candidate = (await candidateResp.json()) as { id?: string };
    const candidateId = candidate.id;
    if (!candidateId) {
      console.error('Checkr returned no candidate id:', candidate);
      return json({ error: 'checkr_invalid_response' }, 502);
    }

    // Step 2: create the invitation.
    const invitationResp = await fetch(`${baseUrl}/v1/invitations`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        candidate_id: candidateId,
        package: packageSlug,
      }),
    });

    if (!invitationResp.ok) {
      const errText = await invitationResp.text();
      console.error('Checkr invitation create failed:', invitationResp.status, errText);
      // Candidate was created but invitation failed — store the candidate_id
      // anyway so a retry doesn't create a duplicate candidate.
      await supabase
        .from('contractor_onboarding_status')
        .update({
          checkr_candidate_id: candidateId,
          checkr_status: 'not_started',
          updated_at: new Date().toISOString(),
        })
        .eq('instructor_id', me.id);
      return json({ error: 'checkr_invitation_create_failed', status: invitationResp.status }, 502);
    }

    const invitation = (await invitationResp.json()) as {
      id?: string;
      invitation_url?: string;
    };
    if (!invitation.id || !invitation.invitation_url) {
      console.error('Checkr returned incomplete invitation:', invitation);
      return json({ error: 'checkr_invalid_response' }, 502);
    }

    // Store both IDs + bump checkr_status to 'pending'.
    if (existingOnb) {
      const { error: updErr } = await supabase
        .from('contractor_onboarding_status')
        .update({
          checkr_candidate_id: candidateId,
          checkr_invitation_id: invitation.id,
          checkr_status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('instructor_id', me.id);
      if (updErr) {
        console.error('onboarding update failed:', updErr);
        return json({ error: 'onboarding_update_failed' }, 500);
      }
    } else {
      // No onboarding row — Function 1 should have created it. Insert minimally.
      const { error: insErr } = await supabase
        .from('contractor_onboarding_status')
        .insert({
          instructor_id: me.id,
          organization_id: me.organization_id,
          checkr_candidate_id: candidateId,
          checkr_invitation_id: invitation.id,
          checkr_status: 'pending',
          overall_status: 'in_progress',
        });
      if (insErr) {
        console.error('onboarding insert failed:', insErr);
        return json({ error: 'onboarding_insert_failed' }, 500);
      }
    }

    return json({
      success: true,
      invitation_url: invitation.invitation_url,
      candidate_id: candidateId,
    });
  } catch (err) {
    console.error('create-checkr-candidate fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
