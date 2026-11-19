// Partner portal "Emails sent" (20261119b): the words for each reminder enrops
// sent the provider, pure. The rows come from public.partner_portal_emails_sent(),
// which already decided what this partner may see.

import { formatDate } from "./providerDocumentLogic.js";

/**
 * What the reminder was about, one sentence. Every branch is true in its state:
 *   tier 0  -> sent on or after the day it expired: "expired"
 *   else    -> sent before: "expires" / "renews"
 */
export function reminderText(e, docTypeLabel = {}) {
  const when = formatDate(e.expires_on);
  const past = Number(e.tier) === 0;
  if (e.subject_type === "background_check") {
    const who = (e.about || "").trim() || "An instructor";
    return past ? `${who}'s background check expired ${when}` : `${who}'s background check renews ${when}`;
  }
  const kind = docTypeLabel[e.doc_type] ?? "Document";
  const title = (e.about || "").trim();
  const what = title ? `${kind} "${title}"` : kind;
  return past ? `${what} expired ${when}` : `${what} expires ${when}`;
}

/** "Sent Nov 3, 2026 to 2 people at Journey to STEAM". A count, never addresses. */
export function sentLine(e, orgName = "") {
  const d = e.sent_at ? new Date(e.sent_at) : null;
  const day = d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";
  const n = Number(e.recipients) || 0;
  const to = n > 0 ? ` to ${n} ${n === 1 ? "person" : "people"}${orgName ? ` at ${orgName}` : ""}` : "";
  return `Sent ${day}${to}`.trim();
}
