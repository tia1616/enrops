// The cancellation & refund policy, shown to an operator at the moment they are
// setting up what families will see.
//
// WHY THIS EXISTS. Provisioning seeds a `cancellation` policy with
// published = true and the operator's business name substituted into OUR
// wording. It renders at /{slug}/cancellation, links from the public footer,
// and families read it before they pay. It makes specific promises about money,
// in their name, and until this existed nothing in the product showed it to them.
//
// WHY IT IS NOT ITS OWN CARD IN THE LEAN BUILDER. It first replaced an admin-shell
// banner, then sat in its own bordered block under the waivers - which still read
// as a separate announcement bolted beneath the thing it belongs to. It is now
// folded into the SAME box that lists the waivers, named and bolded exactly like
// them, because from the operator's side it is one question: what do families
// see? (Jessica, 2026-07-30.) QuickProgramBuilder composes it that way from the
// pieces below; ProgramWizardNew has no waiver box, so it keeps the standalone
// block at the bottom of this file.
//
// EVERY SENTENCE IS DERIVED FROM DATA, NOT FROM THE CALL SITE. An earlier version
// took a `where` prop and asserted authorship unconditionally, reintroducing two
// bugs the shell notice had already fixed. A component that ASSERTS A FACT about
// a tenant must read that fact itself; a caller may narrow a claim, never widen
// one. That is why the copy lives in `cancellationCopy` rather than at the two
// call sites - two hosts render this, and the wording must not drift.

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "../lib/supabase";
import { PolicyOrgName } from "./OrgNameInText.jsx";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

// The name the operator already knows this document by. Matches the heading on
// /admin/waivers exactly - a document called one thing here and another there
// reads as two documents.
export const CANCELLATION_POLICY_LABEL = "Cancellation & Refund Policy";

/**
 * Loads the org's cancellation policy. One hook so both hosts fetch it the same
 * way and neither re-derives what "published" means.
 *
 * Returns `failed` separately from `policy`, because a read error is NOT the
 * same as "there is nothing to disclose" - collapsing the two let a transient
 * error silently hide the disclosure for the life of the mount.
 */
export function useCancellationPolicy(orgId) {
  const [policy, setPolicy] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("org_policies")
        // seeded_by_platform decides whether we may claim we wrote this. It is
        // NOT NULL DEFAULT false, and saving your own wording in WaiverManager
        // clears it - so it is the only honest source for the authorship line.
        .select("content_markdown, published, seeded_by_platform")
        .eq("organization_id", orgId)
        .eq("policy_type", "cancellation")
        // org_policies is UNIQUE (organization_id, policy_type).
        .maybeSingle();
      if (cancelled) return;
      if (error) { setFailed(true); return; }
      setFailed(false);
      setPolicy(data ?? null);
    })();
    return () => { cancelled = true; };
  }, [orgId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // An unpublished policy is not on the public page and an empty one has no
  // promise in it to disclose - in both states every sentence would be a lie,
  // and the honest answer is to say nothing. Normalising to null here means
  // neither host has to remember that rule.
  const usable =
    policy?.published && policy.content_markdown?.trim() ? policy : null;

  return { policy: usable, failed, retry };
}

/**
 * The two facts this component is allowed to state, in one place so the two
 * hosts cannot drift.
 *
 * @param usesEnropsRegistration  `organizations.uses_enrops_registration`.
 *        `=== true`, never `!== false`: anything unknown falls back to the
 *        public-page wording, which is true in BOTH states - less specific,
 *        never wrong.
 * @param programRunsOwnRegistration  the program being built is partner-run, so
 *        it has no Enrops payment step even if the org uses Enrops registration
 *        elsewhere. Narrows only.
 */
export function cancellationCopy({ usesEnropsRegistration, programRunsOwnRegistration = false }) {
  // Two prospects on prod (Mrs. Richelle, Shoreview Chess) have
  // uses_enrops_registration = false: they have no Enrops checkout, so "before
  // they pay" describes a screen their families never see. That is the bug
  // 20260728s was written to fix.
  const meetsAtCheckout =
    usesEnropsRegistration === true && !programRunsOwnRegistration;
  return {
    meetsAtCheckout,
    // Standalone sentence, split around the document's NAME so the host can
    // draw it bold - the same weight the waiver names get, because it is the
    // same kind of thing. Returned as parts rather than one string: a caller
    // cannot bold a word in the middle of a sentence it was handed whole.
    leadPrefix: meetsAtCheckout ? "Families also read your " : "Your ",
    // Same sentence with nothing before it. "also" is a lie when the policy is
    // the only thing named, which happens the moment an operator deactivates
    // their last waiver.
    leadPrefixAlone: meetsAtCheckout ? "Families read your " : "Your ",
    leadSuffix: meetsAtCheckout
      ? " on the payment step, before they pay."
      : " is published on your public page, where any family can read it.",
  };
}

/**
 * Who wrote it. TRUE claims OUR authorship; FALSE deliberately claims NOTHING
 * about who wrote it, because the flag does not mean "they wrote it": the
 * 2026-07-30 sweep cleared it for every existing tenant at once, so orgs still
 * carrying our untouched template read false too. "This is your own wording"
 * would be exactly as wrong for them as the old unconditional sentence was for
 * J2S. The second branch says the part that is true whoever wrote it.
 *
 * Neither branch tells them where to change it - the host card says that once,
 * prominently, for the waivers and the policy together.
 */
export function cancellationAuthorship(policy) {
  return policy?.seeded_by_platform
    ? "We wrote a starter version so your page wasn’t missing one — these are our words, not yours, and they make promises about refunds."
    : "It makes promises about refunds in your name.";
}

/**
 * The policy text itself, rendered as markdown with the business name bolded.
 * Used inside whichever expander the host already has.
 */
export function CancellationPolicyBody({ policy, orgName, fontSize = 12 }) {
  if (!policy) return null;
  const heading = { fontSize: 13, fontWeight: 700, color: INK, margin: "10px 0 2px" };
  return (
    <div
      style={{
        maxHeight: 200, overflowY: "auto", border: `1px solid ${RULE}`,
        borderRadius: 8, background: "#fff", padding: 10,
        fontSize, color: MUTED, lineHeight: 1.6,
      }}
    >
      {/* Markdown, not pre-wrapped text: the seeded template is plain prose but
          an operator who rewrites it can use headings and lists, and pre-wrap
          would show them raw "##".

          EVERY handler destructures `node` out. react-markdown v10 sets
          passNode: true unconditionally, so a bare {...props} spread puts
          node="[object Object]" on a real DOM element. */}
      <ReactMarkdown
        components={{
          h1: ({ node, ...p }) => <div style={heading} {...p} />,
          h2: ({ node, ...p }) => <div style={heading} {...p} />,
          h3: ({ node, ...p }) => <div style={{ ...heading, fontSize }} {...p} />,
          p: ({ node, children, ...p }) => (
            <p style={{ margin: "8px 0 0" }} {...p}>
              <PolicyOrgName orgName={orgName}>{children}</PolicyOrgName>
            </p>
          ),
          ul: ({ node, ...p }) => <ul style={{ margin: "8px 0 0", paddingLeft: 20 }} {...p} />,
          ol: ({ node, ...p }) => <ol style={{ margin: "8px 0 0", paddingLeft: 20 }} {...p} />,
          li: ({ node, children, ...p }) => (
            <li style={{ margin: "4px 0 0" }} {...p}>
              <PolicyOrgName orgName={orgName}>{children}</PolicyOrgName>
            </li>
          ),
          strong: ({ node, ...p }) => <strong style={{ fontWeight: 700, color: INK }} {...p} />,
          em: ({ node, ...p }) => <em {...p} />,
          // A link inside a policy leaves the admin shell; never navigate an
          // operator out of a half-built program.
          a: ({ node, ...p }) => <a style={{ color: BRIGHT }} target="_blank" rel="noopener noreferrer" {...p} />,
        }}
      >
        {policy.content_markdown}
      </ReactMarkdown>
    </div>
  );
}

/** Shared by both hosts so a failed read never looks like "nothing to say". */
export function CancellationPolicyLoadError({ onRetry, fontSize = 12.5 }) {
  return (
    <div style={{ fontSize, color: MUTED, lineHeight: 1.5 }}>
      We couldn&rsquo;t load your cancellation &amp; refund policy just now.{" "}
      <button
        type="button"
        onClick={onRetry}
        style={{ background: "none", border: "none", color: BRIGHT, fontSize, fontWeight: 600, cursor: "pointer", padding: 0, textDecoration: "underline" }}
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Standalone block - for a host with no waiver box to fold into
 * (ProgramWizardNew). QuickProgramBuilder composes the pieces above instead.
 */
export default function CancellationPolicyInline({
  orgId,
  orgName,
  usesEnropsRegistration,
  programRunsOwnRegistration = false,
  editHref,
  dense = false,
}) {
  const { policy, failed, retry } = useCancellationPolicy(orgId);
  const [open, setOpen] = useState(false);

  const body = dense ? 12.5 : 13;
  const small = dense ? 12 : 12.5;

  if (failed) {
    return (
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}` }}>
        <CancellationPolicyLoadError onRetry={retry} fontSize={small} />
      </div>
    );
  }
  if (!policy) return null;

  const { leadPrefix, leadSuffix } = cancellationCopy({
    usesEnropsRegistration,
    programRunsOwnRegistration,
  });

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}` }}>
      <div style={{ fontSize: body, color: INK, lineHeight: 1.6 }}>
        {leadPrefix}
        <strong>{CANCELLATION_POLICY_LABEL}</strong>
        {leadSuffix}
      </div>
      <div style={{ fontSize: small, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
        {cancellationAuthorship(policy)}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          marginTop: 6, background: "none", border: "none", color: BRIGHT,
          fontSize: body, fontWeight: 600, cursor: "pointer", padding: 0,
          textDecoration: "underline",
        }}
      >
        {open ? "Hide the wording" : "Read the wording"}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <CancellationPolicyBody policy={policy} orgName={orgName} fontSize={small} />
        </div>
      )}
      {/* Prominent, not muted: "can I change this?" is the question the whole
          block provokes, and it was previously answered in grey 12px. */}
      <div style={{ marginTop: 8, fontSize: small, color: INK, fontWeight: 600, lineHeight: 1.5 }}>
        You can change this any time in Settings, under Waivers &amp; policies.
        {editHref && (
          <>
            {" "}
            <a
              href={editHref}
              target="_blank"
              rel="noreferrer"
              style={{ color: BRIGHT, textDecoration: "none", fontWeight: 600 }}
            >
              Edit the policy &#8599;
            </a>
          </>
        )}
      </div>
    </div>
  );
}
