// /:slug/partner - the provider-branded way in to the partner portal.
//
// The records themselves now live on the neutral partner home (/partner and
// /partner/:partnerId, spec v3 H1/H2), because a partner works with many
// providers and needs one place for all of them. This page stays because links
// and bookmarks already point at it: signed out, it offers sign-in speaking as
// this provider; signed in, it forwards to this provider's record (or the
// partner home when this person is a partner of this provider more than once).
// A signed-in person with no grant from this provider is told so and sees
// nothing; authorization is the database (partner_portal_memberships), never
// the URL.

import { useEffect, useState } from "react";
import { Navigate, useOutletContext } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { myPartnerMemberships } from "../../lib/partnerPortal.js";
import { PartnerSignIn } from "../partner/partnerShared.jsx";

export default function PartnerPortal() {
  const { org } = useOutletContext();
  const { user, loading: authLoading, signOut } = useAuth();
  const userId = user?.id ?? null;
  const [mine, setMine] = useState(null);
  const [error, setError] = useState("");

  // Keyed on the user ID, not the user object (a new object on every tab focus).
  useEffect(() => {
    setMine(null);
    setError("");
    if (!userId || !org?.id) return;
    let cancelled = false;
    myPartnerMemberships()
      .then((all) => { if (!cancelled) setMine(all.filter((m) => m.organization_id === org.id)); })
      .catch((err) => { if (!cancelled) { setError(`Couldn't load your access: ${err?.message ?? "unknown error"}`); setMine([]); } });
    return () => { cancelled = true; };
  }, [userId, org?.id]);

  if (!org) return null;
  if (authLoading) return <div className="py-24 text-center text-j2s-ink/60">Loading…</div>;
  if (!user) return <div className="px-4"><PartnerSignIn org={org} /></div>;
  if (mine === null) return <div className="py-24 text-center text-j2s-ink/60">Loading…</div>;
  if (mine.length === 1) return <Navigate to={`/partner/${mine[0].partner_id}`} replace />;
  if (mine.length > 1) return <Navigate to="/partner" replace />;

  return (
    <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
      <div className="rounded-3xl bg-white p-8 shadow-card sm:p-10">
        <h1 className="font-titan text-2xl text-j2s-ink">No partner access</h1>
        <p className="mt-3 text-j2s-ink/70">
          {user.email} doesn't have partner access from {org.name}. If you work with {org.name}, ask them to give
          you access using this email address.
        </p>
        {error && <p className="error-text mt-3">{error}</p>}
        <button type="button" onClick={() => signOut()} className="mt-6 text-sm font-semibold text-j2s-purple hover:underline">
          Sign out and use a different email
        </button>
      </div>
    </div>
  );
}
