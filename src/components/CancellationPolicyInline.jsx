// CancellationPolicyInline - shows an operator the cancellation & refund policy
// that is published publicly under their business name, at the moment they are
// setting up what families will see.
//
// WHY THIS EXISTS. Provisioning seeds a `cancellation` policy with
// published = true and the operator's business name substituted into OUR
// wording. It renders at /{slug}/cancellation, links from the public footer,
// and families read it before they pay. It makes specific promises about money,
// in their name, and until now nothing in the product ever showed it to them.
//
// WHY HERE RATHER THAN A BANNER. This replaced a notice card mounted in the
// admin shell, which appeared on top of every admin page and read as an
// interruption disconnected from anything the operator was doing (Jessica,
// 2026-07-30). Program setup is the honest moment: they are already being shown
// the waivers families sign, so showing the rest of what families see belongs in
// the same card rather than in a banner that ambushes them later.
//
// EVERY SENTENCE HERE IS DERIVED FROM DATA, NOT FROM THE CALL SITE. The first
// version of this component took a `where` prop and stated authorship
// unconditionally, which reintroduced two bugs the shell notice had already
// fixed (see the two blocks below). The rule that came out of it: a component
// that ASSERTS A FACT about a tenant must read that fact itself. A caller may
// narrow a claim it knows to be inapplicable, never widen one.
//
// NO ACKNOWLEDGEMENT. Nothing is recorded and nothing is gated. This is one of
// the things you are being shown while you set up, next to the waivers, which is
// exactly the weight it should carry.

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "../lib/supabase";
import { splitOnWholeName } from "../lib/waiverText.js";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

/**
 * @param {string}  orgId    organisation whose policy to show
 * @param {string}  orgName  business name, for bolding inside the wording
 * @param {boolean} usesEnropsRegistration
 *        `organizations.uses_enrops_registration` for THIS org, passed from the
 *        already-loaded org row (AdminLayout selects it). NOT a literal - see
 *        the checkout-wording note below.
 * @param {boolean} programRunsOwnRegistration
 *        `runs_own_registration` for the program being built. A tenant can use
 *        Enrops registration in general and still hand THIS program to a
 *        partner, so the caller may narrow the claim even when the org flag is
 *        true. It can only ever make the wording weaker.
 * @param {string}  editHref  optional; when set, renders a link that opens the
 *        editor in a NEW TAB. Omit it inside a flow that must not be
 *        interrupted, where a sentence is the right answer instead.
 * @param {boolean} dense     tighter type, for nesting inside an existing panel
 */
export default function CancellationPolicyInline({
  orgId,
  orgName,
  usesEnropsRegistration,
  programRunsOwnRegistration = false,
  editHref,
  dense = false,
}) {
  const [policy, setPolicy] = useState(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // Bumping this re-runs the load. A disclosure that silently isn't there is
  // the same bug as no disclosure, so a failed read has to be recoverable
  // without a full page reload.
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

  const body = dense ? 12.5 : 13;
  const small = dense ? 12 : 12.5;

  // A read failure is NOT the same as "there is nothing to disclose", and
  // rendering null for both was how a transient error could let an operator
  // finish setup never having been shown the promise made in their name. Say
  // so, next to where they are looking, with a way out.
  if (failed) {
    return (
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}`, fontSize: small, color: MUTED, lineHeight: 1.5 }}>
        We couldn&rsquo;t load your cancellation &amp; refund policy just now.{" "}
        <button
          type="button"
          onClick={retry}
          style={{ background: "none", border: "none", color: BRIGHT, fontSize: small, fontWeight: 600, cursor: "pointer", padding: 0, textDecoration: "underline" }}
        >
          Try again
        </button>
      </div>
    );
  }

  // Say nothing rather than something untrue. An unpublished policy is not on
  // the public page, and an empty one has no promise in it to disclose - in
  // both states every sentence below would be a lie, and the honest UI is
  // absence. This is also the pre-fetch state, so nothing flashes on load.
  if (!policy?.published || !policy.content_markdown?.trim()) return null;

  // WHERE FAMILIES ACTUALLY MEET THIS, read from the org row rather than
  // asserted by the caller. Two prospects on prod (Mrs. Richelle, Shoreview
  // Chess) have uses_enrops_registration = false: they have no Enrops checkout,
  // so "before they pay" describes a screen their families never see. That is
  // the bug migration 20260728s was written to fix, and hardcoding this at the
  // call site reintroduced it.
  //
  // `=== true`, not `!== false`. Anything unknown falls back to the public-page
  // sentence, which is true in BOTH states - less specific, never wrong.
  const meetsAtCheckout =
    usesEnropsRegistration === true && !programRunsOwnRegistration;

  const lead = meetsAtCheckout
    ? "Families also read your cancellation & refund policy on the payment step, before they pay."
    : "Your cancellation & refund policy is published on your public page, where any family can read it.";

  // WHO WROTE IT. Claiming authorship of a document the operator wrote is the
  // opposite of the honesty this component exists for - J2S's own policy, which
  // Jessica pasted in herself, was being introduced with "these are our words,
  // not yours".
  //
  // TRUE only claims OUR authorship. FALSE deliberately claims NOTHING about
  // who wrote it, because the flag does not mean "they wrote it": the 2026-07-30
  // sweep cleared it for every existing tenant at once, so orgs still carrying
  // our untouched template read false too (verified: Riverbend and Cascade are
  // false while their text still matches the platform template character for
  // character, J2S and onboard-test are false having genuinely rewritten
  // theirs). Saying "this is your own wording" would be exactly as wrong for the
  // swept orgs as the old unconditional sentence was for J2S. The second branch
  // is therefore the part that is true whoever wrote it - and it is also the
  // part that matters, because it is the one that asks them to read it.
  const authorship = policy.seeded_by_platform
    ? "We wrote a starter version so your page wasn’t missing one — these are our words, not yours, and they make promises about refunds. Change anything you don’t agree with."
    : "It makes promises about refunds in your name. Change anything you don’t agree with.";

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${RULE}` }}>
      <div style={{ fontSize: body, color: INK, lineHeight: 1.6 }}>{lead}</div>
      {/* No "...in Settings, under Waivers & policies" tail here. Every host
          card already ends with that exact sentence for its waivers, and adding
          it again made the same instruction appear three times in one card.
          Where to edit is the host's job to say; this component's job is to say
          what the document IS. */}
      <div style={{ fontSize: small, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
        {authorship}
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
        <div
          style={{
            marginTop: 8, maxHeight: 200, overflowY: "auto",
            border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff",
            padding: 10, fontSize: small, color: MUTED, lineHeight: 1.6,
          }}
        >
          {/* Rendered as markdown, not as pre-wrapped text. The seeded template
              is plain prose, but an operator who rewrites it can use headings
              and lists, and pre-wrap would show them raw "##".

              EVERY handler destructures `node` out. react-markdown v10 sets
              passNode: true unconditionally, so a bare {...props} spread puts
              node="[object Object]" on a real DOM element. Same shape as
              PolicyPage.jsx. */}
          <ReactMarkdown
            components={{
              h1: ({ node, ...p }) => <div style={headingStyle} {...p} />,
              h2: ({ node, ...p }) => <div style={headingStyle} {...p} />,
              h3: ({ node, ...p }) => <div style={{ ...headingStyle, fontSize: small }} {...p} />,
              p: ({ node, children, ...p }) => (
                <p style={{ margin: "8px 0 0" }} {...p}>{boldOrgName(children, orgName)}</p>
              ),
              ul: ({ node, ...p }) => <ul style={{ margin: "8px 0 0", paddingLeft: 20 }} {...p} />,
              ol: ({ node, ...p }) => <ol style={{ margin: "8px 0 0", paddingLeft: 20 }} {...p} />,
              li: ({ node, children, ...p }) => (
                <li style={{ margin: "4px 0 0" }} {...p}>{boldOrgName(children, orgName)}</li>
              ),
              strong: ({ node, ...p }) => <strong style={{ fontWeight: 700, color: INK }} {...p} />,
              em: ({ node, ...p }) => <em {...p} />,
              // A link inside a policy leaves the admin shell; never navigate
              // an operator out of a half-built program.
              a: ({ node, ...p }) => <a style={{ color: BRIGHT }} target="_blank" rel="noopener noreferrer" {...p} />,
            }}
          >
            {policy.content_markdown}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

const headingStyle = { fontSize: 13, fontWeight: 700, color: INK, margin: "10px 0 2px" };

// Draw the operator's business name bold wherever it appears, so the point
// lands without being argued: this is THEIR document, with THEIR name on it,
// promising THEIR families a refund.
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
        {i > 0 && <strong style={{ color: INK, fontWeight: 700 }}>{name}</strong>}
        {part}
      </span>
    ));
  });
}
