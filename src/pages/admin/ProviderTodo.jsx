// "What <partner> still needs from you" (2026-11-20): the provider's to-do
// list on its page for one partner. The items come from partnerTodo()
// (src/lib/partnerTodo.js), built from the same summary the partner sees, so
// the two never disagree. Each item has the one action that fixes it.

import { useState } from "react";
import { Link } from "react-router-dom";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const BRIGHT = "#5847C9";
const DOT = { bad: "#dc2626", warn: "#f59e0b" };

const actionBtn = { background: "none", border: "none", padding: 0, color: BRIGHT, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline" };

/**
 * `items` = partnerTodo() output. `onUpload(requirementKey)` and
 * `onRenew(doc)` open the document form; `instructorPortalUrl` is the link an
 * instructor signs in at, for the share items. `canManage` hides the document
 * buttons for roles that can't upload (the links still show where to go).
 */
export default function ProviderTodo({ items, partnerName, onUpload, onRenew, instructorPortalUrl, canManage, requirementsUnknown = false, onTab }) {
  const [copied, setCopied] = useState("");

  async function copyPortalLink(key) {
    try {
      await navigator.clipboard.writeText(instructorPortalUrl);
      setCopied(key);
    } catch {
      setCopied(`fail:${key}`);
    }
  }

  return (
    <section style={{ marginTop: 20, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: INK }}>
        {items.length ? `What ${partnerName} still needs from you` : `${partnerName} has everything it asks for`}
      </h2>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        {items.length
          ? `These show as missing, expired or due soon on ${partnerName}'s page. Fix each one where it's linked.`
          : `Everything ${partnerName} requires shows as current on their page.`}
      </p>
      {/* Requirements failed to load: everything counts, as on the partner's
          own page, so this list may include things they don't ask for. */}
      {requirementsUnknown && (
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "#92400e" }}>
          Couldn't load {partnerName}'s requirements just now, so this counts every standard item. Refresh to try again.
        </p>
      )}
      {items.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((it, i) => (
            <li key={it.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", borderTop: i === 0 ? "none" : `1px solid ${RULE}` }}>
              <span aria-hidden="true" style={{ flexShrink: 0, width: 8, height: 8, borderRadius: 99, marginTop: 6, background: DOT[it.tone] }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, color: INK, lineHeight: 1.45 }}>
                  <span className="sr-only">{it.tone === "bad" ? "Needed: " : "Due soon: "}</span>
                  {it.text}
                </div>
                <div style={{ marginTop: 4, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                  {it.action.type === "upload" && canManage && (
                    <button type="button" style={actionBtn} onClick={() => onUpload(it.action.requirementKey)}>Upload</button>
                  )}
                  {it.action.type === "renew" && canManage && (
                    <button type="button" style={actionBtn} onClick={() => onRenew(it.action.doc)}>Upload new version</button>
                  )}
                  {(it.action.type === "upload" || it.action.type === "renew") && !canManage && (
                    <span style={{ fontSize: 12.5, color: MUTED }}>An owner or admin can upload this.</span>
                  )}
                  {it.action.type === "instructor" && (
                    <Link
                      to={`/admin/instructors?instructor=${it.action.instructorId}${it.action.upload ? `&upload=${it.action.upload}` : ""}`}
                      style={{ color: BRIGHT, fontSize: 13, fontWeight: 600 }}
                    >
                      {it.action.upload ? "Upload the background check" : "Open their record"}
                    </Link>
                  )}
                  {it.action.type === "tab" && onTab && (
                    <button type="button" style={actionBtn} onClick={() => { onTab(it.action.tab); window.scrollTo({ top: 0, behavior: "smooth" }); }}>{it.action.label}</button>
                  )}
                  {it.action.type === "share" && (
                    <>
                      <button type="button" style={actionBtn} onClick={() => copyPortalLink(it.key)}>Copy their sign-in link</button>
                      <Link to={`/admin/instructors?instructor=${it.action.instructorId}`} style={{ color: BRIGHT, fontSize: 13, fontWeight: 600 }}>Open their record</Link>
                      {copied === it.key && <span role="status" style={{ fontSize: 12.5, color: "#166534" }}>Copied. Send it to them; they agree on their Profile.</span>}
                      {copied === `fail:${it.key}` && <span role="status" style={{ fontSize: 12.5, color: MUTED }}>Couldn't copy. The link is {instructorPortalUrl}</span>}
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
