// Spec v3 H4 "Invite providers", on the partner home. Business name, one or
// more emails, an optional message; "Send invite" or "Save to my list"
// (Unknown). The preview shows the email's opening exactly as the provider
// gets it. Below, the list of invitations with state and dates.
//
// Renders NOTHING unless invites are on (platform_settings 'partner_invites',
// off for all of winter per Arielle 2026-10-28) and this person is a
// host_admin. The edge function and the database refuse on their own too.

import { useEffect, useRef, useState } from "react";
import { invitesEnabled, myHostAdminPartners, listInvitations, sendInvitations } from "../../lib/partnerPortal.js";
import { formatDate } from "../../lib/providerDocumentLogic.js";
import { localDateOf } from "../../lib/partnerPortalLogic.js";
import EmailPreviewDrawer from "../admin/marketing-v2/EmailPreviewDrawer.jsx";

// H1's words for an invitation's state.
const STATE_LABEL = { saved: "Unknown", sent: "Invited", opened: "Invited (opened)", accepted: "Shared", declined: "Not now", expired: "Expired" };

const day = (ts) => (ts ? formatDate(localDateOf(ts)) : null);

/** `onCounts({ Unknown, Invited })` feeds the home's count strip. */
export default function InvitePanel({ userId, onCounts }) {
  const [enabled, setEnabled] = useState(false);
  const [hosts, setHosts] = useState([]); // host_admin partner rows
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ business_name: "", emails: "", message: "" });
  const [msg, setMsg] = useState({ kind: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState({ open: false });
  const guard = useRef(false);

  async function load(hs) {
    const all = (await Promise.all(hs.map((h) => listInvitations(h.partner_id).catch(() => [])))).flat();
    all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    setList(all);
    onCounts?.({
      Unknown: all.filter((i) => i.state === "saved").length,
      Invited: all.filter((i) => i.state === "sent" || i.state === "opened").length,
    });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId || !(await invitesEnabled())) return;
      const hs = await myHostAdminPartners(userId);
      if (cancelled || hs.length === 0) return;
      setEnabled(true);
      setHosts(hs);
      await load(hs);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (!enabled) return null;
  const host = hosts[0];

  async function openPreview() {
    setPreview({ open: true, loading: true, error: null, subject: "", html: "", from: "" });
    try {
      const r = await sendInvitations({ action: "preview", partner_id: host.partner_id, business_name: form.business_name, message: form.message });
      setPreview({ open: true, loading: false, error: null, subject: r.subject, html: r.html, from: r.from });
    } catch (e) {
      setPreview({ open: true, loading: false, error: e?.message || "Couldn't render the preview.", subject: "", html: "", from: "" });
    }
  }

  async function submit(action) {
    if (guard.current) return;
    if (!form.business_name.trim() || !form.emails.trim()) { setMsg({ kind: "err", text: "Add the business name and at least one email." }); return; }
    guard.current = true; setBusy(true); setMsg({ kind: "", text: "" });
    try {
      const r = await sendInvitations({ action, partner_id: host.partner_id, ...form });
      const failed = (r.results ?? []).filter((x) => x.error);
      setMsg(failed.length
        ? { kind: "err", text: failed.map((x) => `${x.email}: ${x.error}`).join(" ") }
        : { kind: "ok", text: action === "send" ? "Invitation sent." : "Saved to your list." });
      if (!failed.length) { setForm({ business_name: "", emails: "", message: "" }); setOpen(false); }
      await load(hosts);
    } catch (e) {
      setMsg({ kind: "err", text: e?.message || "That didn't go through. Try again." });
    } finally {
      guard.current = false; setBusy(false);
    }
  }

  async function sendSaved(id) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setMsg({ kind: "", text: "" });
    try {
      await sendInvitations({ action: "send", invitation_id: id });
      setMsg({ kind: "ok", text: "Invitation sent." });
      await load(hosts);
    } catch (e) {
      setMsg({ kind: "err", text: e?.message || "That didn't go through. Try again." });
    } finally {
      guard.current = false; setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-j2s-ink">Invite your providers</h2>
        {!open && <button type="button" className="btn-j2s-primary" onClick={() => { setOpen(true); setMsg({ kind: "", text: "" }); }}>Invite a provider</button>}
      </div>
      {msg.text && <p role={msg.kind === "err" ? "alert" : "status"} className={`mt-2 text-sm ${msg.kind === "err" ? "error-text" : "font-semibold text-emerald-800"}`}>{msg.text}</p>}

      {open && (
        <div className="mt-3 space-y-3">
          <label className="block text-sm text-j2s-ink">
            <span className="font-semibold">Business name</span>
            <input className="input-field mt-1" maxLength={120} value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
          </label>
          <label className="block text-sm text-j2s-ink">
            <span className="font-semibold">Contact email</span> <span className="text-j2s-ink/50">(or several, one per line)</span>
            <textarea className="input-field mt-1" rows={2} value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} />
          </label>
          <label className="block text-sm text-j2s-ink">
            <span className="font-semibold">Message</span> <span className="text-j2s-ink/50">(optional)</span>
            <textarea className="input-field mt-1" rows={2} maxLength={1000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-j2s-primary" disabled={busy} onClick={() => submit("send")}>{busy ? "Sending…" : "Send invite"}</button>
            {/* The email exactly as it goes (spec v3 H4 "The email preview shows
                exactly what the provider will get"), in enrops's existing
                email-preview drawer. */}
            <button type="button" className="text-sm font-semibold text-j2s-purple hover:underline" disabled={busy} onClick={openPreview}>Preview email</button>
            <button type="button" className="text-sm font-semibold text-j2s-purple hover:underline" disabled={busy} onClick={() => submit("save")}>Save to my list</button>
            <button type="button" className="text-sm text-j2s-ink/60 hover:underline" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {list.length > 0 && (
        <ul className="mt-4 divide-y divide-j2s-ink/10 text-sm">
          {list.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <div>
                <span className="font-semibold text-j2s-ink">{i.business_name}</span>
                <span className="ml-2 text-j2s-ink/50">{i.invited_email}</span>
                {i.declined_note && <div className="text-xs text-j2s-ink/60">“{i.declined_note}”</div>}
              </div>
              <div className="text-xs text-j2s-ink/60">
                {STATE_LABEL[i.state] ?? i.state}
                {[i.sent_at && `sent ${day(i.sent_at)}`, i.opened_at && `opened ${day(i.opened_at)}`, i.accepted_at && `shared ${day(i.accepted_at)}`, i.declined_at && `${day(i.declined_at)}`]
                  .filter(Boolean).map((t) => ` · ${t}`).join("")}
                {i.state === "saved" && (
                  <button type="button" className="ml-2 font-semibold text-j2s-purple hover:underline" disabled={busy} onClick={() => sendSaved(i.id)}>Send</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <EmailPreviewDrawer
        open={!!preview.open}
        onClose={() => setPreview({ open: false })}
        title={form.business_name.trim() ? `As ${form.business_name.trim()} would get it` : "As the provider would get it"}
        badges={preview.from ? [{ label: `From ${preview.from}`, color: "#4b3fb0", bg: "#F2F0FF" }, { label: "Replies come to you", color: "#57534e", bg: "#f5f5f4" }] : []}
        subject={preview.subject}
        bodyHtml={preview.html}
        loading={!!preview.loading}
        error={preview.error}
      />
    </section>
  );
}
