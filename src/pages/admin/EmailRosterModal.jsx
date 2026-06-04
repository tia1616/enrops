// EmailRosterModal — sends a branded PDF roster to a partner's logistics
// contacts via the email-camp-roster edge function.
//
// Two-step UX:
//   1. If the camp's location has no partner_id linked, prompt to pick a
//      partner from the org's partners list. Saving writes partner_id
//      back to program_locations.
//   2. Show the partner's operational + marketing contacts (operational
//      pre-checked, marketing collapsed). Optional CC field + note. Send.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const CREAM = "#FBFBFB";
const OK = "#3a7c3a";
const RED = "#b53737";

function fmtDate(d) {
  if (!d) return "";
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Normalize a legacy `camp` prop into the generic target shape.
function campToTarget(camp) {
  return {
    kind: "camp",
    id: camp.id,
    locationId: camp.location_id,
    title: camp.curriculum_name,
    subtitle: `${fmtDate(camp.starts_on)}–${fmtDate(camp.ends_on)}${camp.location_name ? ` · ${camp.location_name}` : ""}`,
    functionName: "email-camp-roster",
    bodyKey: "camp_session_id",
  };
}

// Accepts either a legacy `camp` prop (camps) or a generic `target`
// (afterschool programs). target = { kind, id, locationId, title, subtitle,
// functionName, bodyKey }.
export default function EmailRosterModal({ camp, target: targetProp, orgId, onClose, onSent }) {
  const target = targetProp ?? campToTarget(camp);
  // Phase: 'loading' | 'pick_partner' | 'compose' | 'sending' | 'done'
  const [phase, setPhase] = useState("loading");
  const [location, setLocation] = useState(null);
  const [partner, setPartner] = useState(null);
  const [contacts, setContacts] = useState([]); // partner_contacts rows
  const [selected, setSelected] = useState(new Set()); // partner_contact ids
  const [includeLocationContact, setIncludeLocationContact] = useState(false);
  const [ccText, setCcText] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [emailFacts, setEmailFacts] = useState({ camperCount: 0, instructors: [] });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // Load camp location + partner + contacts on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError("");
      try {
        // If the camp isn't linked to a program_location row at all, jump
        // straight to the partner picker — we'll write partner_id back
        // once the operator picks (handled by the pick_partner step).
        if (!target.locationId) {
          setLocation(null);
          setPhase("pick_partner");
          return;
        }

        const { data: loc, error: locErr } = await supabase
          .from("program_locations")
          .select("id, name, contact_name, contact_email, partner_id")
          .eq("id", target.locationId)
          .maybeSingle();
        if (locErr) throw locErr;
        if (cancelled) return;
        setLocation(loc ?? null);

        if (!loc?.partner_id) {
          // The school IS the partner — before asking the operator to pick one,
          // auto-match a partner with the same name in this org and wire it up.
          // This is why contacts "weren't showing": locations were never linked
          // to their identically-named partner. Persist the link so it sticks.
          const { data: match } = await supabase
            .from("partners")
            .select("id")
            .eq("organization_id", orgId)
            .eq("inactive", false)
            .ilike("partner_name", loc.name ?? "")
            .limit(1)
            .maybeSingle();
          if (match?.id && loc.id) {
            await supabase
              .from("program_locations")
              .update({ partner_id: match.id })
              .eq("id", loc.id);
            if (cancelled) return;
            setLocation((l) => (l ? { ...l, partner_id: match.id } : l));
            await loadPartner(match.id);
            return;
          }
          setPhase("pick_partner");
          return;
        }

        await loadPartner(loc.partner_id);
      } catch (e) {
        if (!cancelled) {
          console.error("[EmailRosterModal] load failed", e);
          setError(e.message ?? "Couldn't load this camp's partner info.");
          setPhase("compose");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [target.locationId]);

  async function loadPartner(partnerId) {
    const { data: p, error: pErr } = await supabase
      .from("partners")
      .select("id, partner_name, partner_type, inactive")
      .eq("id", partnerId)
      .maybeSingle();
    if (pErr) throw pErr;
    setPartner(p ?? null);

    const { data: pcs, error: pcErr } = await supabase
      .from("partner_contacts")
      .select("id, contact_name, contact_email, contact_role, role_description")
      .eq("partner_id", partnerId)
      .order("contact_role", { ascending: true });
    if (pcErr) throw pcErr;
    const list = (pcs ?? []).filter((c) => !!c.contact_email);
    setContacts(list);

    // Default selection: every operational contact with an email.
    const pre = new Set(list.filter((c) => c.contact_role === "operational").map((c) => c.id));
    setSelected(pre);
    setPhase("compose");

    // Fetch defaults for Subject + Body from the edge function so the
    // editable preview has accurate camper count / instructor info.
    loadPreview(Array.from(pre));
  }

  async function loadPreview(contactIds) {
    setPreviewLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${target.functionName}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            [target.bodyKey]: target.id,
            recipient_contact_ids: contactIds,
            mode: "preview",
          }),
        }
      );
      const json = await resp.json();
      if (resp.ok) {
        // Only pre-fill if the user hasn't started editing yet.
        setSubject((cur) => cur || json.default_subject || "");
        setBody((cur) => cur || json.default_body || "");
        setEmailFacts({ camperCount: json.camper_count ?? 0, instructors: json.instructors ?? [] });
      }
    } catch (e) {
      console.error("[EmailRosterModal] preview failed", e);
    } finally {
      setPreviewLoading(false);
    }
  }

  const operational = useMemo(() => contacts.filter((c) => c.contact_role === "operational"), [contacts]);
  const otherContacts = useMemo(() => contacts.filter((c) => c.contact_role !== "operational"), [contacts]);

  function toggle(id) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCount = selected.size + (includeLocationContact && location?.contact_email ? 1 : 0) + parseCcEmails(ccText).length;

  async function send() {
    if (phase === "sending") return;
    setError("");
    if (selectedCount === 0) {
      setError("Pick at least one recipient.");
      return;
    }
    setPhase("sending");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${target.functionName}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            [target.bodyKey]: target.id,
            recipient_contact_ids: Array.from(selected),
            include_location_contact: includeLocationContact,
            cc: parseCcEmails(ccText),
            subject: subject.trim() || undefined,
            body: body || undefined,
            mode: "send",
          }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        setError(json?.error || `Send failed (${resp.status}).`);
        setPhase("compose");
        return;
      }
      setResult(json);
      setPhase("done");
      if (onSent) onSent();
    } catch (e) {
      setError(e.message ?? "Send failed.");
      setPhase("compose");
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "5vh 16px", zIndex: 200, fontFamily: "inherit",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 12, maxWidth: 620, width: "100%",
          padding: 24, maxHeight: "90vh", overflowY: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>
              Email roster: {target.title}
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED }}>
              {target.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer", lineHeight: 1 }}
            aria-label="Close"
          >✕</button>
        </div>

        {error && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {phase === "loading" && (
          <div style={{ color: MUTED, fontSize: 13, padding: "16px 0" }}>Loading…</div>
        )}

        {phase === "pick_partner" && (
          <PickPartnerStep
            location={location}
            orgId={orgId}
            onLinked={async (partnerId) => {
              try {
                setPhase("loading");
                await loadPartner(partnerId);
                // Refresh location to reflect partner_id
                setLocation((l) => l ? { ...l, partner_id: partnerId } : l);
              } catch (e) {
                setError(e.message ?? "Couldn't load partner contacts.");
                setPhase("compose");
              }
            }}
            onCancel={onClose}
          />
        )}

        {phase === "compose" && (
          <ComposeStep
            partner={partner}
            location={location}
            operational={operational}
            otherContacts={otherContacts}
            selected={selected}
            toggle={toggle}
            includeLocationContact={includeLocationContact}
            setIncludeLocationContact={setIncludeLocationContact}
            ccText={ccText}
            setCcText={setCcText}
            subject={subject}
            setSubject={setSubject}
            body={body}
            setBody={setBody}
            emailFacts={emailFacts}
            previewLoading={previewLoading}
            selectedCount={selectedCount}
            onSend={send}
            onClose={onClose}
            onChangePartner={() => setPhase("pick_partner")}
          />
        )}

        {phase === "sending" && (
          <div style={{ padding: "20px 0", textAlign: "center", color: MUTED, fontSize: 14 }}>
            Sending…
          </div>
        )}

        {phase === "done" && result && (
          <DoneStep result={result} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

// ─── Step components ────────────────────────────────────────────────────────

function PickPartnerStep({ location, orgId, onLinked, onCancel }) {
  const [partners, setPartners] = useState(null);
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("partners")
        .select("id, partner_name, partner_type, inactive")
        .eq("organization_id", orgId)
        .eq("inactive", false)
        .order("partner_name", { ascending: true });
      if (!cancelled) {
        if (error) setErr(error.message);
        setPartners(data ?? []);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  const filtered = useMemo(() => {
    if (!partners) return [];
    const q = query.trim().toLowerCase();
    if (!q) return partners;
    return partners.filter((p) => p.partner_name.toLowerCase().includes(q));
  }, [partners, query]);

  async function pick(partnerId) {
    if (picking) return;
    setErr("");
    setPicking(true);
    try {
      // Only persist the link when the camp has a saved location row. If
      // it doesn't, we just resolve the partner in memory for this send.
      if (location?.id) {
        const { error } = await supabase
          .from("program_locations")
          .update({ partner_id: partnerId })
          .eq("id", location.id);
        if (error) throw error;
      }
      onLinked(partnerId);
    } catch (e) {
      console.error("[PickPartnerStep] link failed", e);
      setErr(e.message ?? "Couldn't link this location to that partner.");
      setPicking(false);
    }
  }

  return (
    <div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, fontSize: 13, color: INK, marginBottom: 12, lineHeight: 1.5 }}>
        {location?.name ? (
          <>Tell us which partner organisation runs <strong>{location.name}</strong>. We'll remember this so future emails skip this step.</>
        ) : (
          <>This camp isn't linked to a saved location yet. Pick a partner just for this send — we won't save the link.</>
        )}
      </div>

      {err && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{err}</div>
      )}

      <input
        type="text"
        placeholder="Search partners…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: "100%", padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box", marginBottom: 10 }}
      />

      {partners === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading partners…</div>}
      {partners !== null && filtered.length === 0 && (
        <div style={{ color: MUTED, fontSize: 13 }}>No partners match.</div>
      )}

      <div style={{ maxHeight: 280, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 6 }}>
        {filtered.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => pick(p.id)}
            disabled={picking}
            style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "10px 12px", background: "transparent",
              border: "none", borderBottom: `1px solid ${RULE}`,
              cursor: picking ? "wait" : "pointer", fontFamily: "inherit",
              fontSize: 13, color: INK,
            }}
          >
            <div style={{ fontWeight: 600 }}>{p.partner_name}</div>
            {p.partner_type && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{p.partner_type.replace(/_/g, " ")}</div>}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
        >Cancel</button>
      </div>
    </div>
  );
}

function ComposeStep({ partner, location, operational, otherContacts, selected, toggle, includeLocationContact, setIncludeLocationContact, ccText, setCcText, subject, setSubject, body, setBody, emailFacts, previewLoading, selectedCount, onSend, onClose, onChangePartner }) {
  const [showOthers, setShowOthers] = useState(false);
  return (
    <div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Partner</div>
          <div style={{ fontWeight: 700, marginTop: 2 }}>{partner?.partner_name ?? "—"}</div>
        </div>
        <button
          type="button"
          onClick={onChangePartner}
          style={{ padding: "5px 10px", background: "transparent", color: PURPLE, border: `1px solid ${PURPLE}`, borderRadius: 5, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
        >Change</button>
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
        Logistics contacts
      </div>
      {operational.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 13, fontStyle: "italic", padding: "8px 0" }}>
          No operational contacts on file for this partner. Use the CC field below, or add operational contacts in Contacts.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
          {operational.map((c) => (
            <ContactRow key={c.id} contact={c} checked={selected.has(c.id)} onToggle={() => toggle(c.id)} />
          ))}
        </div>
      )}

      {location?.contact_email && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={includeLocationContact} onChange={(e) => setIncludeLocationContact(e.target.checked)} />
          <span>
            Also email the location contact <strong>{location.contact_name || location.name}</strong>{" "}
            <span style={{ color: MUTED }}>· {location.contact_email}</span>
          </span>
        </label>
      )}

      {otherContacts.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setShowOthers((v) => !v)}
            style={{ background: "transparent", border: "none", color: PURPLE, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", padding: 0 }}
          >
            {showOthers ? "Hide" : "Show"} other contacts ({otherContacts.length})
          </button>
          {showOthers && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
              {otherContacts.map((c) => (
                <ContactRow key={c.id} contact={c} checked={selected.has(c.id)} onToggle={() => toggle(c.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: MUTED, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Other emails (type one in — comma-separated for multiple)
        </label>
        <input
          type="text"
          value={ccText}
          onChange={(e) => setCcText(e.target.value)}
          placeholder="e.g. principal@school.edu, ops@partner.org"
          style={{ width: "100%", padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" }}
        />
      </div>

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${RULE}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
          Email preview {previewLoading && <span style={{ fontWeight: 400, fontStyle: "italic" }}>· loading…</span>}
        </div>

        <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6, padding: 10, marginBottom: 10, fontSize: 12, color: INK, lineHeight: 1.5 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Email facts (for your reference)</div>
          <div><strong>{emailFacts.camperCount}</strong> camper{emailFacts.camperCount === 1 ? "" : "s"} on the attached PDF</div>
          {emailFacts.instructors.length === 0 ? (
            <div>Instructor: not yet assigned</div>
          ) : (
            emailFacts.instructors.map((i, idx) => (
              <div key={idx}>
                {i.role === "lead" ? "Instructor" : (i.role || "Instructor")}: {i.name || "—"}
                {i.phone && ` · ${i.phone}`}
                {i.email && ` · ${i.email}`}
              </div>
            ))
          )}
        </div>

        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: MUTED, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Subject
          </span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            style={{ width: "100%", padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" }}
          />
        </label>

        <label style={{ display: "block" }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: MUTED, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Message
          </span>
          <textarea
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            style={{ width: "100%", padding: "10px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box", resize: "vertical", lineHeight: 1.5 }}
          />
        </label>

        <div style={{ fontSize: 11, color: MUTED, marginTop: 6, fontStyle: "italic" }}>
          Edit freely. The PDF roster attaches automatically — you don't need to mention it.
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}`, gap: 8 }}>
        <div style={{ fontSize: 12, color: MUTED }}>
          {selectedCount} recipient{selectedCount === 1 ? "" : "s"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
          >Cancel</button>
          <button
            type="button"
            onClick={onSend}
            disabled={selectedCount === 0}
            style={{ padding: "8px 16px", background: PURPLE, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: selectedCount === 0 ? "not-allowed" : "pointer", opacity: selectedCount === 0 ? 0.5 : 1 }}
          >Send roster</button>
        </div>
      </div>
    </div>
  );
}

function ContactRow({ contact, checked, onToggle }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px", background: checked ? `${PURPLE}0A` : "transparent", border: `1px solid ${checked ? PURPLE + "55" : RULE}`, borderRadius: 6, fontSize: 13, color: INK, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 3 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>
          {contact.contact_name || "(no name)"}
          {contact.contact_role && (
            <span style={{ fontSize: 10, color: MUTED, marginLeft: 6, fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {contact.contact_role}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>{contact.contact_email}</div>
        {contact.role_description && <div style={{ fontSize: 11, color: MUTED, marginTop: 1, fontStyle: "italic" }}>{contact.role_description}</div>}
      </div>
    </label>
  );
}

function DoneStep({ result, onClose }) {
  const sent = result.sent || 0;
  const failed = result.failed || [];
  return (
    <div>
      <div style={{ background: `${OK}1A`, border: `1px solid ${OK}55`, padding: 14, borderRadius: 8, fontSize: 14, color: INK, lineHeight: 1.5 }}>
        <strong style={{ color: OK }}>Sent.</strong> Roster delivered to {sent} recipient{sent === 1 ? "" : "s"}{result.camper_count != null ? ` (${result.camper_count} camper${result.camper_count === 1 ? "" : "s"} on roster).` : "."}
      </div>
      {failed.length > 0 && (
        <div style={{ marginTop: 10, background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13 }}>
          <strong>{failed.length} didn't send:</strong>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {failed.map((f, i) => <li key={i}>{f.email}: {f.reason}</li>)}
          </ul>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ padding: "8px 16px", background: PURPLE, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
        >Done</button>
      </div>
    </div>
  );
}

function parseCcEmails(text) {
  if (!text) return [];
  return text.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}
