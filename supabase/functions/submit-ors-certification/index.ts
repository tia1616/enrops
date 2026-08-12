// submit-ors-certification — Screen 3 of the contractor onboarding wizard.
//
// WRITES NOTHING. Its only job is to advance the onboarding step.
//
// WHY THE NAME IS NOW A LIE, AND WHY IT KEEPS IT. This function used to record a
// contractor self-certification against ORS 670.600. Screen 3 stopped asking the
// questions on 2026-05-25 (classification is the operator's responsibility, and
// citing Oregon statute did not generalise), but the function kept writing — the
// screen just sent five hardcoded booleans instead. The result on production was
// 23 rows, every one identical, every one stamped with the contractor's own IP
// address, attesting to specifics no instructor was ever shown.
//
// That is worse evidence than no record at all: an identical machine-generated
// answer across every contractor is what an auditor reads as pro-forma, and the
// agreement those people signed promises the opposite in as many words — "which
// the Contractor will confirm by separate self-certification in enrops".
//
// So the write is gone. The name stays because renaming a deployed function
// breaks every caller and every magic link in flight for no benefit; the header
// carries the truth instead.
//
// THE REAL RECORD ALREADY EXISTS AND IS UNAFFECTED:
// contractor_agreements.confirm_contractor_status is a NOT NULL boolean stored
// beside typed_signature, signed_at, ip_address, user_agent and
// agreement_text_snapshot. The contractor does attest to their status — on the
// screen where they actually read and sign something.
//
// The contractor_ors_certification TABLE IS DELIBERATELY LEFT IN PLACE, with its
// 23 existing rows untouched. What those rows represent is a separate decision;
// deleting evidence to tidy up would be the worst available option.
//
// Auth: verify_jwt: true. Instructor must be active and not in a terminal state.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
  clientIp,
} from '../_shared/instructor.ts';
import { advanceOnboardingStep } from '../_shared/onboardingStep.ts';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    // The body is deliberately ignored and deliberately NOT parsed-and-rejected.
    // Screen 3 now posts nothing, but an older cached bundle may still post the
    // hardcoded payload for a while after deploy; 400-ing those would strand
    // real instructors mid-wizard on a screen that has nothing to correct.
    // Whatever arrives, nothing is stored.

    const supabase = adminClient();
    const ip = clientIp(req);

    // The only reason this function still exists.
    const { error: stepErr } = await advanceOnboardingStep(supabase, {
      instructorId: me.id,
      orgId: me.organization_id,
      stepKey: 'ors_certification',
      nextStep: 4,
      ip,
    });
    if (stepErr) {
      // Now that nothing else happens here, a failed advance IS the failure —
      // there is no "the cert is saved anyway" consolation left. Surface it so
      // the screen can retry rather than moving someone on from a step that was
      // never recorded, which would strand them at the completion gate.
      console.error('onboarding step advance failed:', stepErr);
      return json({ error: 'step_advance_failed' }, 500);
    }

    return json({ success: true });
  } catch (err) {
    console.error('submit-ors-certification fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
