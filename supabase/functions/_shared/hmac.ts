// The ONE HMAC-SHA256 + base64url signing primitive for every short-lived
// token this codebase mints into a public link (unsubscribe, review-rate,
// and anything that follows the same pattern).
//
// WHY THIS FILE EXISTS. Before this, marketing-unsubscribe/index.ts,
// review-rate/index.ts, and lifecycle-automations-cron/index.ts each carried
// their own independent copy of "import the secret as an HMAC key, sign the
// message, base64url-encode the signature" — three places that have to be
// changed in lockstep if the scheme ever needs to change (an expiry field, a
// different hash, a padding fix), and three places a maintainer fixing one
// can miss the other two, silently leaving a signing/verifying path on the
// old scheme while the others move on.
//
// Each caller still owns its OWN secret and its OWN message shape (e.g.
// `${email}:${orgId}` vs `${registrationId}:${orgId}`) — this file only does
// the cryptographic part everyone needs identically.
export async function hmacBase64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time string compare — every caller here verifies a token against
// an untrusted value from a public URL, where a timing-variable compare would
// leak how many leading characters matched.
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
