// unreachableAddress — did Resend refuse the RECIPIENT, as opposed to anything else
// about the send?
//
// Its own file, with no imports and no Deno.env read, so its test runs under CI's
// permissions (no --allow-env). waitlistSweep.ts reads RESEND_API_KEY at load, and a
// test importing it from there fails before a single assertion runs.
//
// Deliberately narrow. A 422 alone is not enough: Resend also returns 422 for a bad
// From address or a malformed payload, which are OUR faults and would take every
// family on the platform off their lists if treated as theirs. Likewise 401/403 (our
// key). Only a 422 whose body names the `to` field is the family's address. This is
// the exact message prod recorded 78 times for one "<name>@yahoo" address:
//   Resend 422: {"message":"Invalid `to` field. The email address needs to follow ...
// If Resend ever rewords it, this returns false and the sweep falls back to the old
// roll-back-and-retry: noisy, but it never drops a family who could be reached.

export function isUnreachableAddress(status: number, body: string): boolean {
  return status === 422 && /invalid\s+`to`\s+field/i.test(body ?? '');
}
