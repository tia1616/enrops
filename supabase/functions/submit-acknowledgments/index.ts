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

// The document key the photo consent belongs to. Named here rather than inlined
// so the binding check below and the wizard cannot drift apart silently; the
// browser half is PHOTO_KEY in Screen6Additional.jsx.
const PHOTO_DOC_KEY = 'photo_video_release';

interface AckDoc {
  document_id?: string;
  document_version?: string;
}

type AckStep = 'contractor_status' | 'policies' | 'additional';

interface SubmitAcksBody {
  step?: AckStep;
  documents?: AckDoc[];
  // Screen 6 only. A real yes/no, unlike every other box in the wizard — see
  // the photo block further down.
  photo_release_consent?: boolean;
}

// Step name → step number mapping. After acknowledging policies the wizard
// moves to step 6 (additional); after additional acks → step 7 (Stripe).
//
// 'contractor_status' JOINED THIS FUNCTION ON 2026-08-24, replacing
// submit-ors-certification. That function existed only to advance a step: it
// stored nothing, so there was no record an instructor had ever been shown the
// provider's independent-contractor note. Screen 3 now posts here instead and
// gets the whole contract for free — the (document_id, document_version) pair is
// validated against the org's own legal_documents, the acknowledgement is
// upserted idempotently, and the step advances. One write path for every document
// an instructor reads, rather than a second spelling of the same insert.
// submit-ors-certification is left deployed but is no longer called by anything.
const STEP_ADVANCE: Record<AckStep, { key: StepKey; next: number }> = {
  contractor_status: { key: 'ors_certification', next: 4 },
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

    const step = body.step as AckStep | undefined;
    if (!step || !Object.prototype.hasOwnProperty.call(STEP_ADVANCE, step)) {
      // Derived from STEP_ADVANCE rather than restated, so adding a step cannot
      // leave this guard rejecting a step the function otherwise supports.
      return json({ error: 'invalid_step', expected: Object.keys(STEP_ADVANCE) }, 400);
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

    // THE ONE ANSWER IN THIS WIZARD THAT CAN LEGITIMATELY BE "NO".
    //
    // Every other tick box is an acknowledgement — "I have read it", "I will
    // comply" — where no is not an available answer and the ack row above IS the
    // record. The photo/video release is a CONSENT: an instructor may refuse it
    // and must still be able to finish onboarding. Until 2026-08-24 all three of
    // its boxes were required, so agreeing to appear in a provider's marketing
    // was a condition of working, and the answer was stored nowhere at all.
    //
    // BOUND TO THE DOCUMENT THAT WAS ACTUALLY ACKNOWLEDGED, not taken on the
    // client's word. A caller could otherwise post a consent for a release it was
    // never shown. The pair must arrive together: the photo document in
    // `documents` (already validated above against this org's legal_documents)
    // and the boolean in the body.
    //
    // ABSENT IS NOT FALSE. If the key is missing entirely the column is left
    // exactly as it was — that is a caller which did not ask the question (an
    // older cached bundle, or the policies step), and overwriting a real answer
    // with a default would destroy consent evidence. Only an explicit boolean
    // writes.
    const askedAboutPhoto = normalized.some((d) => d.document_id === PHOTO_DOC_KEY);
    if (step === 'additional' && askedAboutPhoto && typeof body.photo_release_consent === 'boolean') {
      const consent = body.photo_release_consent;
      const { error: consentErr } = await supabase
        .from('instructors')
        .update({
          photo_release_consent: consent,
          photo_release_consent_at: nowIso,
        })
        .eq('id', me.id)
        .eq('organization_id', me.organization_id);
      if (consentErr) {
        // FAILS THE REQUEST. The acks are written, but returning success here
        // would tell an instructor their refusal was recorded when it was not,
        // and the provider would go on using their likeness. A retry re-upserts
        // the same ack rows harmlessly (unique constraint) and re-attempts this.
        console.error('photo release consent write failed:', consentErr, {
          instructor_id: me.id,
          organization_id: me.organization_id,
        });
        return json({ error: 'consent_write_failed' }, 500);
      }
    }

    // Advance step.
    //
    // A FAILED ADVANCE IS THE FAILURE, and it is surfaced rather than swallowed.
    // This used to log and return success on the reasoning "don't fail — acks are
    // written", which gets the fail direction backwards: the acknowledgement rows
    // are not what lets an instructor finish, the step key is. Swallow it and the
    // wizard calls onAdvance(), the instructor sails through every remaining
    // screen, and runGateCheck never sees the step — so overall_status sits at
    // in_progress forever, with nothing left to click and no error anywhere. That
    // is silent and permanent; an error the instructor can retry is neither.
    //
    // submit-ors-certification already knew this and said so in as many words:
    // "a failed advance IS the failure ... rather than moving someone on from a
    // step that was never recorded, which would strand them at the completion
    // gate." Screen 3 now posts here instead of there, so that guard had to come
    // with it — and it applies identically to policies and additional, which were
    // exposed to the same stall the whole time.
    //
    // Safe to retry: the ack upsert is idempotent on
    // (instructor_id, document_id, document_version) and the consent write above
    // is a plain update to the same values, so a second attempt repeats the same
    // writes and then advances.
    const stepInfo = STEP_ADVANCE[step];
    const { error: stepErr } = await advanceOnboardingStep(supabase, {
      instructorId: me.id,
      orgId: me.organization_id,
      stepKey: stepInfo.key,
      nextStep: stepInfo.next,
      ip,
    });
    if (stepErr) {
      console.error('onboarding step advance failed:', stepErr, {
        instructor_id: me.id,
        step: stepInfo.key,
      });
      return json({ error: 'step_advance_failed' }, 500);
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
