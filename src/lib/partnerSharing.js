// Instructor permission to share their record with partner organizations.
// ONE place for the wording and its version. The database stores which version
// an instructor agreed to (instructors.partner_sharing_version) and
// public.agree_partner_sharing() accepts only versions it knows, so changing
// the sentence means bumping PARTNER_SHARING_VERSION here AND adding the new
// version to that function in a migration. Never edit v1's text in place: the
// record would then claim people agreed to words they never saw.
//
// Wording approved by Jessica 2026-10-19.
import { renderWaiverText } from './waiverText.js';

export const PARTNER_SHARING_VERSION = 'v1';

const PARTNER_SHARING_TEMPLATE =
  'I agree that {{org}} may share my name, email, phone, background check status and date, ' +
  'and training and acknowledgment dates with the partner organizations ' +
  '(i.e. schools and community centers) where I teach. ' +
  'They will never share my background check report.';

export function partnerSharingText(orgName) {
  return renderWaiverText(PARTNER_SHARING_TEMPLATE, orgName);
}
