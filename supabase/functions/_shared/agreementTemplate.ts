// Template variable substitution for legal documents.
//
// legal_documents.body_text for the contractor_agreement uses these tokens:
//   {{contractor_legal_name}}  -- instructor.first_name + ' ' + last_name
//   {{signing_date}}           -- YYYY-MM-DD when the contractor signed (UTC)
//   {{signed_at_timestamp}}    -- ISO timestamp when the contractor signed
//   {{signed_at_ip}}           -- caller IP (for the audit trail line)
//
// Used by both:
//   * submit-agreement   -- substitutes BEFORE snapshotting so the stored
//                           agreement_text_snapshot reflects the actual
//                           signed text (name + date + audit).
//   * get-legal-document -- substitutes BEFORE returning to the client so
//                           what the contractor reads on Screen 4 matches
//                           what gets snapshotted on submit.
//
// Both calls happen in the same auth session so contractor_legal_name and
// signed_at_ip resolve to the same values. signing_date is derived from
// "now" each call; for the rare case where the contractor reads at 23:59
// UTC and signs at 00:01 UTC, the snapshot is authoritative.

export interface AgreementVars {
  contractor_legal_name: string;
  signing_date: string;          // YYYY-MM-DD
  signed_at_timestamp: string;   // ISO 8601
  signed_at_ip: string;          // raw IP or 'unknown'
}

export function buildAgreementVars(args: {
  firstName: string | null;
  lastName: string | null;
  ip: string | null;
  now?: Date;
}): AgreementVars {
  const now = args.now ?? new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const legalName = [args.firstName, args.lastName]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ') || '(name on file)';
  return {
    contractor_legal_name: legalName,
    signing_date: `${yyyy}-${mm}-${dd}`,
    signed_at_timestamp: now.toISOString(),
    signed_at_ip: args.ip?.trim() || 'unknown',
  };
}

// Substitute {{token}} occurrences. Any token not in vars is left as-is —
// safer than dropping it silently, which would mask a missing variable.
export function renderAgreementText(body: string, vars: AgreementVars): string {
  return body.replace(/\{\{(contractor_legal_name|signing_date|signed_at_timestamp|signed_at_ip)\}\}/g, (_match, key) => {
    return vars[key as keyof AgreementVars] ?? `{{${key}}}`;
  });
}
