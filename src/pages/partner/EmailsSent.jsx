// "Emails sent": the reminder emails enrops sent this provider about items the
// partner can see, newest first, so a partner can check a reminder really went
// out (Stacey Allington, City of Vancouver, 2026-11-09). The log lives on the
// provider's own record, as in myCOI, rather than in a global feed.
//
// Rendered by the partner's page AND the provider's own page for that partner,
// so the provider sees exactly what the partner sees. The database
// (partner_portal_emails_sent, 20261119d) decides which reminders a login may
// see; this file only words them.

import { useEffect, useState } from "react";
import { listPartnerEmailsSent } from "../../lib/partnerPortal.js";
import { reminderText, sentLine } from "../../lib/partnerEmails.js";
import { DOC_TYPE_LABEL } from "./ProviderRecord.jsx";

// `onCount(n)`: how many reminders loaded, for the count on the page's tab (null = failed).
export default function EmailsSent({ partnerId, orgName, viewer = "partner", partnerName = "", onCount }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setRows(null); setError("");
    if (!partnerId) return undefined;
    listPartnerEmailsSent(partnerId)
      .then((r) => { if (!cancelled) { setRows(r); onCount?.(r.length); } })
      .catch((err) => { if (!cancelled) { setRows([]); onCount?.(null); setError(`Couldn't load emails sent: ${err?.message ?? "unknown error"}`); } });
    return () => { cancelled = true; };
  }, [partnerId]);

  const heading = viewer === "provider"
    ? `Reminders about ${partnerName || "this partner"}'s items`
    : `Emails sent to ${orgName || "this provider"}`;

  return (
    <section className="mt-5 rounded-2xl bg-white p-4 shadow-card">
      <h2 className="text-base font-bold text-j2s-ink">{heading}</h2>
      <p className="mt-1 text-xs text-j2s-ink/55">
        {viewer === "provider"
          ? `${partnerName || "This partner"} sees this list: reminders about the documents and instructors on their page.`
          : `enrops emails ${orgName || "the provider"} 30, 14 and 7 days before a document or background check on this page expires, and on the day.`}
      </p>
      {error && <p className="error-text mt-2">{error}</p>}
      {rows === null ? (
        <p className="mt-2 text-sm text-j2s-ink/60">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-j2s-ink/70">
          {viewer === "provider"
            ? `No reminders about ${partnerName || "this partner"}'s items have gone out yet.`
            : `No reminders about anything on this page have gone to ${orgName || "this provider"} yet.`}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-j2s-ink/10">
          {rows.map((e, i) => (
            <li key={`${e.sent_at}:${e.subject_type}:${i}`} className="py-2 text-sm">
              <div className="text-j2s-ink">Reminder: {reminderText(e, DOC_TYPE_LABEL)}</div>
              <div className="text-xs text-j2s-ink/55">{sentLine(e, orgName)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
