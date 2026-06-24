// admin-remove-member — remove a team member (deletes their org_members row,
// immediately revoking admin access on their next request). The auth.users
// account is left intact (they may also be an instructor or member elsewhere).
//
// Authz (server-side):
//   - Caller must be owner/admin (can_admin_org).
//   - Target must belong to the caller's org (multi-tenant guard).
//   - Only an owner may remove a member whose role is 'owner'.
//   - Last-owner lockout guard: the only owner cannot be removed.
//   - You cannot remove yourself (prevents accidental self-lockout).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { getCaller, resolveCallerOrg, roleMeetsTier } from '../_shared/assertRole.ts';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabase = adminClient();

    const callerResult = await getCaller(req, supabase);
    if ('error' in callerResult) return callerResult.error;
    const { authUserId } = callerResult.caller;

    let body: { member_id?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const memberId = body.member_id?.trim();
    if (!memberId) return json({ error: 'member_id_required' }, 400);

    const orgResult = await resolveCallerOrg(supabase, authUserId);
    if ('error' in orgResult) return orgResult.error;
    const { organizationId, role: callerRole } = orgResult;
    if (!roleMeetsTier(callerRole, 'admin')) return json({ error: 'forbidden' }, 403);

    const { data: target, error: tErr } = await supabase
      .from('org_members')
      .select('id, auth_user_id, organization_id, role')
      .eq('id', memberId)
      .maybeSingle();
    if (tErr) {
      console.error('target lookup failed:', tErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!target || target.organization_id !== organizationId) {
      return json({ error: 'member_not_found' }, 404);
    }
    if (target.auth_user_id === authUserId) {
      return json({ error: 'cannot_remove_self' }, 400);
    }

    // Owner-protection: removing an owner is owner-only.
    if (target.role === 'owner' && callerRole !== 'owner') {
      return json({ error: 'forbidden' }, 403);
    }

    // Last-owner guard: don't remove the only owner.
    if (target.role === 'owner') {
      const { count, error: cErr } = await supabase
        .from('org_members')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('role', 'owner')
        .not('accepted_at', 'is', null);
      if (cErr) {
        console.error('owner count failed:', cErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if ((count ?? 0) <= 1) return json({ error: 'last_owner' }, 409);
    }

    const { error: delErr } = await supabase
      .from('org_members')
      .delete()
      .eq('id', memberId);
    if (delErr) {
      console.error('member delete failed:', delErr);
      return json({ error: 'delete_failed' }, 500);
    }

    return json({ success: true, member_id: memberId });
  } catch (err) {
    console.error('admin-remove-member fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
