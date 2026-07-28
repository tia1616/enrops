// StarterPolicyNotice — tells an operator that a cancellation & refund policy is
// published PUBLICLY under their business name, and shows them the actual words.
//
// WHY THIS EXISTS. Provisioning seeds a `cancellation` policy with
// published = true (migrations 20260728j/k), and 20260728o backfilled one to
// every org that already existed. It renders at /{slug}/cancellation, links from
// the public footer, and families read it on the pay step before they pay. The
// wording is OURS with their business name substituted in, and it promises
// specific things about money. Until this component existed, nothing anywhere
// told the operator that had happened — the only mention was a code comment.
//
// WHY IT SHOWS THE TEXT RATHER THAN LINKING TO IT. A banner saying "a policy is
// live" that they dismiss without reading discharges nothing; the whole problem
// is that a refund promise was made on their behalf, so the promise itself is
// what has to be on screen. Both buttons acknowledge — the duty is discharged by
// being SHOWN the wording, not by agreeing with it.
//
// WHY IT DOES NOT UNPUBLISH. v4 section 6 requires a family to see a
// cancellation policy BEFORE paying, and an unpublished policy shows nothing.
// The policy stays live throughout; this is disclosure, not a gate.
//
// Lives in the admin shell (AdminLayout) rather than on the dashboard: lean
// registration-only tenants with at least one program never land on /admin at
// all (AdminOverview redirects them to /admin/programs), and those are exactly
// the self-serve operators this is about. A notice they never see is the same
// bug as no notice.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { supabase } from "../lib/supabase";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#3a3340";
const MUTED = "#6b6b6b";
const BG = "#F2F0FF";
const BORDER = "#cfc8f5";

export default function StarterPolicyNotice({ org }) {
  const navigate = useNavigate();
  const [notice, setNotice] = useState(null); // null = nothing owed / not loaded yet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      // The DATABASE decides whether this is owed, not the browser. Fetching the
      // policy, the platform template and the acknowledgement row and comparing
      // them here would re-derive the rule in a second language — which is how a
      // screen ends up disagreeing with the database about what an operator has
      // actually been told.
      const { data, error: err } = await supabase.rpc("starter_policy_notice", { p_org_id: org.id });
      if (!mounted) return;
      // Fail CLOSED on a read error: showing a consent notice we couldn't verify
      // is owed would tell an operator who wrote their own policy that we
      // published one for them, which is simply false.
      if (err || !data?.needs_notice) return;
      setNotice(data);
    })();
    return () => { mounted = false; };
  }, [org?.id]);

  const acknowledge = useCallback(async (response) => {
    setBusy(true);
    setError("");
    const { error: err } = await supabase.rpc("acknowledge_starter_policy", {
      p_org_id: org.id,
      p_response: response,
    });
    setBusy(false);
    if (err) {
      setError(err.message || "That didn't save.");
      return false;
    }
    return true;
  }, [org?.id]);

  async function handleAccept() {
    if (busy) return;
    const ok = await acknowledge("accepted");
    // Only dismiss on a CONFIRMED write. Hiding the card on a failed
    // acknowledgement would leave us believing this operator had been told when
    // no record of it exists — the exact failure this whole feature is fixing.
    if (ok) setNotice(null);
  }

  async function handleEdit() {
    if (busy) return;
    const ok = await acknowledge("editing");
    // Navigate either way — they asked to go edit it, and refusing to move
    // because a bookkeeping write failed would be punishing them for our
    // problem. But only HIDE the card when the write landed: dismissing it on
    // failure would swallow the error message with it, and the destination is
    // the page this card is already on, so leaving it up costs nothing and
    // keeps the failure visible right where they clicked.
    if (ok) setNotice(null);
    navigate("/admin/waivers");
  }

  if (!notice) return null;

  const waivers = notice.active_waiver_count ?? 0;

  return (
    <div
      role="status"
      style={{
        background: BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: "18px 20px",
        marginBottom: 22,
        fontFamily: "'Poppins', system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700, color: PURPLE }}>
        A cancellation &amp; refund policy is live under your business name
      </div>
      <p style={{ fontSize: 13.5, color: INK, lineHeight: 1.55, margin: "6px 0 0", maxWidth: 680 }}>
        Families read this on the payment step before they pay. We published a starter version so
        your checkout wasn&rsquo;t missing one &mdash; these are our words, not yours, and they make
        promises about refunds. Read them below and change anything you don&rsquo;t agree with.
      </p>

      <div
        style={{
          marginTop: 14,
          background: "#fff",
          border: `1px solid ${BORDER}`,
          borderRadius: 10,
          padding: "14px 16px",
          maxHeight: 260,
          overflowY: "auto",
          fontSize: 13.5,
          color: INK,
          lineHeight: 1.6,
        }}
      >
        <ReactMarkdown
          components={{
            // The stored text opens with a `##` heading; keep it, but sized for a
            // card rather than a full page.
            h1: ({ node, ...props }) => <div style={{ fontSize: 14.5, fontWeight: 700, color: PURPLE, margin: "0 0 6px" }} {...props} />,
            h2: ({ node, ...props }) => <div style={{ fontSize: 14.5, fontWeight: 700, color: PURPLE, margin: "0 0 6px" }} {...props} />,
            h3: ({ node, ...props }) => <div style={{ fontSize: 13.5, fontWeight: 700, color: PURPLE, margin: "12px 0 4px" }} {...props} />,
            p: ({ node, children, ...props }) => (
              <p style={{ margin: "8px 0 0" }} {...props}>{boldOrgName(children, org?.name)}</p>
            ),
            ul: ({ node, ...props }) => <ul style={{ margin: "8px 0 0", paddingLeft: 20 }} {...props} />,
            li: ({ node, children, ...props }) => (
              <li style={{ margin: "4px 0 0" }} {...props}>{boldOrgName(children, org?.name)}</li>
            ),
            strong: ({ node, ...props }) => <strong style={{ fontWeight: 700, color: PURPLE }} {...props} />,
            // Links inside a policy open away from the admin shell.
            a: ({ node, ...props }) => <a style={{ color: BRIGHT }} target="_blank" rel="noopener noreferrer" {...props} />,
          }}
        >
          {notice.content_markdown || ""}
        </ReactMarkdown>
      </div>

      <p style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.55, margin: "10px 0 0" }}>
        This is the page families can open at{" "}
        <a href={notice.public_path} target="_blank" rel="noopener noreferrer" style={{ color: BRIGHT, textDecoration: "none" }}>
          {notice.public_path} &#8599;
        </a>
        {/* Stated as a plain count of what families sign, because that is true
            whoever wrote them. "We added 4 waivers for you" would be false for a
            tenant who wrote their own. */}
        {waivers > 0 && (
          <> &middot; your registration form also includes {waivers} {waivers === 1 ? "waiver" : "waivers"} families sign, on the same page.</>
        )}
      </p>

      {/* Both controls and any failure sit together at the bottom of the card,
          where the click happens — an error rendered at the top of the page would
          be behind the operator's eyeline and read as a dead button. */}
      {error && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            color: "#991b1b",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          We couldn&rsquo;t record that just now, so this notice will come back. Your policy is
          unchanged either way. ({error})
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
        <button type="button" onClick={handleAccept} disabled={busy} style={primaryBtn(busy)}>
          {busy ? "Saving…" : "This works for me"}
        </button>
        <button type="button" onClick={handleEdit} disabled={busy} style={ghostBtn(busy)}>
          Edit it now
        </button>
      </div>
    </div>
  );
}

// Draw the operator's business name bold wherever it appears in the policy, so
// the point lands without being argued: this is THEIR document, with THEIR name
// on it, promising THEIR families a refund.
//
// Done on the RENDERED children rather than by rewriting the markdown source.
// Wrapping the name in ** before parsing looks like one line of code, but a
// business name containing *, _, [ or ` would corrupt the document, and the
// operators most likely to hit that are the ones with punctuation in their name
// - exactly the people this is meant to reassure. Working on the output means
// the source is never touched and nothing can be mis-parsed.
function boldOrgName(children, name) {
  if (!name) return children;
  const arr = Array.isArray(children) ? children : [children];
  return arr.map((child, ci) => {
    if (typeof child !== "string" || !child.includes(name)) return child;
    const parts = child.split(name);
    return parts.map((part, i) => (
      <span key={`${ci}-${i}`}>
        {i > 0 && <strong style={{ color: PURPLE, fontWeight: 700 }}>{name}</strong>}
        {part}
      </span>
    ));
  });
}

function primaryBtn(disabled) {
  return {
    padding: "9px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8,
    fontSize: 13, fontWeight: 600, fontFamily: "inherit",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
function ghostBtn(disabled) {
  return {
    padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`,
    borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
