// Instructor permission to share their record with partner organizations.
// ONE place for the wording and its version. The database stores which version
// an instructor agreed to (instructors.partner_sharing_version) and
// public.agree_partner_sharing() accepts only versions it knows, so changing
// the sentence means bumping PARTNER_SHARING_VERSION here AND adding the new
// version to that function in a migration. Never edit v1's text in place: the
// record would then claim people agreed to words they never saw.
//
// v1 approved by Jessica 2026-10-19. v2 is Arielle's (roadmap thread,
// 2026-10-21), used on Jessica's go 2026-10-22: adds the screening expiry and
// company, and "I can stop this at any time", which stop_partner_sharing()
// (20261022a) makes true. v1 agreements already on file stay valid.
import { renderWaiverText } from './waiverText.js';

export const PARTNER_SHARING_VERSION = 'v2';

const PARTNER_SHARING_TEMPLATE =
  'I agree that {{org}} may share my name, email, phone, screening status, ' +
  'screening date and expiry, the screening company, and my training and acknowledgment dates ' +
  'with the schools and programs where I teach. ' +
  '{{org}} never shares my background check report. ' +
  'I can stop this at any time.';

export function partnerSharingText(orgName) {
  return renderWaiverText(PARTNER_SHARING_TEMPLATE, orgName);
}
