// submit-agreement — Screen 4 of the contractor onboarding wizard.
//
// CRITICAL: the client does NOT send agreement text. This function looks up
// the canonical body_text from legal_documents by (organization_id, document_key,
// document_version) and snapshots that server-side. If the client could submit
// arbitrary text, a malicious wizard could record a different agreement than
// the one J2S actually authored.
//
// Idempotency: chunk 1 has UNIQUE(instructor_id, agreement_version). Two-tab
// races (or accidental double-clicks) get absorbed via ON CONFLICT DO NOTHING
// — the second submission returns the existing row's id.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
  clientIp,
  userAgent,
} from '../_shared/instructor.ts';
import { advanceOnboardingStep } from '../_shared/onboardingStep.ts';

interface SubmitAgreementBody {
  agreement_version?: string;
  typed_signature?: string;
  confirm_read?: boolean;
  confirm_pay_structure?: boolean;
  confirm_contractor_status?: boolean;
  confirm_confidentiality_ip?: boolean;
  confirm_supersedes_prior?: boolean;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: SubmitAgreementBody;
    try {
      body = (await req.json()) as SubmitAgreementBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const agreementVersion = body.agreement_version?.trim();
    const typedSignature = body.typed_signature?.trim();

    if (!agreementVersion) return json({ error: 'agreement_version_required' }, 400);
    if (!typedSignature) return json({ error: 'typed_signature_required' }, 400);

    // All 5 confirms must be true. Reject if any is missing or false.
    const confirms = {
      confirm_read: body.confirm_read === true,
      confirm_pay_structure: body.confirm_pay_structure === true,
      confirm_contractor_status: body.confirm_contractor_status === true,
      confirm_confidentiality_ip: body.confirm_confidentiality_ip === true,
      confirm_supersedes_prior: body.confirm_supersedes_prior === true,
    };
    const missing = Object.entries(confirms)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      return json({ error: 'all_confirms_required', missing }, 400);
    }

    const supabase = adminClient();

    // Server-side document lookup. The body_text the contractor sees in the
    // wizard came from this same table via Function 14, so the snapshot
    // matches what they actually read.
    const { data: doc, error: docErr } = await supabase
      .from('legal_documents')
      .select('body_text')
      .eq('organization_id', me.organization_id)
      .eq('document_key', 'contractor_agreement')
      .eq('document_version', agreementVersion)
      .maybeSingle();

    if (docErr) {
      console.error('legal_documents lookup error:', docErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!doc) {
      // The agreement_version doesn't exist in legal_documents for this org.
      // Could be a typo, stale client cache, or someone trying to sign a
      // never-published version.
      return json({ error: 'unknown_agreement_version' }, 400);
    }

    const ip = clientIp(req);
    const ua = userAgent(req);

    // INSERT with ON CONFLICT DO NOTHING + RETURNING id. If a row already
    // exists for (instructor_id, agreement_version), insert is a no-op and
    // returns no rows; we then SELECT the existing id and return it as if
    // the insert just succeeded (idempotent two-tab handling).
    const { data: inserted, error: insertErr } = await supabase
      .from('contractor_agreements')
      .insert({
        instructor_id: me.id,
        organization_id: me.organization_id,
        agreement_version: agreementVersion,
        agreement_text_snapshot: doc.body_text,
        typed_signature: typedSignature,
        ip_address: ip,
        user_agent: ua,
        confirm_read: confirms.confirm_read,
        confirm_pay_structure: confirms.confirm_pay_structure,
        confirm_contractor_status: confirms.confirm_contractor_status,
        confirm_confidentiality_ip: confirms.confirm_confidentiality_ip,
        confirm_supersedes_prior: confirms.confirm_supersedes_prior,
      })
      .select('id')
      .maybeSingle();

    let agreementId: string | null = null;
    if (insertErr) {
      // Unique-constraint violation = already signed. Fall through to SELECT.
      // Code 23505 is PostgreSQL unique_violation.
      const errCode = (insertErr as { code?: string }).code;
      if (errCode !== '23505') {
        console.error('contractor_agreements insert failed:', insertErr);
        return json({ error: 'insert_failed' }, 500);
      }
    } else if (inserted) {
      agreementId = inserted.id;
    }

    if (!agreementId) {
      // Either ON CONFLICT no-op'd (shouldn't happen with plain INSERT but
      // belt-and-suspenders) or unique violation above. Fetch the existing row.
      const { data: existing, error: selErr } = await supabase
        .from('contractor_agreements')
        .select('id')
        .eq('instructor_id', me.id)
        .eq('agreement_version', agreementVersion)
        .maybeSingle();
      if (selErr || !existing) {
        console.error('agreement select after conflict failed:', selErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      agreementId = existing.id;
    }

    // Advance step 4 → 5 (steps_completed.agreement_signed)
    const stepRes = await advanceOnboardingStep(supabase, {
      instructorId: me.id,
      orgId: me.organization_id,
      stepKey: 'agreement_signed',
      nextStep: 5,
      ip,
    });
    if (stepRes.error) {
      console.error('onboarding step advance failed:', stepRes.error);
      // Don't fail the whole request — agreement is signed in DB.
    }

    return json({ success: true, agreement_id: agreementId });
  } catch (err) {
    console.error('submit-agreement fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
