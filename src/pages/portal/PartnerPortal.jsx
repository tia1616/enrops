// /:slug/partner - the partner portal. A person at a partner (a parks
// department, a school) signs in with a magic link and sees the provider's
// documents that are shown to their partner, with whether each is current.
//
// Tenant-branded: it renders inside PublicLayout, so it speaks as the provider
// whose slug is in the address. What the person can SEE is decided by the
// database, not this page: partner_portal_memberships() links and returns their
// grants, and provider_documents RLS returns only the documents shown to them.
// A signed-in person with no grant from this provider sees a plain "no access"
// message, never another provider's or partner's records.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";
import { sendPartnerSignInLink, myPartnerMemberships } from "../../lib/partnerPortal.js";
import { listProviderDocuments, openDocumentInNewTab } from "../../lib/providerDocuments.js";
import { DOC_TYPES, formatDate } from "../../lib/providerDocumentLogic.js";

const SECTION_TITLES = { insurance: "Insurance", agreement: "Agreements", other: "Other documents" };

// Null when there is no expiry date: the badge already says "No expiry date".
function goodThrough(row) {
  if (!row.expires_on) return null;
  return row.expiry_status === "expired" ? `Expired ${formatDate(row.expires_on)}` : `Good through ${formatDate(row.expires_on)}`;
}

function SignInCard({ org }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!email || loading) return;
    setLoading(true); setError("");
    try {
      await sendPartnerSignInLink(org, email.trim());
      // Same wording whether or not the address has access: the function sends
      // only to partner contacts with access and stays silent otherwise, so this
      // page must not reveal which.
      setMsg(`If ${email.trim()} has partner access from ${org.name}, the sign-in link is on its way.`);
    } catch (err) {
      setError(err?.message || "Couldn't send a sign-in link. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
      <div className="rounded-3xl bg-white p-8 shadow-card sm:p-10">
        <h1 className="font-titan text-3xl text-j2s-ink">Partner sign-in</h1>
        <p className="mt-2 text-j2s-ink/70">
          See {org.name}'s insurance, agreements and other records, and whether each one is current.
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
          Use the email {org.name} has on file for you. If you don't get a link, ask {org.name} to give you partner access.
        </p>
      </div>
    </div>
  );
}

export default function PartnerPortal() {
  const { org } = useOutletContext();
  const { user, loading: authLoading, signOut } = useAuth();
  const userId = user?.id ?? null;

  const [memberships, setMemberships] = useState(null);
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState("");

  // Keyed on the user ID, not the user object: Supabase hands back a new user
  // object on every tab focus, which would re-run this and re-stamp sign-in.
  useEffect(() => {
    if (!userId || !org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const all = await myPartnerMemberships();
        const mine = all.filter((m) => m.organization_id === org.id);
        if (cancelled) return;
        setMemberships(mine);
        if (mine.length) {
          const d = await listProviderDocuments(org.id);
          if (!cancelled) setDocs(d);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Couldn't load your records: ${err?.message ?? "unknown error"}`);
          setMemberships((prev) => prev ?? []);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [userId, org?.id]);

  const sections = useMemo(() => {
    const byType = new Map(DOC_TYPES.map((t) => [t.key, []]));
    for (const d of docs ?? []) (byType.get(d.doc_type) ?? byType.get("other")).push(d);
    for (const list of byType.values()) {
      list.sort((a, b) => (a.expires_on || "9999-12-31").localeCompare(b.expires_on || "9999-12-31"));
    }
    return [...byType.entries()].filter(([, list]) => list.length);
  }, [docs]);

  if (!org) return null;
  if (authLoading) return <div className="py-24 text-center text-j2s-ink/60">Loading…</div>;
  if (!user) return <SignInCard org={org} />;
  if (memberships === null) return <div className="py-24 text-center text-j2s-ink/60">Loading your records…</div>;

  if (memberships.length === 0) {
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

  const partnerNames = memberships.map((m) => m.partner_name).join(", ");

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wide text-j2s-ink/50">{partnerNames}</div>
          <h1 className="mt-1 font-titan text-3xl text-j2s-ink">{org.name}'s records</h1>
          <p className="mt-2 max-w-xl text-j2s-ink/70">
            Everything {org.name} keeps on file for you, and the date each one is good through.
          </p>
        </div>
        <button type="button" onClick={() => signOut()} className="text-sm font-semibold text-j2s-purple hover:underline">
          Sign out
        </button>
      </div>

      {error && <p className="error-text mt-4">{error}</p>}

      {docs !== null && sections.length === 0 && (
        <div className="mt-8 rounded-2xl bg-white p-6 text-j2s-ink/70 shadow-card">
          {org.name} hasn't added any documents for you yet.
        </div>
      )}

      {sections.map(([type, list]) => (
        <section key={type} className="mt-8 rounded-2xl bg-white p-6 shadow-card">
          <h2 className="text-lg font-bold text-j2s-ink">{SECTION_TITLES[type] ?? "Documents"}</h2>
          <div className="mt-2 divide-y divide-j2s-ink/10">
            {list.map((d) => (
              <div key={d.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-j2s-ink">{d.title}</span>
                    <DocumentStatusBadge status={d.expiry_status} />
                  </div>
                  {goodThrough(d) && <div className="mt-1 text-sm text-j2s-ink/70">{goodThrough(d)}</div>}
                  {d.doc_type === "insurance" && (
                    <div className="mt-1 text-sm text-j2s-ink/70">
                      {[d.insurer, d.coverage_notes].filter(Boolean).join(" · ")}
                      {(d.insurer || d.coverage_notes) ? " · " : ""}
                      {d.abuse_coverage ? "Includes abuse and molestation coverage" : "Abuse and molestation coverage not listed"}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={async () => { const problem = await openDocumentInNewTab(d.storage_path); if (problem) setError(problem); }}
                  className="text-sm font-semibold text-j2s-purple hover:underline"
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
