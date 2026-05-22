// get-legal-document — wizard helper that returns the canonical text of a
// legal document for the calling instructor's org.
//
// Why this exists: the wizard CANNOT query legal_documents directly. Chunk 1
// RLS allows only org_members and platform_admin to read — instructors get
// zero rows. This function uses service_role to fetch the row scoped to the
// JWT-resolved instructor's org, then returns just the public-facing fields.
//
// Auth: verify_jwt: true. Instructor must be active and not in a terminal
// onboarding state (declined / abandoned).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
  clientIp,
} from '../_shared/instructor.ts';
import { buildAgreementVars, renderAgreementText } from '../_shared/agreementTemplate.ts';

interface GetLegalDocumentBody {
  document_key?: string;
  document_version?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    // resolveInstructor returns either instructor or error — never both.
    const me = instructor!;

    let body: GetLegalDocumentBody;
    try {
      body = (await req.json()) as GetLegalDocumentBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const documentKey = body.document_key?.trim();
    const documentVersion = body.document_version?.trim();
    if (!documentKey) {
      return json({ error: 'document_key_required' }, 400);
    }

    const supabase = adminClient();
    // If document_version is provided, fetch that exact version. If not,
    // fetch the most recent row for the (org, document_key) pair. Today the
    // table has exactly one version per key so this trivially returns it;
    // when we add a v2 alongside a v1, the latest-created wins. (We can
    // swap to an explicit "active" flag if/when versioned drafts are needed.)
    let query = supabase
      .from('legal_documents')
      .select('title, body_text, document_version')
      .eq('organization_id', me.organization_id)
      .eq('document_key', documentKey);
    if (documentVersion) {
      query = query.eq('document_version', documentVersion);
    } else {
      query = query.order('created_at', { ascending: false }).limit(1);
    }
    const { data: doc, error: docErr } = await query.maybeSingle();

    if (docErr) {
      console.error('legal_documents lookup error:', docErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!doc) {
      // Generic 404 — the org-scoped query means a doc that exists for another
      // org will also 404 here. That's intentional (no cross-org leak).
      return json({ error: 'document_not_found' }, 404);
    }

    // For the contractor agreement, substitute template tokens so the
    // text the contractor reads matches what submit-agreement will snapshot.
    // Other doc types (acknowledgments) are returned verbatim.
    let bodyText = doc.body_text;
    if (documentKey === 'contractor_agreement') {
      const vars = buildAgreementVars({
        firstName: me.first_name,
        lastName: me.last_name,
        ip: clientIp(req),
      });
      bodyText = renderAgreementText(doc.body_text, vars);
    }

    return json({
      title: doc.title,
      body_text: bodyText,
      document_version: doc.document_version,
    });
  } catch (err) {
    console.error('get-legal-document fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
