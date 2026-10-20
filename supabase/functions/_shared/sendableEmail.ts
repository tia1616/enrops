// Can this contact's email field be handed to Resend as ONE address?
//
// Campaign sends go to Resend's /emails/batch in groups of 100, and Resend
// validates the whole request before sending any of it: one malformed `to`
// rejects all 100 with a 422. On 2026-10-20 a contact whose field held
// "a@x.com; b@y.com" (a parent typed both parents' addresses at registration)
// cost 100 families the Vancouver winter camp email. So the send checks each
// address BEFORE batching and leaves a bad one out, instead of letting it take
// 99 good ones down with it.
//
// Deliberately loose. This is not "is this a real mailbox" (a bounce answers
// that, per address, without hurting anyone else); it only refuses what is
// structurally more or less than one address: spaces, list separators, angle
// brackets, quotes, a missing or doubled @, a domain without a dot. Measured
// on prod 2026-10-20 (after the two-address contact above was split by hand):
// of 2,846 contacts it refuses 4, all import placeholders with a space in them.
// No real address.

const SENDABLE_EMAIL_RE = /^[^\s@;,<>()[\]"]+@[^\s@;,<>()[\]".]+(\.[^\s@;,<>()[\]".]+)+$/;

/** The address to send to (trimmed), or null when the field is not exactly one
 *  address. Null/empty also returns null; callers count that separately. */
export function sendableEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? "").trim();
  return SENDABLE_EMAIL_RE.test(email) ? email : null;
}
