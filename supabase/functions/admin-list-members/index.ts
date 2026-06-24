// admin-list-members — list the team (org_members) for the caller's org.
//
// Caller must be owner/admin (can_admin_org tier) — team membership is workspace
// data, not visible to staff/viewer. The org is derived from the caller's own
// membership; admins can only see their own org's team.
//
// Returns one row per member: { id, email, role, accepted_at, invited_at, is_caller }.
// Email is read from org_members.email (populated at invite time), falling back to
// the auth.users email if blank.

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

    const orgResult = await resolveCallerOrg(supabase, authUserId);
    if ('error' in orgResult) return orgResult.error;
    const { organizationId, role: callerRole } = orgResult;

    // Team list is admin+ only.
    if (!roleMeetsTier(callerRole, 'admin')) return json({ error: 'forbidden' }, 403);

    const { data: rows, error: listErr } = await supabase
      .from('org_members')
      .select('id, auth_user_id, email, role, accepted_at, invited_at, created_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });
    if (listErr) {
      console.error('org_members list failed:', listErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Backfill any blank emails from auth.users (defensive — email should be set).
    const needsEmail = (rows ?? []).filter((r) => !r.email);
    let authEmailById = new Map<string, string>();
    if (needsEmail.length) {
      const { data: usersList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      authEmailById = new Map(
        (usersList?.users ?? []).map((u) => [u.id, u.email ?? '']),
      );
    }

    const members = (rows ?? []).map((r) => ({
      id: r.id,
      email: r.email || authEmailById.get(r.auth_user_id) || null,
      role: r.role,
      accepted_at: r.accepted_at,
      invited_at: r.invited_at,
      is_caller: r.auth_user_id === authUserId,
    }));

    return json({ members, caller_role: callerRole });
  } catch (err) {
    console.error('admin-list-members fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
