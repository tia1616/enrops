// One source of truth for "which portals can the signed-in user reach".
//
// Used by:
//   - PortalSwitcher (renders cross-links between the surfaces a user holds)
//   - the family dashboard's no-parent redirect (routes non-parents home)
//
// isAdmin mirrors AdminLayout's gate: an org_members row that has been
// ACCEPTED (accepted_at set). A pending invite does not grant admin access,
// so we must not treat it as an admin destination.

import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';

export async function getUserRoles(userId) {
  if (!userId) return { isParent: false, isInstructor: false, isAdmin: false };
  // `.limit(1).maybeSingle()` (not a bare `.maybeSingle()`) so a person who
  // belongs to 2+ orgs or teaches for 2+ providers on one email doesn't throw
  // on "multiple rows" — we only need to know a qualifying row EXISTS. The
  // org_members query pre-filters to accepted memberships (admin's gate).
  const [{ data: p }, { data: i }, { data: m }] = await Promise.all([
    supabase.from('parents').select('id').eq('auth_id', userId).limit(1).maybeSingle(),
    supabase.from('instructors').select('id').eq('auth_user_id', userId).eq('is_active', true).limit(1).maybeSingle(),
    supabase.from('org_members').select('id').eq('auth_user_id', userId).not('accepted_at', 'is', null).limit(1).maybeSingle(),
  ]);
  return {
    isParent: !!p,
    isInstructor: !!i,
    isAdmin: !!m,
  };
}

// Hook form for components. Returns null while loading, then a roles object.
export function useUserRoles() {
  const [roles, setRoles] = useState(null);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const r = await getUserRoles(session?.user?.id);
        if (mounted) setRoles(r);
      } catch {
        // On any failure, degrade quietly: report no roles so the switcher
        // simply hides rather than surfacing an error in a header.
        if (mounted) setRoles({ isParent: false, isInstructor: false, isAdmin: false });
      }
    })();
    return () => { mounted = false; };
  }, []);
  return roles;
}
