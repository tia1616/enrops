// "Partner logins" on /admin/partner-documents: who at each partner can sign in
// to the partner portal and see the documents shown to that partner.
//
// Access is granted to an existing partner CONTACT, so a person's name and
// email live only on the contact (Locations). Owners and admins grant and
// remove (partner_portal_access RLS: can_admin_org). "Send sign-in link"
// EMAILS A REAL PERSON, so it always asks first.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  listPortalAccess, listGrantableContacts, grantPortalAccess, removePortalAccess,
  sendPartnerSignInLink, partnerPortalUrl,
} from "../../lib/partnerPortal.js";
import { accessStatus, contactsWithoutAccess } from "../../lib/partnerPortalLogic.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const BRIGHT = "#5847C9";

const TONE = {
  good: { bg: "#f0fdf4", ink: "#166534", border: "#bbf7d0" },
  warn: { bg: "#fffbeb", ink: "#92400e", border: "#fde68a" },
  neutral: { bg: "#f5f5f4", ink: "#57534e", border: "#e7e5e4" },
};

const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
const linkBtn = { background: "none", border: "none", padding: 0, color: BRIGHT, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };

function primaryBtn(disabled) {
  return { padding: "9px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap" };
}

export default function PartnerLoginsSection({ org, partners, canManage, onMessage }) {
  const [grants, setGrants] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [partnerId, setPartnerId] = useState("");
  const [contactId, setContactId] = useState("");
  const [busy, setBusy] = useState(null); // grant id, or "grant"
  const [error, setError] = useState("");

  async function load() {
    try {
      const [g, c] = await Promise.all([listPortalAccess(org.id), listGrantableContacts(org.id)]);
      setGrants(g);
      setContacts(c);
      setError("");
    } catch (err) {
      setError(`Couldn't load partner logins: ${err?.message ?? "unknown error"}`);
      setGrants((prev) => prev ?? []);
    }
  }

  useEffect(() => { if (org?.id) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [org?.id]);

  const available = useMemo(() => contactsWithoutAccess(contacts, grants), [contacts, grants]);
  const partnersWithContacts = useMemo(() => {
    const ids = new Set(available.map((c) => c.partner_id));
    return partners.filter((p) => !p.inactive && ids.has(p.id));
  }, [partners, available]);
  const contactsForPartner = available.filter((c) => c.partner_id === partnerId);

  async function grant() {
    if (!contactId || busy) return;
    setBusy("grant"); setError("");
    try {
      await grantPortalAccess(org.id, contactId);
      setContactId("");
      onMessage("Access given. Send them a sign-in link when you're ready.");
      await load();
    } catch (err) {
      setError(`Couldn't give access: ${err?.message ?? "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function send(row) {
    const email = (row.contact?.contact_email || "").trim();
    if (!email) {
      setError(`${row.contact?.contact_name || "This contact"} has no email address. Add one in Locations, then give them access again.`);
      return;
    }
    if (!window.confirm(`Email a sign-in link to ${row.contact?.contact_name || email} (${email})? They'll see the documents shown to ${row.partner?.partner_name || "their partner"}.`)) return;
    setBusy(row.id); setError("");
    try {
      // The function tells an owner/admin what really happened; say exactly that.
      const outcome = await sendPartnerSignInLink(org, email);
      if (outcome === "sent") onMessage(`Sign-in link sent to ${email}.`);
      else if (outcome === "suppressed_on_staging") setError(`Not sent: this is the staging site, which only emails test inboxes.`);
      else if (outcome === "no_access") setError(`Not sent: ${email} no longer has access. Refresh the page and check their partner and email.`);
      else setError("Couldn't confirm the link was sent. Refresh the page to check.");
      await load();
    } catch (err) {
      setError(`Couldn't send the link: ${err?.message ?? "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function remove(row) {
    if (!window.confirm(`Remove ${row.contact?.contact_name || "this person"}'s access? They won't be able to see your documents any more.`)) return;
    setBusy(row.id); setError("");
    try {
      await removePortalAccess(row.id);
      onMessage("Access removed.");
      await load();
    } catch (err) {
      setError(`Couldn't remove access: ${err?.message ?? "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: INK }}>Partner logins</h2>
      <p style={{ margin: "0 0 12px", fontSize: 13.5, color: MUTED, lineHeight: 1.5, maxWidth: 600 }}>
        People at a partner who can sign in at <span style={{ color: INK, fontWeight: 600 }}>{org?.slug ? partnerPortalUrl(org).replace(/^https?:\/\//, "") : "your partner page"}</span> and
        see the documents shown to their partner. They can't see anything else.
      </p>

      {error && <div style={{ marginBottom: 12, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}

      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "6px 20px" }}>
        {grants === null ? (
          <div style={{ padding: "14px 0", color: MUTED, fontSize: 13 }}>Loading…</div>
        ) : grants.length === 0 ? (
          <div style={{ padding: "14px 0", color: MUTED, fontSize: 13 }}>No one has partner access yet.</div>
        ) : (
          grants.map((g, i) => {
            const st = accessStatus(g);
            const t = TONE[st.tone];
            // From the grant's own partner row, loaded with it, so this never
            // flashes "archived" while the page's partner list is still loading.
            const archived = g.partner?.inactive === true;
            return (
              <div key={g.id} style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "flex-start", padding: "14px 0", borderTop: i === 0 ? "none" : `1px solid ${RULE}`, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: INK }}>{g.contact?.contact_name || g.contact?.contact_email}</div>
                  <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
                    {g.partner?.partner_name ?? "A partner"} · {g.contact?.contact_email}
                  </div>
                  <span style={{ display: "inline-block", marginTop: 6, padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: t.bg, color: t.ink, border: `1px solid ${t.border}` }}>{st.label}</span>
                  {archived && <div style={{ fontSize: 12.5, color: "#92400e", marginTop: 6 }}>This partner is archived, so this person can't see anything until it's active again.</div>}
                </div>
                {canManage && (
                  <div style={{ display: "flex", gap: 14, alignItems: "center", paddingTop: 2 }}>
                    <button type="button" style={linkBtn} disabled={!!busy || archived} onClick={() => send(g)}>
                      {busy === g.id ? "Sending…" : "Send sign-in link"}
                    </button>
                    <button type="button" style={{ ...linkBtn, color: "#a13a3a" }} disabled={!!busy} onClick={() => remove(g)}>Remove</button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {canManage && (
        <div style={{ marginTop: 14, background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 10 }}>Give someone access</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 200px" }}>
              <select value={partnerId} onChange={(e) => { setPartnerId(e.target.value); setContactId(""); }} style={input}>
                <option value="">Choose a partner</option>
                {partnersWithContacts.map((p) => <option key={p.id} value={p.id}>{p.partner_name}</option>)}
              </select>
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={input} disabled={!partnerId}>
                <option value="">Choose a person</option>
                {contactsForPartner.map((c) => <option key={c.id} value={c.id}>{c.contact_name ? `${c.contact_name} (${c.contact_email})` : c.contact_email}</option>)}
              </select>
            </div>
            <button type="button" onClick={grant} disabled={!contactId || !!busy} style={primaryBtn(!contactId || !!busy)}>
              {busy === "grant" ? "Saving…" : "Give access"}
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>
            Don't see the person? Add them as a contact on that partner in <Link to="/admin/schools" style={{ color: BRIGHT }}>Locations</Link>, with their email, then come back.
            Giving access doesn't email anyone; use Send sign-in link when you're ready. If someone's email or partner is
            changed later, their access is removed and you give it again here.
          </div>
        </div>
      )}
    </section>
  );
}
