// PortalSwitcher — a compact cross-link to the OTHER surfaces the signed-in
// user can reach (family dashboard / instructor portal / admin).
//
// Best-practice multi-role navigation: single-role users never see it (nothing
// to switch to); anyone with 2+ roles gets a persistent way to jump between
// their portals from any header. Roles come from useUserRoles (one source of
// truth). Renders nothing until roles resolve.
//
// Placement: dropped into the family header (PublicLayout), the instructor
// portal Shell header, and the admin sidebar. Inline styles so it looks at
// home in all three (Tailwind + inline-styled) shells.

import React from 'react';
import { Link } from 'react-router-dom';
import { useUserRoles } from '../lib/useUserRoles.js';

const LABELS = { family: 'Family', instructor: 'Instructor', admin: 'Admin' };

// orgId (optional): the org whose page we're rendering on. When supplied, the
// Admin chip is shown ONLY if the user administers THAT org — a switcher is for
// swapping ROLES within the provider you're looking at, never for jumping to a
// different provider's admin. Without it the chip appeared on every tenant's
// public page and linked to the viewer's own org, which reads as a broken link.
// Callers that omit orgId (instructor Shell, admin sidebar) keep prior behavior.
export default function PortalSwitcher({ current, slug = 'j2s', block = false, label, orgId }) {
  const roles = useUserRoles();
  if (!roles) return null;

  const dests = [];
  if (roles.isParent && current !== 'family') dests.push({ key: 'family', to: `/${slug}/dashboard` });
  if (roles.isInstructor && current !== 'instructor') dests.push({ key: 'instructor', to: `/${slug}/instructor` });
  // Admin is served at the canonical tenant-less /admin route.
  const adminsThisOrg = orgId ? roles.adminOrgId === orgId : true;
  if (roles.isAdmin && adminsThisOrg && current !== 'admin') dests.push({ key: 'admin', to: '/admin' });
  if (dests.length === 0) return null;

  // Filled indigo chips so the control reads as an obvious, clickable
  // "switch to this portal" — not a faint afterthought.
  const chip = {
    display: block ? 'block' : 'inline-block',
    textAlign: block ? 'center' : undefined,
    padding: '6px 12px',
    borderRadius: 6,
    background: '#5847C9',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={{ display: 'flex', flexDirection: block ? 'column' : 'row', alignItems: block ? 'stretch' : 'center', gap: 6, flexWrap: 'wrap' }}>
      {label && (
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b6b6b' }}>
          {label}
        </span>
      )}
      {dests.map((d) => (
        <Link key={d.key} to={d.to} title={`Switch to ${LABELS[d.key]}`} style={chip}>
          {LABELS[d.key]} &rarr;
        </Link>
      ))}
    </div>
  );
}
