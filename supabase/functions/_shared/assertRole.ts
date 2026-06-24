// Shared server-side RBAC for edge functions.
//
// Edge functions run with the service-role key and BYPASS RLS, so they must
// check the caller's role themselves — never trust a role sent from the client.
// This module is the single authorized place to (a) verify the JWT and (b)
// assert the caller holds at least a given role tier in a given org.
//
// Tiers mirror the DB helper functions (org_role / can_edit_org / can_admin_org /
// can_handle_money / is_org_owner) so the three enforcement layers agree:
//   member -> owner/admin/staff/viewer  (read ops data)
//   edit   -> owner/admin/staff         (create/edit programs, rosters, sends)
//   money  -> owner/admin               (refunds, payroll, revenue)
//   admin  -> owner/admin               (settings, team, branding, Stripe)
//   owner  -> owner                     (transfer/delete org, mint owner)
//
// Decision (Jessica, 2026-06-24): money = Admin+ (Staff is money-blind). 'money'
// and 'admin' share the same role set today but are kept distinct so Staff money
// powers can be loosened later by editing one line.

import { json } from './instructor.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export type Tier = 'member' | 'edit' | 'money' | 'admin' | 'owner';

const TIER_ROLES: Record<Tier, readonly string[]> = {
  member: ['owner', 'admin', 'staff', 'viewer'],
  edit: ['owner', 'admin', 'staff'],
  money: ['owner', 'admin'],
  admin: ['owner', 'admin'],
  owner: ['owner'],
};

/** True if `role` (possibly null/unknown) satisfies `minTier`. Default-deny. */
export function roleMeetsTier(role: string | null | undefined, minTier: Tier): boolean {
  if (!role) return false;
  return TIER_ROLES[minTier].includes(role);
}

export interface Caller {
  authUserId: string;
  email: string | null;
}

/**
 * Verify the Authorization: Bearer <jwt> header. Returns the caller's auth id +
 * email, or an error Response (401) the function should return as-is.
 */
export async function getCaller(
  req: Request,
  supabase: SupabaseClient,
): Promise<{ caller: Caller } | { error: Response }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return { error: json({ error: 'auth_required' }, 401) };
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'auth_required' }, 401) };

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { error: json({ error: 'invalid_auth' }, 401) };
  return { caller: { authUserId: data.user.id, email: data.user.email ?? null } };
}

/**
 * Assert the caller holds at least `minTier` in `orgId`. Returns their role, or a
 * 403 Response. Reads only accepted memberships (accepted_at not null) so an
 * invited-but-unaccepted row grants nothing.
 */
export async function assertRole(
  supabase: SupabaseClient,
  authUserId: string,
  orgId: string,
  minTier: Tier,
): Promise<{ role: string } | { error: Response }> {
  const { data, error } = await supabase
    .from('org_members')
    .select('role')
    .eq('auth_user_id', authUserId)
    .eq('organization_id', orgId)
    .not('accepted_at', 'is', null)
    .maybeSingle();
  if (error) {
    console.error('assertRole lookup failed:', error);
    return { error: json({ error: 'lookup_failed' }, 500) };
  }
  const role = data?.role ?? null;
  if (!roleMeetsTier(role, minTier)) return { error: json({ error: 'forbidden' }, 403) };
  return { role: role as string };
}

/**
 * Resolve the caller's (single) org membership — for team-management endpoints
 * where the target org IS the caller's own. Returns their org id + role, or a
 * 403 Response if they are not an accepted member of any org.
 *
 * Single-org assumption matches AdminLayout + admin-invite today (one
 * org_members row per auth user). Revisit if a user can belong to multiple orgs.
 */
export async function resolveCallerOrg(
  supabase: SupabaseClient,
  authUserId: string,
): Promise<{ organizationId: string; role: string } | { error: Response }> {
  const { data, error } = await supabase
    .from('org_members')
    .select('organization_id, role')
    .eq('auth_user_id', authUserId)
    .not('accepted_at', 'is', null)
    .maybeSingle();
  if (error) {
    console.error('resolveCallerOrg lookup failed:', error);
    return { error: json({ error: 'lookup_failed' }, 500) };
  }
  if (!data) return { error: json({ error: 'forbidden' }, 403) };
  return { organizationId: data.organization_id, role: data.role };
}
