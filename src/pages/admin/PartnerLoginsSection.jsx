// "Who at <partner> can log in", on that partner's page in the Partner portal
// admin (/admin/partner-documents/:partnerId, one page per partner since
// 2026-10-27): who at this partner can sign in to the partner portal and see
// what's shown to them, and what they have opened.
//
// Access is granted to an existing partner CONTACT, so a person's name and
// email live only on the contact (Locations). Owners and admins grant and
// remove (partner_portal_access RLS: can_admin_org). "Send sign-in link"
// EMAILS A REAL PERSON, so it always asks first.
//
// Sites (20261030a; Arielle's Oct 28 Impact NW promise, "each person sees only
// their own sites"): a login sees every site of the partner, or only the sites
// ticked here. It limits the instructors they see; documents are the
// partner's own and every login sees them. Changed later with "Change sites"
// (set_partner_access_sites), the only write path for it.

import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  listPortalAccess, listGrantableContacts, grantPortalAccess, removePortalAccess,
  sendPartnerSignInLink, listPartnerSites, setPortalAccessSites,
} from "../../lib/partnerPortal.js";
import { accessStatus, contactsWithoutAccess, siteScopeLabel, siteIdsToSave, REQUIREMENTS } from "../../lib/partnerPortalLogic.js";

const REQUIREMENT_NAME = Object.fromEntries(REQUIREMENTS.map((r) => [r.key, r.label.toLowerCase()]));
import { supabase } from "../../lib/supabase";
import { listProviderDocuments } from "../../lib/providerDocuments.js";

const ROLE_LABEL = { host_admin: "Admin", host_viewer: "Viewer" };
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

// "Every site" or "Only these sites" + a tick per site. Archived sites are
// offered only when already chosen, so a saved choice can still be unticked.
function SitePicker({ partnerName, sites, everySite, picked, disabled, onChange }) {
  // One radio group per picker (the give-access form and a login's editor can
  // both be open), so arrow keys move between its two choices.
  const group = useId();
  const offered = sites.filter((s) => !s.archived || picked.includes(s.id));
  const radio = { display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: INK, cursor: disabled ? "default" : "pointer" };
  return (
    <div role="radiogroup" aria-label="Which sites they see" style={{ display: "grid", gap: 6 }}>
      <label style={radio}>
        <input type="radio" name={group} checked={everySite} disabled={disabled} onChange={() => onChange(true, picked)} />
        Every {partnerName} site, including ones added later
      </label>
      <label style={radio}>
        <input type="radio" name={group} checked={!everySite} disabled={disabled} onChange={() => onChange(false, picked)} />
        Only these sites
      </label>
      {!everySite && (
        <div style={{ display: "grid", gap: 4, paddingLeft: 26 }}>
          {offered.map((s) => (
            <label key={s.id} style={{ ...radio, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                disabled={disabled}
                onChange={(e) => onChange(false, e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))}
              />
              {s.name}{s.archived ? " (archived)" : ""}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PartnerLoginsSection({ org, partner, canManage, onMessage }) {
  const [grants, setGrants] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [sites, setSites] = useState([]);
  const [contactId, setContactId] = useState("");
  // Spec v3 roles. Same view on Oct 30; only an admin will record decisions.
  const [role, setRole] = useState("host_admin");
  const [everySite, setEverySite] = useState(true);
  const [picked, setPicked] = useState([]);
  const [editing, setEditing] = useState(null); // { id, everySite, picked } | null
  const [busy, setBusy] = useState(null); // grant id, or "grant"
  const [error, setError] = useState("");
  // A personal note that goes in the sign-in email (Jessica 2026-11-25:
  // "invites with a personal note"). Kept for every send on this page until
  // changed, so several people at one partner get the same words.
  const [note, setNote] = useState("");

  async function load() {
    try {
      const [g, c, s] = await Promise.all([listPortalAccess(org.id), listGrantableContacts(org.id), listPartnerSites(org.id, partner.id)]);
      setGrants(g.filter((x) => x.partner_id === partner.id));
      setContacts(c.filter((x) => x.partner_id === partner.id));
      setSites(s);
      setError("");
    } catch (err) {
      setError(`Couldn't load partner logins: ${err?.message ?? "unknown error"}`);
      setGrants((prev) => prev ?? []);
    }
  }

  useEffect(() => { if (org?.id) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [org?.id, partner.id]);

  const available = useMemo(() => contactsWithoutAccess(contacts, grants), [contacts, grants]);
  // A choice of sites only means something with two or more.
  const canChooseSites = sites.filter((s) => !s.archived).length > 1;
  const grantSites = canChooseSites ? siteIdsToSave(everySite, picked) : null;
  const grantSitesMissing = Array.isArray(grantSites) && grantSites.length === 0;

  async function grant() {
    if (!contactId || busy || grantSitesMissing) return;
    setBusy("grant"); setError("");
    try {
      await grantPortalAccess(org.id, contactId, role, grantSites);
      // Reset the picker: the person just given access leaves its options.
      setContactId("");
      setRole("host_admin");
      setEverySite(true);
      setPicked([]);
      onMessage("Access given. Send them a sign-in link when you're ready.");
      await load();
    } catch (err) {
      setError(`Couldn't give access: ${err?.message ?? "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function saveSites() {
    if (!editing || busy) return;
    const next = siteIdsToSave(editing.everySite, editing.picked);
    if (Array.isArray(next) && next.length === 0) return;
    setBusy(editing.id); setError("");
    try {
      await setPortalAccessSites(editing.id, next);
      setEditing(null);
      onMessage("Sites saved.");
      await load();
    } catch (err) {
      setError(`Couldn't save the sites: ${err?.message ?? "unknown error"}`);
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
    const withNote = note.trim()
      ? `\n\nYour note goes with it:\n"${note.trim().slice(0, 300)}${note.trim().length > 300 ? "..." : ""}"`
      : "\n\nNo personal note (you can add one above the list).";
    if (!window.confirm(`Email a sign-in link to ${row.contact?.contact_name || email} (${email})? They'll see what's shown to ${partner.partner_name}.${withNote}`)) return;
    setBusy(row.id); setError("");
    try {
      // The function tells an owner/admin what really happened; say exactly that.
      const outcome = await sendPartnerSignInLink(org, email, note);
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
      <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: INK }}>Who at {partner.partner_name} can log in</h2>
      <p style={{ margin: "0 0 12px", fontSize: 13.5, color: MUTED, lineHeight: 1.5, maxWidth: 600 }}>
        They see the Classes, Safety record and Emails sent tabs, and nothing shown only to your other partners. Their admin logins that see every site can change their own requirements.
      </p>

      {error && <div style={{ marginBottom: 12, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}

      {canManage && grants?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <label htmlFor={`invite-note-${partner.id}`} style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 4 }}>
            Personal note for the sign-in email <span style={{ fontWeight: 400, color: MUTED }}>(optional)</span>
          </label>
          <textarea
            id={`invite-note-${partner.id}`} value={note} maxLength={1000} rows={3}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Hi! We're using enrops to share our classes, rosters and safety record with ${partner.partner_name}. Here's your sign-in.`}
            style={{ width: "100%", maxWidth: 600, boxSizing: "border-box", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", lineHeight: 1.5 }}
          />
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            Goes at the top of the email, above the sign-in button, for each link you send from this page. Replies go to your reply-to email.
          </div>
        </div>
      )}

      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "6px 20px" }}>
        {grants === null ? (
          <div style={{ padding: "14px 0", color: MUTED, fontSize: 13 }}>Loading…</div>
        ) : grants.length === 0 ? (
          <div style={{ padding: "14px 0", color: MUTED, fontSize: 13 }}>No one at {partner.partner_name} can log in yet.</div>
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
                  {/* overflowWrap: an email has no spaces, so on a phone a long one ran
                      past the card edge (seen on staging 2026-10-22). */}
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: INK, overflowWrap: "anywhere" }}>{g.contact?.contact_name || g.contact?.contact_email}</div>
                  <div style={{ fontSize: 13, color: MUTED, marginTop: 2, overflowWrap: "anywhere" }}>
                    {g.contact?.contact_email} · {ROLE_LABEL[g.role] ?? "Admin"}
                  </div>
                  {(canChooseSites || Array.isArray(g.site_ids)) && (
                    <div style={{ fontSize: 13, color: MUTED, marginTop: 4, overflowWrap: "anywhere" }}>
                      Sees: {siteScopeLabel(g.site_ids, sites)}
                      {canManage && editing?.id !== g.id && (
                        <button
                          type="button" style={{ ...linkBtn, marginLeft: 10 }} disabled={!!busy}
                          // Only sites still under this partner: one since moved to another
                          // partner can't be shown, unticked or saved (the database refuses it).
                          onClick={() => setEditing({ id: g.id, everySite: !Array.isArray(g.site_ids), picked: (g.site_ids ?? []).filter((id) => sites.some((s) => s.id === id)) })}
                        >
                          Change sites
                        </button>
                      )}
                    </div>
                  )}
                  <span style={{ display: "inline-block", marginTop: 6, padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: t.bg, color: t.ink, border: `1px solid ${t.border}` }}>{st.label}</span>
                  {archived && <div style={{ fontSize: 12.5, color: "#92400e", marginTop: 6 }}>This partner is archived, so this person can't see anything until it's active again.</div>}
                  {editing?.id === g.id && (
                    <div style={{ marginTop: 10, padding: "12px 14px", background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 10 }}>
                      <SitePicker
                        partnerName={partner.partner_name} sites={sites} everySite={editing.everySite} picked={editing.picked}
                        disabled={!!busy} onChange={(every, ids) => setEditing({ ...editing, everySite: every, picked: ids })}
                      />
                      <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 10 }}>
                        <button
                          type="button" onClick={saveSites}
                          disabled={!!busy || (!editing.everySite && editing.picked.length === 0)}
                          style={primaryBtn(!!busy || (!editing.everySite && editing.picked.length === 0))}
                        >
                          {busy === g.id ? "Saving…" : "Save sites"}
                        </button>
                        <button type="button" style={linkBtn} disabled={!!busy} onClick={() => setEditing(null)}>Cancel</button>
                        {!editing.everySite && editing.picked.length === 0 && <span style={{ fontSize: 12.5, color: MUTED }}>Choose at least one site.</span>}
                      </div>
                    </div>
                  )}
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
            <div style={{ flex: "2 1 260px" }}>
              <select value={contactId} onChange={(e) => setContactId(e.target.value)} style={input} disabled={available.length === 0} aria-label="Person">
                <option value="">{available.length ? "Choose a person" : `No one else at ${partner.partner_name} has an email on file`}</option>
                {available.map((c) => <option key={c.id} value={c.id}>{c.contact_name ? `${c.contact_name} (${c.contact_email})` : c.contact_email}</option>)}
              </select>
            </div>
            <div style={{ flex: "0 1 170px" }}>
              <select value={role} onChange={(e) => setRole(e.target.value)} style={input} aria-label="Access level">
                <option value="host_admin">{ROLE_LABEL.host_admin}</option>
                <option value="host_viewer">{ROLE_LABEL.host_viewer}</option>
              </select>
            </div>
            <button type="button" onClick={grant} disabled={!contactId || !!busy || grantSitesMissing} style={primaryBtn(!contactId || !!busy || grantSitesMissing)}>
              {busy === "grant" ? "Saving…" : "Give access"}
            </button>
          </div>
          {canChooseSites && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>Which sites they see</div>
              <SitePicker
                partnerName={partner.partner_name} sites={sites} everySite={everySite} picked={picked}
                disabled={!!busy} onChange={(every, ids) => { setEverySite(every); setPicked(ids); }}
              />
              {grantSitesMissing && <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>Choose at least one site.</div>}
              <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
                This limits the instructors they see. Your documents for {partner.partner_name} show to everyone with a login.
              </div>
            </div>
          )}
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>
            Not listed? Add them as a contact in <Link to="/admin/schools" style={{ color: BRIGHT }}>Locations</Link> first.
            Nothing is emailed until you click Send sign-in link.
          </div>
        </div>
      )}

      {grants && grants.length > 0 && <PartnerActivity org={org} partner={partner} grants={grants} />}
    </section>
  );
}

// The view log: who at this partner opened the portal or a document, newest
// first. Read straight from audit_events (append-only; owner/admin may read their own).
function PartnerActivity({ org, partner, grants }) {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  // Collapsed to its latest line (Jessica 2026-11-25: "why do I need to know
  // what Happy Valley has opened? that list is just gonna grow super long").
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: events, error: e1 }, docs] = await Promise.all([
        supabase
          .from("audit_events")
          .select("id, occurred_at, actor_user_id, actor_role, partner_id, action, subject_type, subject_id, after")
          .eq("organization_id", org.id)
          .eq("partner_id", partner.id)
          // roster_opened: a partner opened a class roster (20261119a).
          // partner_requirement_*: the partner changed its own list (20261119p);
          // the provider's own changes are not "their activity", hence actor_role.
          .in("action", ["portal_viewed", "document_opened", "roster_opened", "partner_requirement_changed", "partner_requirement_detail_set"])
          .in("actor_role", ["partner", "host_admin"])
          .order("occurred_at", { ascending: false })
          .limit(25),
        listProviderDocuments(org.id).catch(() => []),
      ]);
      if (cancelled) return;
      if (e1) { setFailed(true); return; }
      const titles = new Map(docs.map((d) => [d.id, d.title]));
      // Class names for roster opens. A failed lookup only loses the name.
      const ids = (kind) => [...new Set((events ?? []).filter((e) => e.action === "roster_opened" && e.subject_type === kind).map((e) => e.subject_id))];
      const [progs, camps] = await Promise.all([
        ids("program").length ? supabase.from("programs").select("id, curriculum").in("id", ids("program")) : { data: [] },
        ids("camp_session").length ? supabase.from("camp_sessions").select("id, curriculum_name").in("id", ids("camp_session")) : { data: [] },
      ]);
      if (cancelled) return;
      for (const p of progs.data ?? []) titles.set(p.id, p.curriculum);
      for (const c of camps.data ?? []) titles.set(c.id, c.curriculum_name);
      setRows((events ?? []).map((ev) => ({ ...ev, docTitle: titles.get(ev.subject_id) })));
    })();
    return () => { cancelled = true; };
  }, [org.id, partner.id, grants.length]);

  // `grants` are this partner's only, so a match is someone at this partner.
  const who = (ev) => {
    const g = grants.find((x) => x.auth_user_id === ev.actor_user_id);
    return g ? (g.contact?.contact_name || g.contact?.contact_email) : "Someone who no longer has access";
  };

  if (!failed && rows && rows.length > 0 && !open) {
    const ev = rows[0];
    return (
      <div style={{ marginTop: 18, fontSize: 13, color: MUTED }}>
        Last activity: <span style={{ color: INK, fontWeight: 600 }}>{who(ev)}</span>{" "}
        {ev.action === "document_opened" ? "opened a document"
          : ev.action === "roster_opened" ? "opened a roster"
            : ev.action.startsWith("partner_requirement") ? "changed what they require"
              : "viewed your records"}
        {" · "}{new Date(ev.occurred_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        {" · "}
        <button type="button" style={linkBtn} onClick={() => setOpen(true)}>See recent activity</button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 6 }}>
        What they've opened and changed
        {open && <button type="button" style={{ ...linkBtn, marginLeft: 10, fontWeight: 600 }} onClick={() => setOpen(false)}>Hide</button>}
      </div>
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "6px 20px" }}>
        {failed ? (
          <div style={{ padding: "12px 0", color: "#991b1b", fontSize: 13 }}>Couldn't load partner activity.</div>
        ) : rows === null ? (
          <div style={{ padding: "12px 0", color: MUTED, fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "12px 0", color: MUTED, fontSize: 13 }}>No one at {partner.partner_name} has opened or changed anything yet.</div>
        ) : (
          rows.map((ev, i) => (
            <div key={ev.id} style={{ padding: "10px 0", borderTop: i === 0 ? "none" : `1px solid ${RULE}`, fontSize: 13, color: INK }}>
              <span style={{ fontWeight: 600 }}>{who(ev)}</span>{" "}
              {ev.action === "document_opened"
                ? <>opened {ev.docTitle ? `"${ev.docTitle}"` : "a document that has since been removed"}</>
                : ev.action === "roster_opened"
                  ? <>opened the roster for {ev.docTitle ? `"${ev.docTitle}"` : "a class"}</>
                  : ev.action === "partner_requirement_changed"
                    ? <>{ev.after?.required ? "now requires" : "no longer requires"} {REQUIREMENT_NAME[ev.after?.key] ?? "an item"}</>
                    : ev.action === "partner_requirement_detail_set"
                      ? <>updated what they require for {REQUIREMENT_NAME[ev.after?.key] ?? "an item"}</>
                      : "viewed your records"}
              <span style={{ color: MUTED }}> · {new Date(ev.occurred_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
