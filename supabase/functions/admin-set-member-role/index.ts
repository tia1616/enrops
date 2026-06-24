// admin-set-member-role — change an existing team member's role. No email sent
// (use admin-invite to (re)send a sign-in link).
//
// Authz (server-side; never trust a client role):
//   - Caller must be owner/admin (can_admin_org).
//   - Target must belong to the caller's org (multi-tenant guard).
//   - Only an owner may change a member whose current role is 'owner', OR set a
//     member's role TO 'owner' (minting/transferring ownership).
//   - Last-owner lockout guard: the only owner cannot be demoted.
//   - You cannot change your own role (prevents accidental self-lockout).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { getCaller, resolveCallerOrg, roleMeetsTier } from '../_shared/assertRole.ts';

const ALLOWED_ROLES = ['owner', 'admin', 'staff', 'viewer'];

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabase = adminClient();

    const callerResult = await getCaller(req, supabase);
    if ('error' in callerResult) return callerResult.error;
    const { authUserId } = callerResult.caller;

    let body: { member_id?: string; role?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const memberId = body.member_id?.trim();
    const newRole = (body.role ?? '').toLowerCase();
    if (!memberId) return json({ error: 'member_id_required' }, 400);
    if (!ALLOWED_ROLES.includes(newRole)) return json({ error: 'invalid_role' }, 400);

    const orgResult = await resolveCallerOrg(supabase, authUserId);
    if ('error' in orgResult) return orgResult.error;
    const { organizationId, role: callerRole } = orgResult;
    if (!roleMeetsTier(callerRole, 'admin')) return json({ error: 'forbidden' }, 403);

    // Load target, scoped to the caller's org.
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
      return json({ error: 'cannot_change_self' }, 400);
    }

    // Owner-protection: touching an owner row, or minting an owner, is owner-only.
    if ((target.role === 'owner' || newRole === 'owner') && callerRole !== 'owner') {
      return json({ error: 'forbidden' }, 403);
    }

    // Last-owner guard: don't demote the only owner.
    if (target.role === 'owner' && newRole !== 'owner') {
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

    if (target.role === newRole) {
      return json({ success: true, member_id: memberId, role: newRole, unchanged: true });
    }

    const { error: updErr } = await supabase
      .from('org_members')
      .update({ role: newRole })
      .eq('id', memberId);
    if (updErr) {
      console.error('role update failed:', updErr);
      return json({ error: 'update_failed' }, 500);
    }

    return json({ success: true, member_id: memberId, role: newRole });
  } catch (err) {
    console.error('admin-set-member-role fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
