// buildStatementDescriptorSuffix — produce a Stripe-safe statement_descriptor_suffix
// for a charge.
//
// Stripe rules for statement_descriptor_suffix:
//   - ASCII only; cannot contain < > " ' \ *
//   - Uppercased automatically by Stripe but we uppercase here for clarity
//   - Cannot be only spaces
//   - Combined platform descriptor + " " + suffix must be 5-22 chars
//
// Our platform descriptor is "ENROPS" (7 chars including the trailing space
// Stripe inserts between prefix and suffix), so the suffix can be up to 15
// chars. We constrain to 14 for safety (some banks display less).
//
// Source priority:
//   1. The org's stored statement_descriptor_suffix (admin-set in Finances tab)
//   2. The org name, sanitized down to safe chars
//   3. undefined (skip the suffix entirely; parent sees just "ENROPS")

export function buildStatementDescriptorSuffix(
  storedSuffix: string | null | undefined,
  orgName: string | null | undefined,
): string | undefined {
  // Use || (not ??) so an empty-string stored suffix falls through to orgName.
  const raw = (storedSuffix || orgName || '').trim();
  if (!raw) return undefined;

  const sanitized = raw
    .toUpperCase()
    // Replace disallowed chars with a space
    .replace(/[^A-Z0-9 .,\-]/g, ' ')
    // Collapse runs of spaces
    .replace(/\s+/g, ' ')
    // Stripe rejects leading/trailing * (we strip * entirely above) or spaces
    .trim()
    // Limit length
    .slice(0, 14)
    .trim();

  if (sanitized.length < 3) return undefined;
  return sanitized;
}
