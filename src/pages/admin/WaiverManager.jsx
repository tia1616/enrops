// /admin/waivers — "Waivers & policies". Two things families read, in one place:
//
//   1. Waivers — the agreements families SIGN. The portal's waiver gate enforces
//      the required ones and registration collects them.
//   2. Policies — the Privacy Policy and Terms of Service a provider PUBLISHES.
//      These render publicly at /{slug}/privacy and /{slug}/terms.
//
// Owner/admin only (reached from the settings-gated nav). Both tables are
// org-scoped via RLS. Brand-neutral copy — no tenant strings.
//
// Only privacy + terms are offered. `org_policies.policy_type` also permits
// dpa / cookies / data-retention / subprocessors / acceptable-use, but those
// are PLATFORM documents (published under the `enrops` org) and have no
// per-provider public route — offering them here would let an operator write a
// document no family could ever reach.

import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const CREAM = "#FBFBFB";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";
const RED = "#b53737";

// The policy types a provider can publish, in display order. Keep in sync with
// the public routes in App.jsx — never offer a type with no public route.
const POLICY_KINDS = [
  {
    type: "privacy",
    label: "Privacy Policy",
    blurb: "How you collect, use, and protect family and student information.",
  },
  {
    type: "terms",
    label: "Terms of Service",
    blurb: "The terms families agree to when they register with you.",
  },
];

export default function WaiverManager() {
  const { org } = useOutletContext();
  const [waivers, setWaivers] = useState(null); // null = loading
  const [policies, setPolicies] = useState(null); // null = loading; else the org's rows
  const [policiesError, setPoliciesError] = useState("");
  // Save failures must render INSIDE the open editor. The page-level `error`
  // banner sits at the top of the page, behind the modal overlay — an operator
  // who clicks Save and hits an error saw the button un-busy and nothing else,
  // which reads as "it worked" or "it's broken and I don't know why".
  const [saveError, setSaveError] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // waiver object, or { _new: true }
  const [editingPolicy, setEditingPolicy] = useState(null); // { type, label, row|null }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  async function load() {
    if (!org?.id) return;
    setError("");
    const [wRes, pRes] = await Promise.all([
      supabase
        .from("waivers")
        .select("id, name, content, required, active, version, updated_at")
        .eq("organization_id", org.id)
        .order("required", { ascending: false })
        .order("name"),
      supabase
        .from("org_policies")
        .select("id, policy_type, content_markdown, effective_date, last_updated")
        .eq("organization_id", org.id),
    ]);
    if (wRes.error) { setError(wRes.error.message); return; }
    setWaivers(wRes.data ?? []);
    // Policies are secondary — a failure here shouldn't blank the waivers list.
    // But it must NOT render as "Not published" either: that reads as a settled
    // fact when we simply don't know. Track the failure and say so.
    setPoliciesError(pRes.error ? (pRes.error.message ?? "Couldn't load your policies.") : "");
    setPolicies(pRes.error ? [] : (pRes.data ?? []));
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [org?.id]);

  const activeCount = useMemo(() => (waivers ?? []).filter((w) => w.active).length, [waivers]);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 2200); }

  // Open/close both editors through these so a stale save error from a previous
  // attempt can never greet you on a freshly opened form. One place to edit
  // beats six call sites, one of which would eventually get missed.
  function openWaiverEditor(w) { setSaveError(""); setEditing(w); }
  function closeWaiverEditor() { setSaveError(""); setEditing(null); }
  function openPolicyEditor(kind, row) { setSaveError(""); setEditingPolicy({ ...kind, row }); }
  function closePolicyEditor() { setSaveError(""); setEditingPolicy(null); }

  async function saveEditing(form) {
    setBusy(true); setError("");
    try {
      if (editing?._new) {
        const { error: e } = await supabase.from("waivers").insert({
          organization_id: org.id,
          name: form.name.trim(),
          content: form.content,
          required: !!form.required,
          active: true,
        });
        if (e) throw e;
        flash("Waiver added.");
      } else {
        const { error: e } = await supabase.from("waivers")
          .update({ name: form.name.trim(), content: form.content, required: !!form.required, updated_at: new Date().toISOString() })
          .eq("id", editing.id);
        if (e) throw e;
        flash("Waiver saved.");
      }
      setEditing(null);
      await load();
    } catch (e) {
      // Stays inside the still-open editor, not behind it.
      setSaveError(e.message ?? "Couldn't save the waiver.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(w, field) {
    setError("");
    const { error: e } = await supabase.from("waivers")
      .update({ [field]: !w[field], updated_at: new Date().toISOString() }).eq("id", w.id);
    if (e) { setError(e.message); return; }
    flash(field === "active" ? (!w.active ? "Waiver activated." : "Waiver archived.") : (!w.required ? "Marked required." : "Marked optional."));
    load();
  }

  // Upsert on the (organization_id, policy_type) unique constraint, so editing a
  // published policy overwrites it instead of failing. That emits
  // ON CONFLICT DO UPDATE, which Postgres requires an UPDATE policy for — the
  // table has one ("Org members can update own org policies"), verified live on
  // staging and prod. The SECOND save is the one that exercises it.
  async function savePolicy({ type, content, effectiveDate }) {
    setBusy(true); setError(""); setSaveError("");
    try {
      const { error: e } = await supabase.from("org_policies").upsert(
        {
          organization_id: org.id,
          policy_type: type,
          content_markdown: content,
          effective_date: effectiveDate || null,
          last_updated: new Date().toISOString(),
        },
        { onConflict: "organization_id,policy_type" },
      );
      if (e) throw e;
      setEditingPolicy(null);
      await load();
      flash("Published. Families can read it now.");
    } catch (e) {
      // Never swallow this — the operator's next decision depends on whether it
      // saved. Renders inside the still-open editor so it can't hide behind the
      // modal overlay.
      setSaveError(e.message ?? "Couldn't save that policy.");
    } finally {
      setBusy(false);
    }
  }

  async function unpublishPolicy(row, label) {
    if (busy) return;
    if (!window.confirm(`Unpublish your ${label}? Families will no longer see it, and the link will disappear from your site footer. You can publish it again later.`)) return;
    setBusy(true); setError("");
    try {
      const { error: e } = await supabase.from("org_policies").delete().eq("id", row.id);
      if (e) throw e;
      await load();
      flash(`${label} unpublished.`);
    } catch (e) {
      setError(e.message ?? "Couldn't unpublish that policy.");
    } finally {
      setBusy(false);
    }
  }

  async function seedTemplate() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      // Copies the platform default waivers into this org with the operator's
      // name filled in (server-side, admin-gated). See seed_default_waivers().
      const { data, error: e } = await supabase.rpc("seed_default_waivers", { p_org_id: org.id });
      if (e) throw e;
      if (!data) { setError("No starter templates are available yet."); return; }
      flash(`Added ${data} starter waiver${data === 1 ? "" : "s"} — edit them to match your program.`);
      await load();
    } catch (e) {
      setError(e.message ?? "Couldn't add the starter waivers.");
    } finally {
      setBusy(false);
    }
  }

  if (waivers === null) {
    // A failed load used to leave `waivers` null forever, so the page sat on
    // "Loading waivers…" with the error banner stuck inside a return that never
    // rendered. Say what happened instead of spinning.
    if (error) {
      return (
        <div style={{ maxWidth: 820, margin: "0 auto", padding: "8px 0 40px" }}>
          <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
          <div style={{ marginTop: 16, padding: "12px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13.5, lineHeight: 1.5 }}>
            We couldn&rsquo;t load your waivers and policies. Refresh to try again. ({error})
          </div>
        </div>
      );
    }
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading waivers…</div>;
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
        <div>
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 24, fontWeight: 700 }}>Waivers &amp; policies</h1>
          <p style={{ color: MUTED, fontSize: 14, marginTop: 4, lineHeight: 1.5, maxWidth: 560 }}>
            The agreements families sign to enroll, and the privacy policy and terms you publish on your registration site.
          </p>
        </div>
      </div>

      <h2 style={{ margin: "24px 0 0", fontSize: 17, fontWeight: 700, color: INK }}>Waivers families sign</h2>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
        <p style={{ color: MUTED, fontSize: 13.5, margin: 0, lineHeight: 1.5, maxWidth: 560 }}>
          Required ones must be signed before a family can see their program details in the portal.
        </p>
        <button type="button" onClick={() => openWaiverEditor({ _new: true })} style={primaryBtn(false)}>+ Add a waiver</button>
      </div>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {waivers.length === 0 ? (
        <div style={{ marginTop: 24, background: PANEL, border: `1px dashed ${RULE}`, borderRadius: 12, padding: 28, textAlign: "center" }}>
          <div style={{ color: INK, fontSize: 15, fontWeight: 600 }}>No waivers yet</div>
          <p style={{ color: MUTED, fontSize: 13.5, lineHeight: 1.6, margin: "8px auto 16px", maxWidth: 460 }}>
            Start from a standard set — a liability waiver and a photo/media release — then edit them to match your program. Or build your own from scratch.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={seedTemplate} disabled={busy} style={primaryBtn(busy)}>{busy ? "Adding…" : "Start from a template"}</button>
            <button type="button" onClick={() => openWaiverEditor({ _new: true })} style={ghostBtn(false)}>Add my own</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {waivers.map((w) => (
            <div key={w.id} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px", opacity: w.active ? 1 : 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {w.name}
                    {w.required ? <Badge bg="#fff7ed" border="#fed7aa" color="#9a3412">Required</Badge> : <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Optional</Badge>}
                    {!w.active && <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Archived</Badge>}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED, lineHeight: 1.5, maxWidth: 560, maxHeight: 40, overflow: "hidden" }}>{w.content}</div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => openWaiverEditor(w)} style={ghostBtn(false)}>Edit</button>
                  <button type="button" onClick={() => toggle(w, "required")} style={ghostBtn(false)}>{w.required ? "Make optional" : "Make required"}</button>
                  <button type="button" onClick={() => toggle(w, "active")} style={ghostBtn(false)}>{w.active ? "Archive" : "Restore"}</button>
                </div>
              </div>
            </div>
          ))}
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{activeCount} active · families sign every <strong>required + active</strong> waiver.</div>
        </div>
      )}

      <h2 style={{ margin: "36px 0 0", fontSize: 17, fontWeight: 700, color: INK }}>Policies you publish</h2>
      <p style={{ color: MUTED, fontSize: 13.5, margin: "4px 0 0", lineHeight: 1.5, maxWidth: 620 }}>
        Your own privacy policy and terms, shown on your registration site. Until you publish one,
        its link stays off your site footer and anyone who visits the page is told you haven&rsquo;t
        published one yet — families are never shown another provider&rsquo;s policy.
      </p>

      {policiesError && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>
          We couldn&rsquo;t load your policies just now, so we can&rsquo;t show whether they&rsquo;re published. Refresh to try again. ({policiesError})
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12, opacity: policiesError ? 0.5 : 1 }}>
        {POLICY_KINDS.map((kind) => {
          const row = (policies ?? []).find((p) => p.policy_type === kind.type) || null;
          const publicPath = `/${org?.slug ?? ""}/${kind.type}`;
          return (
            <div key={kind.type} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {kind.label}
                    {policiesError
                      ? <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Unknown</Badge>
                      : row
                        ? <Badge bg={GREEN_BG} border="#bbf7d0" color={GREEN_INK}>Published</Badge>
                        : <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Not published</Badge>}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED, lineHeight: 1.5, maxWidth: 560 }}>
                    {row ? (
                      <>
                        Last updated {formatStamp(row.last_updated)}
                        {row.effective_date ? ` · effective ${formatStamp(row.effective_date)}` : ""}
                        {" · "}
                        <a href={publicPath} target="_blank" rel="noreferrer" style={{ color: BRIGHT, textDecoration: "none" }}>
                          View public page ↗
                        </a>
                      </>
                    ) : kind.blurb}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => openPolicyEditor(kind, row)} style={row ? ghostBtn(false) : primaryBtn(false)}>
                    {row ? "Edit" : "Publish"}
                  </button>
                  {row && (
                    <button type="button" onClick={() => unpublishPolicy(row, kind.label)} disabled={busy} style={ghostBtn(busy)}>Unpublish</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <WaiverEditor
          waiver={editing}
          busy={busy}
          saveError={saveError}
          onCancel={closeWaiverEditor}
          onSave={saveEditing}
        />
      )}

      {editingPolicy && (
        <PolicyEditor
          // Remount per policy type so the textarea can't keep the previous
          // policy's text in its initial state.
          key={editingPolicy.type}
          kind={editingPolicy}
          busy={busy}
          saveError={saveError}
          onCancel={closePolicyEditor}
          onSave={savePolicy}
        />
      )}
    </div>
  );
}

function formatStamp(v) {
  if (!v) return "";
  // Date-only columns (effective_date) must not be shifted by the local timezone.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function PolicyEditor({ kind, busy, saveError, onCancel, onSave }) {
  const row = kind.row;
  const [content, setContent] = useState(row?.content_markdown ?? "");
  const [effectiveDate, setEffectiveDate] = useState(row?.effective_date ?? "");
  const valid = content.trim().length > 0;

  return (
    <div onClick={busy ? undefined : onCancel} style={{ position: "fixed", inset: 0, background: "rgba(28,0,79,0.32)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 720, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24, boxShadow: "0 10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>{row ? `Edit ${kind.label}` : `Publish ${kind.label}`}</h2>
          <button onClick={onCancel} disabled={busy} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, color: MUTED, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        <label style={lbl}>Effective date <span style={{ fontWeight: 400, color: MUTED }}>(optional)</span></label>
        <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} style={{ ...input, maxWidth: 220 }} disabled={busy} />

        <label style={{ ...lbl, marginTop: 16 }}>Policy text</label>
        <p style={{ margin: "0 0 8px", fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
          Paste your policy here. Plain text works. If you use Markdown, <strong>## Heading</strong> makes a
          section heading, <strong>- item</strong> makes a bullet, and <strong>**bold**</strong> bolds text.
        </p>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          placeholder={`Paste your ${kind.label.toLowerCase()}…`}
          style={{ ...input, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }}
          disabled={busy}
        />

        <div style={{ marginTop: 14, padding: "10px 12px", background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
          This is your own legal document. Enrops publishes separate platform policies covering the
          registration software itself — yours doesn&rsquo;t need to repeat them.
        </div>

        {saveError && (
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#fef2f2", border: `1px solid #fecaca`, borderRadius: 8, color: "#991b1b", fontSize: 13, lineHeight: 1.5 }}>
            That didn&rsquo;t save, so nothing changed for families. ({saveError})
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20, borderTop: `1px solid ${RULE}`, paddingTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={ghostBtn(busy)}>Cancel</button>
          <button
            type="button"
            onClick={() => onSave({ type: kind.type, content, effectiveDate })}
            disabled={busy || !valid}
            style={primaryBtn(busy || !valid)}
          >
            {busy ? "Publishing…" : row ? "Save changes" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}

function WaiverEditor({ waiver, busy, saveError, onCancel, onSave }) {
  const isNew = !!waiver._new;
  const [name, setName] = useState(isNew ? "" : waiver.name ?? "");
  const [content, setContent] = useState(isNew ? "" : waiver.content ?? "");
  const [required, setRequired] = useState(isNew ? true : !!waiver.required);
  const valid = name.trim().length > 0 && content.trim().length > 0;

  return (
    <div onClick={busy ? undefined : onCancel} style={{ position: "fixed", inset: 0, background: "rgba(28,0,79,0.32)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 640, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24, boxShadow: "0 10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>{isNew ? "Add a waiver" : "Edit waiver"}</h2>
          <button onClick={onCancel} disabled={busy} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, color: MUTED, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        <label style={lbl}>Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Liability Waiver & Agreement" style={input} disabled={busy} />

        <label style={{ ...lbl, marginTop: 16 }}>Text families read &amp; agree to</label>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={12} placeholder="Paste or write the full waiver text…" style={{ ...input, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }} disabled={busy} />

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 14, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} disabled={busy} />
          Required — families must sign this to enroll / see program details
        </label>

        {saveError && (
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#fef2f2", border: `1px solid #fecaca`, borderRadius: 8, color: "#991b1b", fontSize: 13, lineHeight: 1.5 }}>
            That didn&rsquo;t save, so nothing changed for families. ({saveError})
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20, borderTop: `1px solid ${RULE}`, paddingTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={ghostBtn(busy)}>Cancel</button>
          <button type="button" onClick={() => onSave({ name, content, required })} disabled={busy || !valid} style={primaryBtn(busy || !valid)}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Badge({ children, bg, border, color }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, background: bg, border: `1px solid ${border}`, color, padding: "2px 8px", borderRadius: 999 }}>{children}</span>;
}

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
function primaryBtn(disabled) { return { padding: "9px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
