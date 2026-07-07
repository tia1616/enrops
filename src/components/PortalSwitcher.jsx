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

export default function PortalSwitcher({ current, slug = 'j2s', block = false }) {
  const roles = useUserRoles();
  if (!roles) return null;

  const dests = [];
  if (roles.isParent && current !== 'family') dests.push({ key: 'family', to: `/${slug}/dashboard` });
  if (roles.isInstructor && current !== 'instructor') dests.push({ key: 'instructor', to: `/${slug}/instructor` });
  // Admin is served at the canonical tenant-less /admin route.
  if (roles.isAdmin && current !== 'admin') dests.push({ key: 'admin', to: '/admin' });
  if (dests.length === 0) return null;

  // All three shells render on light backgrounds — indigo pill on light.
  const border = '#5847C9';
  const color = '#5847C9';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {dests.map((d) => (
        <Link
          key={d.key}
          to={d.to}
          title={`Switch to ${LABELS[d.key]}`}
          style={{
            display: block ? 'block' : 'inline-block',
            textAlign: block ? 'center' : undefined,
            padding: '5px 10px',
            border: `1px solid ${border}`,
            borderRadius: 6,
            color,
            fontSize: 12,
            fontWeight: 600,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {LABELS[d.key]} &rarr;
        </Link>
      ))}
    </div>
  );
}
