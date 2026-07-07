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
  const [{ data: p }, { data: i }, { data: m }] = await Promise.all([
    supabase.from('parents').select('id').eq('auth_id', userId).maybeSingle(),
    supabase.from('instructors').select('id').eq('auth_user_id', userId).eq('is_active', true).maybeSingle(),
    supabase.from('org_members').select('accepted_at').eq('auth_user_id', userId).maybeSingle(),
  ]);
  return {
    isParent: !!p,
    isInstructor: !!i,
    isAdmin: !!(m && m.accepted_at),
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
