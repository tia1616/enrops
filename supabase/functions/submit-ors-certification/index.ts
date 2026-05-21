// submit-ors-certification — Screen 3 of the contractor onboarding wizard.
//
// The instructor self-certifies they meet at least 3 of 5 ORS 670.600 criteria
// for independent-contractor status in Oregon. This is a legal record — the
// table has UNIQUE(instructor_id, organization_id) so resubmissions update
// the same row in place (latest data wins).
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

interface SubmitOrsBody {
  separate_business_location?: boolean;
  bears_risk_of_loss?: boolean;
  multiple_clients?: boolean;
  significant_investment?: boolean;
  authority_to_hire?: boolean;
  separate_business_location_text?: string | null;
  bears_risk_of_loss_text?: string | null;
  multiple_clients_text?: string | null;
  significant_investment_text?: string | null;
  authority_to_hire_text?: string | null;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: SubmitOrsBody;
    try {
      body = (await req.json()) as SubmitOrsBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    // Coerce each criterion to a strict boolean — anything truthy/falsy is
    // fine, but `criteria_met` counts must be exact.
    const criteria = {
      separate_business_location: Boolean(body.separate_business_location),
      bears_risk_of_loss: Boolean(body.bears_risk_of_loss),
      multiple_clients: Boolean(body.multiple_clients),
      significant_investment: Boolean(body.significant_investment),
      authority_to_hire: Boolean(body.authority_to_hire),
    };
    const criteriaMet = Object.values(criteria).filter(Boolean).length;

    if (criteriaMet < 3) {
      // The wizard frontend handles the "go back / confirm decline" UX from
      // this 400. Function 7 (submit-onboarding-declined) is the path for
      // actual decline; this function does NOT auto-decline.
      return json(
        { error: 'insufficient_criteria', criteria_met: criteriaMet },
        400,
      );
    }

    // Sanitize text fields: trim, treat empty as null, cap length defensively
    const cleanText = (s: string | null | undefined): string | null => {
      if (!s) return null;
      const t = s.trim();
      if (!t) return null;
      return t.length > 4000 ? t.slice(0, 4000) : t;
    };

    const supabase = adminClient();
    const ip = clientIp(req);

    // UPSERT — chunk 1 has UNIQUE(instructor_id, organization_id), so the
    // ON CONFLICT clause overwrites the same row when the instructor resubmits.
    // certified_at is set to now() on update so the timestamp reflects the
    // most recent finalization.
    const { error: upsertErr } = await supabase
      .from('contractor_ors_certification')
      .upsert(
        {
          instructor_id: me.id,
          organization_id: me.organization_id,
          separate_business_location: criteria.separate_business_location,
          bears_risk_of_loss: criteria.bears_risk_of_loss,
          multiple_clients: criteria.multiple_clients,
          significant_investment: criteria.significant_investment,
          authority_to_hire: criteria.authority_to_hire,
          separate_business_location_text: cleanText(body.separate_business_location_text),
          bears_risk_of_loss_text: cleanText(body.bears_risk_of_loss_text),
          multiple_clients_text: cleanText(body.multiple_clients_text),
          significant_investment_text: cleanText(body.significant_investment_text),
          authority_to_hire_text: cleanText(body.authority_to_hire_text),
          criteria_met: criteriaMet,
          certified_at: new Date().toISOString(),
          ip_address: ip,
        },
        { onConflict: 'instructor_id,organization_id' },
      );

    if (upsertErr) {
      console.error('ors upsert failed:', upsertErr);
      return json({ error: 'upsert_failed' }, 500);
    }

    // Advance onboarding step. ORS = step 3 → next current_step = 4.
    const nowIso = new Date().toISOString();
    const { error: stepErr } = await advanceOnboardingStep(supabase, {
      instructorId: me.id,
      orgId: me.organization_id,
      stepKey: 'ors_certification',
      nextStep: 4,
      ip,
    });
    if (stepErr) {
      console.error('onboarding step advance failed:', stepErr);
      // Don't 500 the whole submission — the cert is saved. The wizard
      // will re-attempt step advancement on next load. Log and move on.
    }

    return json({ success: true, criteria_met: criteriaMet, certified_at: nowIso });
  } catch (err) {
    console.error('submit-ors-certification fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
