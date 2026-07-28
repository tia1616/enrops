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
// Only privacy + terms + cancellation are offered. `org_policies.policy_type`
// also permits dpa / cookies / data-retention / subprocessors / acceptable-use,
// but those are PLATFORM documents (published under the `enrops` org) and have
// no per-provider public route — offering them here would let an operator write
// a document no family could ever reach.
//
// The cancellation policy is the one families are shown at CHECKOUT, on the pay
// step, before any money is taken. Publishing it is what makes that block
// appear; unpublished means the pay step simply shows nothing there.

import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { renderWaiverText, hasOrgToken } from "../../lib/waiverText.js";

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
  {
    type: "cancellation",
    label: "Cancellation & Refund Policy",
    blurb:
      "What happens when a family cancels or asks for a refund. Families see this on the payment step, before they pay.",
    // The admin fee note is built at render time by adminFeeNote() below — what
    // it can truthfully say depends on whether the operator can reach the
    // setting yet.
    hasAdminFeeNote: true,
  },
];

// The admin fee is a separate, easy-to-miss setting on the Payments page. An
// operator writing their cancellation wording is exactly the person who needs to
// know it exists and is theirs to change — otherwise they either promise
// something the refund screen won't do, or never realise they can keep a fee at
// all.
//
// TWO BRANCHES, BOTH TRUE IN THE STATE THAT SELECTS THEM. The field only renders
// inside Finances' "Manage setup" panel, and that panel only exists when
// stripe_account_status === 'active' (Finances.jsx: `isActive` gates it). So for
// an operator who has not finished Stripe — which is EVERY brand-new self-serve
// signup — the original single-branch note sent them to a page with no such
// setting on it and no way to reach one. Telling someone to go set a value that
// does not exist for them yet is worse than saying nothing.
//
// The link target is written once here rather than per branch, so the two
// cannot drift apart.
const FINANCES_PATH = "/admin/finances";
function adminFeeNote(stripeActive) {
  return stripeActive
    ? {
        text: "Charging an admin fee when a family withdraws? Set the amount under",
        // ?setup=1 opens the "Manage setup" panel on arrival. Without it the
        // panel is collapsed by default and the operator lands on a page where
        // the thing they were just sent to find is invisible.
        linkTo: `${FINANCES_PATH}?setup=1`,
        linkLabel: "Payments → Manage setup",
        after: "so it matches what you say here.",
      }
    : {
        text: "Planning to keep an admin fee when a family withdraws? You can set the amount once you",
        linkTo: FINANCES_PATH,
        linkLabel: "connect Stripe to get paid",
        after: "— then come back and make sure this wording matches it.",
      };
}

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
  // Whether the admin-fee setting is actually reachable. Read here rather than
  // from the outlet context, which carries stripe_charges_enabled — a DIFFERENT
  // flag. The note has to branch on the SAME condition that decides whether the
  // field renders (Finances gates it on stripe_account_status === 'active'), or
  // it will confidently point at a control that isn't there.
  const [stripeActive, setStripeActive] = useState(null); // null = unknown

  async function load() {
    if (!org?.id) return;
    setError("");
    const [wRes, pRes, sRes] = await Promise.all([
      supabase
        .from("waivers")
        .select("id, name, content, required, active, version, updated_at")
        .eq("organization_id", org.id)
        .order("required", { ascending: false })
        .order("name"),
      // Admin reads ALL rows including hidden drafts (published = false), and
      // keys each card on the flag. The public readers filter published = true.
      supabase
        .from("org_policies")
        .select("id, policy_type, content_markdown, effective_date, last_updated, published")
        .eq("organization_id", org.id),
      supabase
        .from("organizations")
        .select("stripe_account_status")
        .eq("id", org.id)
        .maybeSingle(),
    ]);
    if (wRes.error) { setError(wRes.error.message); return; }
    // Three states, and a missing row is NOT the same as "hasn't connected".
    // `?.` on an absent row would quietly collapse unknown into false and tell
    // an operator who is already taking money to go connect Stripe.
    setStripeActive(
      sRes.error || !sRes.data ? null : sRes.data.stripe_account_status === "active",
    );
    setWaivers(wRes.data ?? []);
    // Policies are secondary — a failure here shouldn't blank the waivers list.
    // But it must NOT render as "Not published" either: that reads as a settled
    // fact when we simply don't know. Track the failure and say so.
    setPoliciesError(pRes.error ? (pRes.error.message ?? "Couldn't load your policies.") : "");
    setPolicies(pRes.error ? [] : (pRes.data ?? []));
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [org?.id]);

  const activeCount = useMemo(() => (waivers ?? []).filter((w) => w.active).length, [waivers]);
  const retiredCount = useMemo(() => (waivers ?? []).filter((w) => !w.active).length, [waivers]);
  // Documents taken out of registration stay in the database (a signature has to
  // keep pointing at the thing that was signed) but are out of the way by
  // default.
  const [showRetired, setShowRetired] = useState(false);

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
    flash(
      field === "active"
        ? (!w.active ? `${w.name} is back in your registration form.` : `${w.name} removed from your registration form.`)
        : (!w.required ? `Families must now agree to ${w.name}.` : `Families can now decline ${w.name}.`),
    );
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
          // Saving always (re)publishes. Without this, editing a hidden draft
          // would keep published = false on the conflict update and the "Publish"
          // button would silently save-but-not-publish.
          published: true,
          // These are now the OPERATOR'S words, whatever they started as. This
          // is what stops the "we published a policy under your name" notice
          // from greeting someone who is looking at a policy they wrote
          // themselves. It must be set on the upsert rather than only on the
          // insert: the row usually already exists (seeded at provisioning), so
          // the conflict UPDATE is the path that actually runs.
          seeded_by_platform: false,
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

  // Soft-unpublish: hide from families but KEEP the text as a draft, so "publish
  // again" is one click and the promise in the confirm dialog is actually true.
  async function unpublishPolicy(row, label) {
    if (busy) return;
    if (!window.confirm(`Unpublish your ${label}? Families will no longer see it and the link will disappear from your site footer. Your text is kept as a draft — you can publish it again anytime.`)) return;
    setBusy(true); setError("");
    try {
      const { error: e } = await supabase.from("org_policies")
        .update({ published: false, last_updated: new Date().toISOString() })
        .eq("id", row.id);
      if (e) throw e;
      await load();
      flash(`${label} unpublished — saved as a draft.`);
    } catch (e) {
      setError(e.message ?? "Couldn't unpublish that policy.");
    } finally {
      setBusy(false);
    }
  }

  // Re-publish a hidden draft in one click, no re-paste. Uses the same UPDATE
  // policy as unpublish.
  async function republishPolicy(row, label) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { error: e } = await supabase.from("org_policies")
        .update({ published: true, last_updated: new Date().toISOString() })
        .eq("id", row.id);
      if (e) throw e;
      await load();
      flash(`${label} published — families can read it now.`);
    } catch (e) {
      setError(e.message ?? "Couldn't publish that policy.");
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
          Families read and sign these when they register. Ones marked <strong>Must agree</strong> have
          to be accepted to enroll; a family can register without accepting the rest.
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
          {/* Only what's actually in use. Anything taken out of registration —
              including documents an earlier version of the platform created —
              lives behind the toggle at the bottom instead of padding the list
              with names nobody recognises. */}
          {waivers.filter((w) => w.active || showRetired).map((w) => (
            <div key={w.id} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px", opacity: w.active ? 1 : 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {w.name}
                    {/* State in the operator's terms, and only ONE of them.
                        A document that isn't part of registration can't also be
                        "Required" — showing both was the confusing bit. */}
                    {!w.active
                      ? <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Not in registration</Badge>
                      : w.required
                        ? <Badge bg="#fff7ed" border="#fed7aa" color="#9a3412">Must agree</Badge>
                        : <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Can decline</Badge>}
                  </div>
                  {/* The preview shows what a family will read, business name
                      filled in. The EDITOR below deliberately keeps the raw
                      {{org}} token — substituting there and saving would write
                      the name back into the stored text and re-freeze it. */}
                  <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED, lineHeight: 1.5, maxWidth: 560, maxHeight: 40, overflow: "hidden" }}>{renderWaiverText(w.content, org?.name)}</div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => openWaiverEditor(w)} style={ghostBtn(false)}>Edit</button>
                  {/* Two different decisions, said as decisions rather than as
                      states: whether families have to accept it, and whether it
                      appears at all. "Archive" read like filing something away;
                      what an operator is actually doing is taking it out of
                      their registration form. */}
                  {w.active && (
                    <button type="button" onClick={() => toggle(w, "required")} style={ghostBtn(false)}>
                      {w.required ? "Let families decline" : "Require agreement"}
                    </button>
                  )}
                  <button type="button" onClick={() => toggle(w, "active")} style={ghostBtn(false)}>
                    {w.active ? "Remove from registration" : "Add back"}
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12, color: MUTED, marginTop: 2 }}>
            <span>
              {activeCount === 1 ? "1 waiver" : `${activeCount} waivers`} in your registration form.
            </span>
            {retiredCount > 0 && (
              <button
                type="button"
                onClick={() => setShowRetired((v) => !v)}
                style={{ background: "none", border: "none", color: BRIGHT, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, textDecoration: "underline" }}
              >
                {showRetired ? "Hide" : `Show ${retiredCount} not in use`}
              </button>
            )}
          </div>
        </div>
      )}

      <h2 style={{ margin: "36px 0 0", fontSize: 17, fontWeight: 700, color: INK }}>Policies you publish</h2>
      <p style={{ color: MUTED, fontSize: 13.5, margin: "4px 0 0", lineHeight: 1.5, maxWidth: 620 }}>
        Your own privacy policy and terms, shown on your registration site. Until you publish one,
        its link stays off your site footer and anyone who visits the page is told you haven&rsquo;t
        published one yet — families are never shown another provider&rsquo;s policy.
      </p>
      {/* Publishing reads as one-way unless you say otherwise, so people either
          stall on it or avoid it. It's editable forever, and this page is always
          a click away in Settings. */}
      <p style={{ color: MUTED, fontSize: 13, margin: "8px 0 0", lineHeight: 1.5, maxWidth: 620 }}>
        Nothing here is final. You can edit and republish either one whenever you like, or skip
        them for now and come back — they live in <strong>Settings &rarr; Waivers &amp; policies</strong>.
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
          // Three states: never created (no row), live (row + published), and
          // hidden draft (row + !published — text saved but off the public site).
          const isLive = !!row && row.published;
          const isDraft = !!row && !row.published;
          return (
            <div key={kind.type} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {kind.label}
                    {policiesError
                      ? <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Unknown</Badge>
                      : isLive
                        ? <Badge bg={GREEN_BG} border="#bbf7d0" color={GREEN_INK}>Published</Badge>
                        : isDraft
                          ? <Badge bg="#fff7ed" border="#fed7aa" color="#9a3412">Draft — not shown to families</Badge>
                          : <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Not published</Badge>}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED, lineHeight: 1.5, maxWidth: 560 }}>
                    {isLive ? (
                      <>
                        Last updated {formatStamp(row.last_updated)}
                        {row.effective_date ? ` · effective ${formatStamp(row.effective_date)}` : ""}
                        {" · "}
                        <a href={publicPath} target="_blank" rel="noreferrer" style={{ color: BRIGHT, textDecoration: "none" }}>
                          View public page ↗
                        </a>
                      </>
                    ) : isDraft ? (
                      <>Saved {formatStamp(row.last_updated)}, kept as a draft. Not shown on your site until you publish it.</>
                    ) : kind.blurb}
                  </div>
                  {/* Shown in every policy state, not just the empty one: an
                      operator who already published a policy is the most likely
                      to have never seen the admin fee setting.

                      Held back while stripeActive is null (still loading, or the
                      lookup failed). That is a THIRD state, and neither sentence
                      is true in it — guessing would either send them after a
                      control that isn't there or tell them to connect Stripe
                      they may already have connected. */}
                  {kind.hasAdminFeeNote && stripeActive !== null && (() => {
                    const note = adminFeeNote(stripeActive);
                    return (
                      <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED, lineHeight: 1.5, maxWidth: 560 }}>
                        {note.text}{" "}
                        <Link to={note.linkTo} style={{ color: BRIGHT, textDecoration: "none" }}>
                          {note.linkLabel}
                        </Link>{" "}
                        {note.after}
                      </div>
                    );
                  })()}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {isDraft && (
                    <button type="button" onClick={() => republishPolicy(row, kind.label)} disabled={busy} style={primaryBtn(busy)}>Publish</button>
                  )}
                  <button type="button" onClick={() => openPolicyEditor(kind, row)} style={row ? ghostBtn(false) : primaryBtn(false)}>
                    {row ? "Edit" : "Publish"}
                  </button>
                  {isLive && (
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
        {/* Explain the placeholder rather than hiding it. An operator who sees
            {{org}} in their own waiver and doesn't know what it is will
            "helpfully" type their business name over it — which is exactly the
            freezing this is meant to prevent. Only shown when it's actually
            there, so someone writing their own text never sees it. */}
        {hasOrgToken(content) && (
          <p style={{ margin: "0 0 8px", fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
            Leave <strong>{"{{org}}"}</strong> where it is — families see your business
            name there. Keeping it means your waivers update themselves if you ever
            change your business name.
          </p>
        )}
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
