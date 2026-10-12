// Pure wording for partner portal access, testable without Supabase.

import { formatDate } from "./providerDocumentLogic.js";

function dateOnly(ts) {
  return ts ? String(ts).slice(0, 10) : null;
}

/**
 * Where a person stands, in words, from their partner_portal_access row.
 * Keys off the timestamps the database writes, never off a guess:
 * last_signed_in_at is stamped by partner_portal_memberships() on every portal
 * load, last_link_sent_at by the sign-in email function after a send.
 */
export function accessStatus(row) {
  if (row?.last_signed_in_at) {
    return { tone: "good", label: `Signed in ${formatDate(dateOnly(row.last_signed_in_at))}` };
  }
  if (row?.last_link_sent_at) {
    return { tone: "warn", label: `Link sent ${formatDate(dateOnly(row.last_link_sent_at))}, not signed in yet` };
  }
  return { tone: "neutral", label: "No sign-in link sent yet" };
}

/** Contacts that can still be given access: not already granted. */
export function contactsWithoutAccess(contacts, grants) {
  const granted = new Set((grants || []).map((g) => g.contact_id));
  return (contacts || []).filter((c) => !granted.has(c.id));
}
