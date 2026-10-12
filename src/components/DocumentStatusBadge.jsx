// The expiry badge for a provider document, shared by the provider's admin
// screen and the partner portal so both always show the same words and
// colours. The status itself comes from the database
// (private.document_expiry_status via provider_documents_with_status).
// Inline styles on purpose: one badge renders inside both the admin shell and
// the tenant-themed public layout.

import { EXPIRY_STATUS } from "../lib/providerDocumentLogic.js";

const TONE = {
  good: { bg: "#f0fdf4", ink: "#166534", border: "#bbf7d0" },
  warn: { bg: "#fffbeb", ink: "#92400e", border: "#fde68a" },
  bad: { bg: "#fef2f2", ink: "#991b1b", border: "#fecaca" },
  neutral: { bg: "#f5f5f4", ink: "#57534e", border: "#e7e5e4" },
};

export default function DocumentStatusBadge({ status }) {
  const s = EXPIRY_STATUS[status] ?? EXPIRY_STATUS.no_expiry;
  const t = TONE[s.tone];
  return (
    <span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: t.bg, color: t.ink, border: `1px solid ${t.border}`, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}
