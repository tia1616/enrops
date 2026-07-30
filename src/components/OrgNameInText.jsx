// Draw the operator's business name bold inside a document they are reviewing,
// so a page of boilerplate reads at a glance as THEIR document - already
// personalised - rather than a generic template we handed them.
//
// Bold only on the operator's REVIEW surfaces (the waivers page, the program
// builder). The text a family reads and signs still renders through
// renderWaiverText as a plain string, and waiver_text_snapshot - the record of
// what was actually agreed to - must never contain markup.
//
// TWO STORAGE SHAPES, TWO COMPONENTS. Waivers keep the {{org}} TOKEN and
// substitute at render; org_policies store the name ALREADY substituted (see
// lib/waiverText.js). Using the wrong one is silent - it simply never bolds -
// so they are named for what they read rather than for where they are used.

import { splitOnOrgToken, splitOnWholeName } from "../lib/waiverText.js";

const INK = "#1a1a1a";

function Name({ children }) {
  return <strong style={{ color: INK, fontWeight: 700 }}>{children}</strong>;
}

/**
 * WAIVER content - splits on the {{org}} token.
 *
 * Falls back to the same wording renderWaiverText uses: a legal document must
 * never show a raw token to anyone, and it must never borrow another
 * provider's name.
 */
export function WaiverOrgName({ content, orgName }) {
  const name = typeof orgName === "string" ? orgName.trim() : "";
  const shown = name || "the program provider";
  const segments = splitOnOrgToken(content);
  return (
    <>
      {segments.map((seg, i) => (
        <span key={i}>
          {i > 0 && <Name>{shown}</Name>}
          {seg}
        </span>
      ))}
    </>
  );
}

/**
 * POLICY content - the name is already baked in, so match the literal string.
 *
 * Returns the text untouched when there is no name to match, which is also the
 * right answer for a policy the operator rewrote without mentioning themselves.
 */
export function PolicyOrgName({ children, orgName }) {
  if (!orgName) return children;
  const arr = Array.isArray(children) ? children : [children];
  return arr.map((child, ci) => {
    if (typeof child !== "string" || !child.includes(orgName)) return child;
    const parts = splitOnWholeName(child, orgName);
    if (parts.length === 1) return child; // only substring hits, nothing to bold
    return parts.map((part, i) => (
      <span key={`${ci}-${i}`}>
        {i > 0 && <Name>{orgName}</Name>}
        {part}
      </span>
    ));
  });
}
