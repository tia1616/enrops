// Shared pieces of the neutral partner pages (/partner and /partner/:partnerId).
//
// NEUTRAL, NOT PROVIDER-BRANDED. A partner (a parks department, a school) works
// with many providers, so its home cannot wear one provider's colours. The
// pages sit in the enrops public palette (.brand-enrops-public) and each
// provider is named inside them. Spec v3, H1/H2.
//
// Authorization is the database: partner_portal_memberships() returns only this
// person's grants, provider_documents RLS only the documents shown to their
// partner, and partner_portal_instructors() only that partner's instructors.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { myPartnerMemberships, sendPartnerSignInLink } from "../../lib/partnerPortal.js";
import FeedbackWidget from "../../components/feedback/FeedbackWidget.jsx";

/** Today as YYYY-MM-DD in the viewer's time zone (dates a chip with nothing behind it). */
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function PartnerShell({ children, onSignOut, feedbackOrg }) {
  return (
    <div className="brand-enrops-public min-h-screen bg-[#FBFBFB] font-poppins text-j2s-ink">
      <header className="border-b border-j2s-ink/10 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link to="/partner" className="text-lg font-bold tracking-tight text-j2s-purple">enrops</Link>
          {onSignOut && (
            <button type="button" onClick={onSignOut} className="text-sm font-semibold text-j2s-purple hover:underline">
              Sign out
            </button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {children}
        <HostFooter />
        {feedbackOrg && <FeedbackWidget org={feedbackOrg} variant="inline" />}
      </main>
    </div>
  );
}

// Spec v3: on every host page. Counsel to confirm the wording after Oct 23.
export function HostFooter() {
  return (
    <p className="mt-10 text-xs text-j2s-ink/50">
      Status shown with each provider's consent. enrops displays verification status from the provider's screening
      partner; it does not run or certify checks.
    </p>
  );
}

/**
 * The signed-in person's partner grants, across every provider. null while
 * loading. Keyed on the user ID, not the user object: Supabase hands back a new
 * user object on every tab focus, which would re-run this and re-stamp sign-in.
 */
export function useMemberships() {
  const { user, loading: authLoading, signOut } = useAuth();
  const userId = user?.id ?? null;
  const [memberships, setMemberships] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setMemberships(null);
    setError("");
    if (!userId) return;
    let cancelled = false;
    myPartnerMemberships()
      .then((m) => { if (!cancelled) setMemberships(m); })
      .catch((err) => {
        if (!cancelled) { setError(`Couldn't load your providers: ${err?.message ?? "unknown error"}`); setMemberships([]); }
      });
    return () => { cancelled = true; };
  }, [userId]);
  return { user, authLoading, signOut, memberships, error };
}

/**
 * Email a sign-in link. `org` names the provider when signing in from that
 * provider's page; null signs in to the partner home, where any provider's
 * grant counts. The message never says whether the address has access.
 */
export function PartnerSignIn({ org = null }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!email || loading) return;
    setLoading(true); setError(""); setMsg("");
    try {
      await sendPartnerSignInLink(org, email.trim());
      setMsg(`If ${email.trim()} has partner access${org ? ` from ${org.name}` : ""}, the sign-in link is on its way.`);
    } catch (err) {
      setError(err?.message || "Couldn't send a sign-in link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md py-10">
      <div className="rounded-3xl bg-white p-8 shadow-card sm:p-10">
        <h1 className="text-2xl font-bold text-j2s-ink">Partner sign-in</h1>
        <p className="mt-2 text-j2s-ink/70">
          {org
            ? `See ${org.name}'s safety record: insurance, agreements and the status of its instructors.`
            : "See your providers' safety record: insurance, agreements and the status of their instructors."}
        </p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <input type="email" className="input-field" placeholder="Your work email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" disabled={loading || !email} className="btn-j2s-primary w-full">
            {loading ? "Sending…" : "Email me a sign-in link"}
          </button>
          {msg && <p className="rounded-lg bg-j2s-purple-soft p-3 text-sm">{msg}</p>}
          {error && <p className="error-text">{error}</p>}
        </form>
        <p className="mt-6 text-sm text-j2s-ink/60">
          Use the email your provider has on file for you. No link? Ask them to give you partner access.
        </p>
      </div>
    </div>
  );
}

export function NoAccess({ email, onSignOut }) {
  return (
    <div className="mx-auto max-w-md py-10">
      <div className="rounded-3xl bg-white p-8 shadow-card sm:p-10">
        <h1 className="text-2xl font-bold text-j2s-ink">No partner access</h1>
        <p className="mt-3 text-j2s-ink/70">
          {email} doesn't have partner access from any provider yet. Ask the provider you work with to give you access
          using this email address.
        </p>
        <button type="button" onClick={onSignOut} className="mt-6 text-sm font-semibold text-j2s-purple hover:underline">
          Sign out and use a different email
        </button>
      </div>
    </div>
  );
}
