// update-onboarding-step — generic step advancer for the wizard's non-legal-record steps.
//
// The legal records (acks, agreements, ORS cert) have their own dedicated
// functions because the data they write is large and has specific validation.
// This function handles everything else:
//
//   step_name = 'welcome'             — Screen 1: update phone + photo_url
//   step_name = 'checkr_submitted'    — Screen 2: marker only (Function 9 makes the actual Checkr call)
//   step_name = 'stripe_submitted'    — Screen 7: marker only, set ONLY on Stripe successful return
//   step_name = 'emergency_and_prefs' — Screen 8: emergency contacts, CPR cert,
//                                       shirt size. Runs the final gate check.
//                                       (Site/district preferences + day-of-week
//                                       availability are collected in the separate
//                                       per-cycle availability survey, not here.)
//
// The Screen 8 handler is the largest: it deletes existing emergency contacts
// (chunk 1 has a partial unique index that makes UPSERT awkward) and inserts
// the new set with is_primary derived from array position. After saving it
// runs the gate check that decides overall_status (complete / pending_background_check
// / pending_stripe).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
  clientIp,
} from '../_shared/instructor.ts';
import { advanceOnboardingStep, StepKey } from '../_shared/onboardingStep.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

interface UpdateStepBody {
  step_name?: string;
  step_data?: Record<string, unknown>;
}

// step_name → next current_step
const NEXT_STEP: Record<string, number> = {
  welcome: 2,
  checkr_submitted: 3,
  stripe_submitted: 8,
  emergency_and_prefs: 8, // last step; gate check decides overall_status
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: UpdateStepBody;
    try {
      body = (await req.json()) as UpdateStepBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const stepName = body.step_name?.trim();
    if (!stepName || !(stepName in NEXT_STEP)) {
      return json(
        { error: 'invalid_step_name', expected: Object.keys(NEXT_STEP) },
        400,
      );
    }

    const supabase = adminClient();
    const ip = clientIp(req);
    const data = (body.step_data ?? {}) as Record<string, unknown>;

    // Dispatch on step_name
    if (stepName === 'welcome') {
      const welcomeRes = await handleWelcome(supabase, me.id, data);
      if (welcomeRes.error) return welcomeRes.error;
    } else if (stepName === 'emergency_and_prefs') {
      const emergencyRes = await handleEmergencyAndPrefs(supabase, me.id, me.organization_id, data);
      if (emergencyRes.error) return emergencyRes.error;
    }
    // 'checkr_submitted' and 'stripe_submitted' are pure markers — no data to write.

    // Advance the step in contractor_onboarding_status.
    const stepKeyForOnboarding = stepName as StepKey;
    const { error: stepErr } = await advanceOnboardingStep(supabase, {
      instructorId: me.id,
      orgId: me.organization_id,
      stepKey: stepKeyForOnboarding,
      nextStep: NEXT_STEP[stepName],
      ip,
    });
    if (stepErr) {
      console.error('onboarding step advance failed:', stepErr);
      return json({ error: 'step_advance_failed' }, 500);
    }

    // After Screen 8 we run the gate check that decides overall_status.
    if (stepName === 'emergency_and_prefs') {
      const gateRes = await runGateCheck(supabase, me.id);
      return json({ success: true, gate: gateRes });
    }

    return json({ success: true });
  } catch (err) {
    console.error('update-onboarding-step fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Screen 1: welcome — update instructors.phone, photo_url
// ────────────────────────────────────────────────────────────────────────────

async function handleWelcome(
  supabase: SupabaseClient,
  instructorId: string,
  data: Record<string, unknown>,
): Promise<{ error?: Response }> {
  const phone = sanitizeString(data.phone);
  const photoUrl = sanitizeString(data.photo_url);
  const preferredName = sanitizeString(data.preferred_name);

  if (!phone) return { error: json({ error: 'phone_required' }, 400) };

  const updates: Record<string, unknown> = {
    phone,
    updated_at: new Date().toISOString(),
  };
  if (photoUrl) updates.photo_url = photoUrl;
  // preferred_name is nullable — empty string clears it. We treat null
  // (field not sent) as "don't touch" and explicit empty string as "clear".
  if (typeof data.preferred_name === 'string') {
    updates.preferred_name = preferredName; // null if blank
  }

  const { error: updErr } = await supabase
    .from('instructors')
    .update(updates)
    .eq('id', instructorId);

  if (updErr) {
    console.error('welcome instructor update failed:', updErr);
    return { error: json({ error: 'update_failed' }, 500) };
  }
  return {};
}

// ────────────────────────────────────────────────────────────────────────────
// Screen 8: emergency_and_prefs — the big one.
// ────────────────────────────────────────────────────────────────────────────

interface EmergencyContactInput {
  contact_name?: string;
  relationship?: string;
  phone?: string;
}

async function handleEmergencyAndPrefs(
  supabase: SupabaseClient,
  instructorId: string,
  orgId: string,
  data: Record<string, unknown>,
): Promise<{ error?: Response }> {
  // ─── emergency_contacts validation ───
  const rawContacts = Array.isArray(data.emergency_contacts) ? data.emergency_contacts : [];
  if (rawContacts.length === 0) {
    return { error: json({ error: 'emergency_contact_required' }, 400) };
  }

  const contacts = rawContacts.map((c) => {
    const obj = c as EmergencyContactInput;
    return {
      contact_name: sanitizeString(obj.contact_name),
      relationship: sanitizeString(obj.relationship),
      phone: sanitizeString(obj.phone),
    };
  });

  const malformedContact = contacts.find(
    (c) => !c.contact_name || !c.relationship || !c.phone,
  );
  if (malformedContact) {
    return {
      error: json({ error: 'contact_fields_required', detail: 'name, relationship, phone' }, 400),
    };
  }

  // ─── DELETE existing emergency contacts, then INSERT the new set ───
  // (chunk 1's partial unique index makes UPSERT impractical; DELETE-then-INSERT
  // is the documented pattern in chunk 3.)
  const { error: delErr } = await supabase
    .from('contractor_emergency_contacts')
    .delete()
    .eq('instructor_id', instructorId);
  if (delErr) {
    console.error('emergency contacts delete failed:', delErr);
    return { error: json({ error: 'contacts_delete_failed' }, 500) };
  }

  const insertRows = contacts.map((c, idx) => ({
    instructor_id: instructorId,
    organization_id: orgId,
    contact_name: c.contact_name,
    relationship: c.relationship,
    phone: c.phone,
    is_primary: idx === 0, // first contact in array is the primary
  }));

  const { error: insErr } = await supabase
    .from('contractor_emergency_contacts')
    .insert(insertRows);
  if (insErr) {
    console.error('emergency contacts insert failed:', insErr);
    return { error: json({ error: 'contacts_insert_failed' }, 500) };
  }

  // ─── CPR cert + shirt size ───
  // Site/district preferences and day-of-week availability are intentionally
  // not handled here -- they belong to the per-cycle availability survey,
  // not to one-time onboarding. Ignore those fields silently if the client
  // sends them.
  const cprUrl = sanitizeString(data.first_aid_cpr_url);
  const cprExpiresAt = sanitizeDate(data.first_aid_cpr_expires_at);
  const shirtSize = sanitizeShirtSize(data.shirt_size);

  const instructorUpdates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (cprUrl !== null) instructorUpdates.first_aid_cpr_url = cprUrl;
  if (cprExpiresAt !== null) instructorUpdates.first_aid_cpr_expires_at = cprExpiresAt;
  // shirt_size is nullable; explicit empty string clears it.
  if (typeof data.shirt_size === 'string') {
    instructorUpdates.shirt_size = shirtSize; // null if blank or invalid
  }

  if (Object.keys(instructorUpdates).length > 1) {
    const { error: updErr } = await supabase
      .from('instructors')
      .update(instructorUpdates)
      .eq('id', instructorId);
    if (updErr) {
      console.error('instructor prefs update failed:', updErr);
      return { error: json({ error: 'prefs_update_failed' }, 500) };
    }
  }

  return {};
}

// ────────────────────────────────────────────────────────────────────────────
// Sanitizers
// ────────────────────────────────────────────────────────────────────────────

function sanitizeString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > 1000 ? t.slice(0, 1000) : t;
}

function sanitizeDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  // Expect YYYY-MM-DD. Lightweight regex check; Postgres will error on
  // anything malformed if it slips through.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

const SHIRT_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']);

function sanitizeShirtSize(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  if (!t) return null;
  // Reject anything not in the allowed set so the DB CHECK constraint never
  // throws on a typo from the client.
  return SHIRT_SIZES.has(t) ? t : null;
}
