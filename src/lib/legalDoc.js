// Wrapper around the get-legal-document edge function. The wizard can't query
// legal_documents directly because RLS only grants org_members + platform_
// admin access — instructors get zero rows. This helper centralizes the call
// + standard error handling and is consumed by Screens 4, 5, 6.

import { invokeOnboardingFn } from './onboardingFetch.js';

export async function fetchLegalDocument(
  document_key,
  { document_version, navigate } = {}
) {
  const body = { document_key };
  if (document_version) body.document_version = document_version;
  return invokeOnboardingFn('get-legal-document', body, { navigate });
}
