// submit-acknowledgments — Screens 5 (policies) and 6 (additional acks).
//
// One function handles both screens. The wizard sends a step key ('policies'
// or 'additional') and an array of documents the contractor is acknowledging.
//
// Validation: every (document_id, document_version) must exist in
// legal_documents for the instructor's org. Unknown keys → 400. This catches
// stale wizard caches, typos, and would-be malicious clients trying to
// acknowledge fabricated documents.
//
// Idempotency: chunk 1 has UNIQUE(instructor_id, document_id, document_version)
// on contractor_acknowledgments. Resubmits update the existing row's
// acknowledged_at, ip_address, user_agent — last action wins.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
  clientIp,
  userAgent,
} from '../_shared/instructor.ts';
import { advanceOnboardingStep, StepKey } from '../_shared/onboardingStep.ts';

interface AckDoc {
  document_id?: string;
  document_version?: string;
}

interface SubmitAcksBody {
  step?: 'policies' | 'additional';
  documents?: AckDoc[];
}

// Step name → step number mapping. After acknowledging policies the wizard
// moves to step 6 (additional); after additional acks → step 7 (Stripe).
const STEP_ADVANCE: Record<'policies' | 'additional', { key: StepKey; next: number }> = {
  policies: { key: 'policies_acknowledged', next: 6 },
  additional: { key: 'additional_acks', next: 7 },
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: SubmitAcksBody;
    try {
      body = (await req.json()) as SubmitAcksBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const step = body.step;
    if (step !== 'policies' && step !== 'additional') {
      return json({ error: 'invalid_step', expected: ['policies', 'additional'] }, 400);
    }

    const docs = Array.isArray(body.documents) ? body.documents : [];
    if (docs.length === 0) {
      return json({ error: 'documents_required' }, 400);
    }

    // Normalize + validate each doc has both fields
    const normalized = docs.map((d) => ({
      document_id: d.document_id?.trim() ?? '',
      document_version: d.document_version?.trim() ?? '',
    }));
    const malformed = normalized.find((d) => !d.document_id || !d.document_version);
    if (malformed) {
      return json({ error: 'doc_id_and_version_required_per_row' }, 400);
    }

    const supabase = adminClient();

    // Validate all (document_id, document_version) pairs exist in legal_documents
    // for this org. Build a SQL IN-list and compare returned set against submitted.
    const orFilter = normalized
      .map(
        (d) =>
          `and(document_key.eq.${escapeForFilter(d.document_id)},document_version.eq.${escapeForFilter(d.document_version)})`,
      )
      .join(',');

    const { data: foundDocs, error: lookupErr } = await supabase
      .from('legal_documents')
      .select('document_key, document_version')
      .eq('organization_id', me.organization_id)
      .or(orFilter);

    if (lookupErr) {
      console.error('legal_documents validation lookup failed:', lookupErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    const foundSet = new Set(
      (foundDocs ?? []).map((d) => `${d.document_key}|${d.document_version}`),
    );
    const missing = normalized.filter(
      (d) => !foundSet.has(`${d.document_id}|${d.document_version}`),
    );
    if (missing.length > 0) {
      // Real bug indicator on the client side or a stale wizard cache.
      // The wizard treats this as a developer error and shows a generic message.
      console.error('unknown documents submitted for ack:', missing);
      return json({ error: 'unknown_document', missing }, 400);
    }

    // UPSERT each ack row. Chunk 1 unique constraint on
    // (instructor_id, document_id, document_version) → resubmits update in place.
    const ip = clientIp(req);
    const ua = userAgent(req);
    const nowIso = new Date().toISOString();

    const rows = normalized.map((d) => ({
      instructor_id: me.id,
      organization_id: me.organization_id,
      document_id: d.document_id,
      document_version: d.document_version,
      acknowledged_at: nowIso,
      ip_address: ip,
      user_agent: ua,
    }));

    const { error: upsertErr } = await supabase
      .from('contractor_acknowledgments')
      .upsert(rows, { onConflict: 'instructor_id,document_id,document_version' });

    if (upsertErr) {
      console.error('acknowledgments upsert failed:', upsertErr);
      return json({ error: 'upsert_failed' }, 500);
    }

    // Advance step
    const stepInfo = STEP_ADVANCE[step];
    const { error: stepErr } = await advanceOnboardingStep(supabase, {
      instructorId: me.id,
      orgId: me.organization_id,
      stepKey: stepInfo.key,
      nextStep: stepInfo.next,
      ip,
    });
    if (stepErr) {
      console.error('onboarding step advance failed:', stepErr);
      // Don't fail — acks are written.
    }

    return json({ success: true, inserted: rows.length });
  } catch (err) {
    console.error('submit-acknowledgments fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

// PostgREST's .or() filter syntax uses commas and parens, so we escape any
// commas/parens/dots in the values to avoid breaking the filter expression.
// Document keys and versions don't contain these characters in practice,
// but defensive.
function escapeForFilter(s: string): string {
  return s.replace(/[,\(\)]/g, (c) => `\\${c}`);
}
