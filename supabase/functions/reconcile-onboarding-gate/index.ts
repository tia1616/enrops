// reconcile-onboarding-gate — re-run the onboarding gate for every contractor in
// an org after its background-check configuration changes.
//
// WHY: BackgroundCheckSettings saves organizations.background_check_config
// directly. runGateCheck (the function that decides overall_status) reads that
// flag, but it only fires from update-onboarding-step / the Checkr and Stripe
// webhooks / refresh-stripe-status — never from the settings save. So a contractor
// stuck in 'pending_background_check' stayed stuck after an admin turned background
// checks OFF, until some unrelated webhook happened to re-run the gate. This
// endpoint closes that gap: the admin UI calls it after saving the config, and it
// re-runs the gate for each of the org's contractors so the flip takes effect
// immediately. (Three-day code audit P2.)
//
// The gate reads the org's CURRENT config each time and only writes when the
// derived status actually changes, so this is idempotent and safe to call on
// every enabled-flag save (it advances the newly-unblocked contractors and leaves
// everyone else untouched). Also reused by the training toggle (TrainingSettings),
// which changes the same gate via organizations.training_config.
//
// Auth: caller must be owner/admin on the target org (org_members, accepted).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';

interface Body {
  organization_id?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // ── auth: verify caller JWT ───────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // ── input ─────────────────────────────────────────────────────────────
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const orgId = body.organization_id?.trim();
    if (!orgId) return json({ error: 'organization_id_required' }, 400);

    // ── auth scope: caller is owner/admin on THIS org ─────────────────────
    const { data: cm } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!cm) return json({ error: 'forbidden' }, 403);

    // ── reconcile ─────────────────────────────────────────────────────────
    const { data: rows, error: rowsErr } = await supabase
      .from('contractor_onboarding_status')
      .select('instructor_id, overall_status')
      .eq('organization_id', orgId);
    if (rowsErr) {
      console.error('[reconcile-onboarding-gate] onboarding lookup failed:', rowsErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    let checked = 0;
    let changed = 0;
    for (const row of rows ?? []) {
      const before = row.overall_status as string | null;
      const result = await runGateCheck(supabase, row.instructor_id as string);
      checked++;
      if (result && result.overall_status !== before) changed++;
    }

    return json({ success: true, checked, changed });
  } catch (err) {
    console.error('[reconcile-onboarding-gate] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
