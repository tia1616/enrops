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
import { useLocation, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { supabase } from "../lib/supabase";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#3a3340";
const MUTED = "#6b6b6b";
const BG = "#F2F0FF";
const BORDER = "#cfc8f5";

// Waivers & policies is the one admin page where this card is redundant: the
// cancellation policy is already listed there, published-badged, with Edit and
// Unpublish beside it. Showing the card on top of that made the same policy
// appear twice on one screen and read as though it lived in two places
// (Jessica, 2026-07-28).
//
// Suppressing it here is safe rather than a hole in the disclosure. The card
// still renders on every OTHER admin page, and nobody arrives at /admin/waivers
// first — a lean tenant lands on /admin/programs, everyone else on /admin — so
// the notice is always seen before this page is reached. "Edit it now" also
// lands here, having already recorded the acknowledgement on its way.
const SUPPRESS_ON = "/admin/waivers";

export default function StarterPolicyNotice({ org }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [notice, setNotice] = useState(null); // null = nothing owed / not loaded yet
  // Once the database says nothing is owed, that answer is permanent: an
  // acknowledgement is never deleted (the table has no DELETE policy) and
  // seeded_by_platform only ever goes true -> false. So we stop asking, and only
  // operators who genuinely still owe an acknowledgement keep revalidating.
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!org?.id || settled) return;
    let mounted = true;
    (async () => {
      // The DATABASE decides whether this is owed, not the browser. Fetching the
      // policy, the platform template and the acknowledgement row and comparing
      // them here would re-derive the rule in a second language — which is how a
      // screen ends up disagreeing with the database about what an operator has
      // actually been told.
      const { data, error: err } = await supabase.rpc("starter_policy_notice", { p_org_id: org.id });
      if (!mounted) return;
      // A read error is transient and says nothing about what is owed. Leave
      // whatever we already knew in place and re-ask on the next navigation
      // rather than inventing an answer in either direction.
      if (err) return;
      if (!data?.needs_notice) {
        // CLEARING THIS IS THE POINT. AdminLayout never unmounts, so `notice`
        // survives every in-app navigation. Before this, an operator who
        // replaced the policy with their own wording (which clears
        // seeded_by_platform) kept seeing the card on other pages, still showing
        // the OLD seeded text and still claiming we published it for them -
        // exactly the false statement this feature exists to prevent. It
        // self-corrected only on a full page reload, which is why every earlier
        // check missed it: they all reloaded.
        setNotice(null);
        setSettled(true);
        return;
      }
      setNotice(data);
    })();
    return () => { mounted = false; };
    // Revalidates on every admin navigation while an acknowledgement is still
    // outstanding. That is a cheap STABLE call, it stops the moment the operator
    // acts, and the alternative is trusting state that the database can
    // contradict at any time.
  }, [org?.id, location.pathname, settled]);

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
    if (!ok) return;
    setNotice(null);
    setSettled(true);
  }

  async function handleEdit() {
    if (busy) return;
    const ok = await acknowledge("editing");
    // STAY PUT ON FAILURE. Navigating anyway used to mean the error message
    // travelled to a page where the card is suppressed, so it vanished on
    // arrival and the operator was told nothing. Keeping them here shows the
    // failure directly under the button they pressed, and they can press it
    // again. Getting this right also removed the reason the suppression below
    // needed an `error` exception — which was itself sticky for the whole
    // session, because `error` only ever cleared on the next attempt.
    if (!ok) return;
    setNotice(null);
    setSettled(true);
    navigate("/admin/waivers");
  }

  if (!notice) return null;
  // Unconditional now. It used to carry an `&& !error` exception so that a
  // failed acknowledgement arriving here still showed its message — but that
  // state never cleared, so a single network blip restored the duplicate card
  // on this page for the rest of the session, complete with a stale error on a
  // page the operator had not clicked anything on. handleEdit no longer
  // navigates on failure, so there is nothing left to rescue here.
  if (location.pathname === SUPPRESS_ON) return null;

  const waivers = notice.active_waiver_count ?? 0;
  // Where the promise actually reaches a family. A tenant who brings their own
  // registration has no Enrops checkout and no Enrops registration form, so both
  // of those sentences would be false for them — and two of the real prospects
  // on prod are in exactly that state. What stays true either way is that the
  // policy is published publicly under their business name, which is the part
  // that made this notice necessary in the first place.
  //
  // Read from the RPC, not from the browser's `org`, so the sentence and the
  // fact it rests on come from the same place.
  //
  // `=== true`, NOT `!== false`. The key only exists once 20260728s is applied,
  // and this frontend can reach an environment where 20260728p has landed but s
  // has not - the file ships with git, the migrations do not. With `!== false`,
  // an absent key reads as undefined, undefined !== false is TRUE, and every
  // operator silently gets the "families read this at checkout" wording again -
  // reintroducing the exact bug this branch was added to fix, invisibly, on
  // somebody else's deploy timing.
  //
  // Failing to the public-page wording instead is safe because that sentence is
  // true in BOTH states: the policy really is published publicly under their
  // name either way. It is less specific, never wrong.
  const usesEnropsRegistration = notice.uses_enrops_registration === true;

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
      {/* Only the FIRST sentence differs. The rest — that the wording is ours,
          that it promises money, and that they can change it — is the whole
          point of the notice and is identical in both states, so it is written
          once here rather than duplicated into two branches that could drift. */}
      <p style={{ fontSize: 13.5, color: INK, lineHeight: 1.55, margin: "6px 0 0", maxWidth: 680 }}>
        {usesEnropsRegistration
          ? "Families read this on the payment step before they pay."
          : "It’s published on your public page, where any family can read it."}{" "}
        We published a starter version so your page wasn&rsquo;t missing one &mdash; these are our
        words, not yours, and they make promises about refunds. Read them below and change anything
        you don&rsquo;t agree with.
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
        {/* A plain count, because that is true whoever wrote them — "we added 4
            waivers for you" would be false for a tenant who wrote their own.
            The claim about WHERE they are shown is separate: a tenant who brings
            their own registration has no Enrops registration form to put them
            in, so they are only told the waivers exist and where to find them. */}
        {waivers > 0 && (
          usesEnropsRegistration ? (
            <> &middot; your registration form also includes {waivers} {waivers === 1 ? "waiver" : "waivers"} families sign, on the same page.</>
          ) : (
            <> &middot; you also have {waivers} {waivers === 1 ? "waiver" : "waivers"} on the same page.</>
          )
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
    const parts = splitOnWholeName(child, name);
    if (parts.length === 1) return child; // only substring hits, nothing to bold
    return parts.map((part, i) => (
      <span key={`${ci}-${i}`}>
        {i > 0 && <strong style={{ color: PURPLE, fontWeight: 700 }}>{name}</strong>}
        {part}
      </span>
    ));
  });
}

// Split text on STANDALONE occurrences of the business name, returning the
// segments between them (length = occurrences + 1, same contract as
// splitOnOrgToken).
//
// A plain String.split(name) bolds any substring hit, so an operator called
// "Play" would see the fragment lit up inside "Playgrounds" — a rendering
// glitch on the one screen whose job is to make the document feel carefully
// theirs. Business names are operator-supplied free text, so short ones are a
// matter of time.
//
// Boundaries are checked by inspecting the neighbouring characters rather than
// with a \b regex: the name is untrusted text that would have to be escaped,
// and \b is defined against word characters, so it behaves wrongly for a name
// that begins or ends with punctuation ("Mrs. Richelle", "Acme Inc."). Matching
// is case-sensitive on purpose — the stored policy carries the name exactly as
// substituted, and loosening it would bold unrelated words.
function splitOnWholeName(text, name) {
  const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  const parts = [];
  let segmentStart = 0; // start of the plain text run being accumulated
  let searchFrom = 0;   // independent cursor, so a rejected hit still advances
  for (;;) {
    const at = text.indexOf(name, searchFrom);
    if (at === -1) break;
    const standalone =
      !isWordChar(text[at - 1]) && !isWordChar(text[at + name.length]);
    if (standalone) {
      parts.push(text.slice(segmentStart, at));
      segmentStart = at + name.length;
    }
    searchFrom = at + name.length;
  }
  parts.push(text.slice(segmentStart));
  return parts;
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
