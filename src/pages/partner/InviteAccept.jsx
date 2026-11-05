// /invite/:token - a provider answers a host's invitation (spec v3 P1).
// Header: "{Host name} asked to see your safety record." Shows the categories
// the host will see. Consent checkbox, never pre-checked: "Share my record's
// status with {Host name}. I can stop sharing at any time." Buttons "Share with
// {Host name}" and "Not now" (optional note to the host).
//
// Sharing needs an owner or admin of an enrops business, signed in. Someone
// new to enrops sets up a free account first (the existing signup) and comes
// back through the same link. The database decides everything
// (accept_/decline_partner_invitation, 20261105a); invites are off until
// platform_settings 'partner_invites' is enabled, and then this page shows
// nothing for an unknown, expired or answered link.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { supabase } from "../../lib/supabase";
import { acceptInvitation, declineInvitation, myAdminOrgs, previewInvitation } from "../../lib/partnerPortal.js";
import { REQUIREMENTS } from "../../lib/partnerPortalLogic.js";
import { PartnerShell } from "./partnerShared.jsx";

const LABEL = Object.fromEntries(REQUIREMENTS.map((r) => [r.key, r.label]));

export default function InviteAccept() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [inv, setInv] = useState(undefined); // undefined = loading, null = not open
  const [orgs, setOrgs] = useState(null);
  const [orgId, setOrgId] = useState("");
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState({ kind: "", text: "" });
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);

  useEffect(() => {
    let cancelled = false;
    previewInvitation(token).then((p) => { if (!cancelled) setInv(p); }).catch(() => { if (!cancelled) setInv(null); });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    if (user?.id) myAdminOrgs(user.id).then((o) => {
      if (cancelled) return;
      setOrgs(o);
      if (o.length === 1) setOrgId(o[0].id);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  async function run(fn) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setMsg({ kind: "", text: "" });
    try { await fn(); } catch (e) { setMsg({ kind: "err", text: e?.message || "That didn't go through. Try again." }); }
    finally { guard.current = false; setBusy(false); }
  }

  const share = () => run(async () => {
    if (!consent) throw new Error("Tick the box to share your record.");
    if (!orgId) throw new Error("Choose which business is sharing.");
    const partnerId = await acceptInvitation(token, orgId);
    navigate(`/admin/partner-documents/${partnerId}`);
  });

  const decline = () => run(async () => {
    const ok = await declineInvitation(token, note);
    if (!ok) throw new Error("This invitation is no longer open.");
    setDone("declined");
  });

  const sendLink = () => run(async () => {
    if (!email.trim()) throw new Error("Add your email.");
    const { data, error } = await supabase.functions.invoke("auth-send-magic-link", {
      body: { email: email.trim(), redirect_to: window.location.href, context: "admin" },
    });
    if (error || data?.error) throw new Error(data?.error || "Couldn't send a sign-in link. Try again.");
    // Only an existing enrops account gets a link; the sender says nothing
    // either way, so the page must not promise an email.
    setMsg({ kind: "ok", text: `If ${email.trim()} has an enrops account, a sign-in link is on its way and brings you back here. No account yet? Set one up below.` });
  });

  if (inv === undefined || authLoading) return <PartnerShell><p className="py-24 text-center text-j2s-ink/60">Loading…</p></PartnerShell>;
  if (done === "declined") {
    return <PartnerShell><p className="py-16 text-center text-j2s-ink/70">Thanks. We've let {inv?.host_name ?? "them"} know.</p></PartnerShell>;
  }
  if (!inv) {
    return (
      <PartnerShell>
        <div className="mx-auto max-w-md py-16 text-center text-j2s-ink/70">
          This invitation isn't open. It may have expired or already been answered. Ask the host to send a new one.
        </div>
      </PartnerShell>
    );
  }

  const host = inv.host_name;
  return (
    <PartnerShell>
      <div className="mx-auto max-w-lg">
        <div className="rounded-3xl bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-bold text-j2s-ink">{host} asked to see your safety record.</h1>
          <p className="mt-2 text-sm text-j2s-ink/70">They'll see the status of:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-j2s-ink/80">
            {(inv.categories ?? []).map((k) => <li key={k}>{LABEL[k] ?? k}</li>)}
          </ul>
          <p className="mt-2 text-xs text-j2s-ink/50">Status only. They never see a background report.</p>

          {!user ? (
            <div className="mt-6 space-y-3 border-t border-j2s-ink/10 pt-4">
              <p className="text-sm text-j2s-ink">Sign in to your enrops account to share.</p>
              <input type="email" className="input-field" placeholder="Your work email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button type="button" className="btn-j2s-primary w-full" disabled={busy} onClick={sendLink}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
              <p className="text-xs text-j2s-ink/60">
                New to enrops? <Link to="/signup" className="font-semibold text-j2s-purple hover:underline">Set up your free account</Link>, then open this invitation again from the email.
              </p>
            </div>
          ) : orgs !== null && orgs.length === 0 ? (
            <p className="mt-6 border-t border-j2s-ink/10 pt-4 text-sm text-j2s-ink/70">
              {user.email} isn't an owner or admin of a business on enrops yet. <Link to="/signup" className="font-semibold text-j2s-purple hover:underline">Set up your free account</Link>, then open this invitation again.
            </p>
          ) : (
            <div className="mt-6 space-y-3 border-t border-j2s-ink/10 pt-4">
              {orgs && orgs.length > 1 && (
                <label className="block text-sm text-j2s-ink">
                  <span className="font-semibold">Sharing as</span>
                  <select className="input-field mt-1" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                    <option value="" disabled>Choose your business</option>
                    {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              )}
              <label className="flex items-start gap-2 text-sm text-j2s-ink">
                <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>Share my record's status with {host}. I can stop sharing at any time.</span>
              </label>
              <button type="button" className="btn-j2s-primary w-full" disabled={busy || !consent} onClick={share}>{busy ? "Sharing…" : `Share with ${host}`}</button>
              {!declining ? (
                <button type="button" className="block w-full text-center text-sm font-semibold text-j2s-ink/60 hover:underline" onClick={() => setDeclining(true)}>Not now</button>
              ) : (
                <div className="space-y-2">
                  <textarea className="input-field" rows={2} maxLength={500} placeholder={`Optional note to ${host}`} value={note} onChange={(e) => setNote(e.target.value)} />
                  <button type="button" className="text-sm font-semibold text-j2s-purple hover:underline" disabled={busy} onClick={decline}>Send "Not now"</button>
                </div>
              )}
            </div>
          )}
          {msg.text && <p role={msg.kind === "err" ? "alert" : "status"} className={`mt-3 text-sm ${msg.kind === "err" ? "error-text" : "font-semibold text-emerald-800"}`}>{msg.text}</p>}
        </div>
      </div>
    </PartnerShell>
  );
}
