// logEnrollmentEvent — the ONLY way edge functions write to the intelligence layer.
//
// Calls the public.log_enrollment_event() doorway (SECURITY DEFINER, service_role
// EXECUTE only), which inserts into the sealed, append-only intelligence schema.
//
// CONTRACT (see docs/moat/INTELLIGENCE_LAYER_RULES.md):
//   1. FAIL-SAFE — this function NEVER throws. A failed event log must not break a
//      registration, payment, or any operational path. Worst case is a missing event.
//   2. Use the ENROLLMENT_ACTIONS constants — never a string literal at the call site.
//      A typo silently fragments the data (the DB has no enum on purpose).
//   3. PII — metadata holds IDs and facts ONLY. Never raw names, emails, or phones.
//   4. Idempotency — pass dedupeKey (e.g. the Stripe event id) for events that can
//      be retried; the doorway no-ops on a repeat.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export const ENROLLMENT_ACTIONS = {
  INITIATED: 'initiated',                     // checkout session created
  PAYMENT_COMPLETED: 'payment_completed',     // payment succeeded
  WAITLIST_ADDED: 'waitlist_added',
  WAITLIST_CONVERTED: 'waitlist_converted',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
} as const;

export type EnrollmentAction = typeof ENROLLMENT_ACTIONS[keyof typeof ENROLLMENT_ACTIONS];

export interface LogEnrollmentEventArgs {
  actionType: EnrollmentAction;
  organizationId?: string | null;
  parentId?: string | null;
  studentId?: string | null;
  programId?: string | null;       // afterschool
  campSessionId?: string | null;   // camps
  siteId?: string | null;          // program_location
  registrationId?: string | null;
  metadata?: Record<string, unknown>;  // IDs + facts ONLY — never PII
  dedupeKey?: string | null;            // e.g. `payment_completed:${stripeEventId}:${regId}`
  occurredAt?: string | null;           // ISO; defaults to now()
}

// deno-lint-ignore no-explicit-any
export async function logEnrollmentEvent(admin: SupabaseClient<any>, args: LogEnrollmentEventArgs): Promise<void> {
  try {
    const { error } = await admin.rpc('log_enrollment_event', {
      p_action_type: args.actionType,
      p_organization_id: args.organizationId ?? null,
      p_parent_id: args.parentId ?? null,
      p_student_id: args.studentId ?? null,
      p_program_id: args.programId ?? null,
      p_camp_session_id: args.campSessionId ?? null,
      p_site_id: args.siteId ?? null,
      p_registration_id: args.registrationId ?? null,
      p_metadata: args.metadata ?? {},
      p_occurred_at: args.occurredAt ?? null,
      p_dedupe_key: args.dedupeKey ?? null,
    });
    if (error) {
      console.error(`[intelligence] log_enrollment_event(${args.actionType}) failed:`, error.message);
    }
  } catch (e) {
    // Swallow — never let telemetry break the operational path.
    console.error(`[intelligence] log_enrollment_event(${args.actionType}) threw:`, (e as Error).message);
  }
}
