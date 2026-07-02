// logPlatformEvent — the way edge functions record PLATFORM-USAGE events (what
// operators do across the app). Sibling to logEnrollmentEvent.ts; calls the
// public.log_platform_event() doorway (SECURITY DEFINER, service_role only) which
// writes the sealed, append-only intelligence.platform_events table.
//
// CONTRACT (see docs/moat/INTELLIGENCE_LAYER_RULES.md):
//   1. FAIL-SAFE — never throws. A failed log must not break the operator action.
//   2. Use the FEATURE / ACTION constants — never a string literal at the call site.
//   3. PII — metadata holds IDs + facts ONLY. Never names, emails, or phones.
//   4. Fire on BOTH outcomes: success at the happy path, 'fail' at the error path.
//   5. dedupeKey for anything retriable (e.g. a stripe/session id).

// NOTE: the client param is typed `any` (not SupabaseClient) on purpose. Different
// edge fns import supabase-js via slightly different esm.sh build URLs (e.g. a
// pinned v135 path), which TypeScript treats as INCOMPATIBLE SupabaseClient types.
// We only ever call `.rpc()` on it, so `any` accepts a client from any build.

// THE TAXONOMY — single source of truth for platform-usage events (server-side).
export const FEATURE = {
  CAMPAIGNS: 'campaigns',
  AUTOMATIONS: 'automations',
  CONTACTS: 'contacts',
  SCHEDULING: 'scheduling',
  PROGRAMS: 'programs',
  ROSTERS: 'rosters',
  CURRICULA: 'curricula',
  INSTRUCTORS: 'instructors',
  PAYROLL: 'payroll',
  FINANCES: 'finances',
  PARTNERS: 'partners',
  WAIVERS: 'waivers',
  TEAM: 'team',
  ENNIE: 'ennie',
} as const;

export const ACTION = {
  // campaigns
  CAMPAIGN_DRAFTED: 'campaign_drafted',
  CAMPAIGN_SENT: 'campaign_sent',
  // scheduling
  INSTRUCTORS_MATCHED: 'instructors_matched',
  OFFER_SENT: 'offer_sent',
  SUB_ASSIGNED: 'sub_assigned',
  // rosters
  ROSTER_IMPORTED: 'roster_imported',
  FAMILIES_INVITED: 'families_invited',
  // curricula
  CURRICULUM_EXTRACTED: 'curriculum_extracted',
  // instructors
  INSTRUCTOR_INVITED: 'instructor_invited',
  BACKGROUND_CHECK_UPLOADED: 'background_check_uploaded',
  // finances / payroll
  STRIPE_CONNECTED: 'stripe_connected',
  INSTRUCTOR_PAID: 'instructor_paid',
  // contacts / partners
  CONTACTS_IMPORTED: 'contacts_imported',
  PARTNERS_IMPORTED: 'partners_imported',
  // ennie
  ENNIE_USED: 'ennie_used',
  // NOTE: programs (program_created/published) + payroll_approved are captured by
  // DB triggers, not here — they are pure client-side table writes.
} as const;

export const OUTCOME = { SUCCESS: 'success', FAIL: 'fail' } as const;

export interface LogPlatformEventArgs {
  feature: string;
  action: string;
  outcome?: 'success' | 'fail';
  organizationId?: string | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>; // IDs + facts ONLY — never PII
  dedupeKey?: string | null;
  occurredAt?: string | null;
}

// deno-lint-ignore no-explicit-any
export async function logPlatformEvent(admin: any, args: LogPlatformEventArgs): Promise<void> {
  try {
    const { error } = await admin.rpc('log_platform_event', {
      p_feature: args.feature,
      p_action: args.action,
      p_outcome: args.outcome ?? 'success',
      p_organization_id: args.organizationId ?? null,
      p_actor_user_id: args.actorUserId ?? null,
      p_metadata: args.metadata ?? {},
      p_occurred_at: args.occurredAt ?? null,
      p_dedupe_key: args.dedupeKey ?? null,
    });
    if (error) console.error(`[intelligence] log_platform_event(${args.feature}/${args.action}) failed:`, error.message);
  } catch (e) {
    // Swallow — telemetry must never break the operational path.
    console.error(`[intelligence] log_platform_event(${args.feature}/${args.action}) threw:`, (e as Error).message);
  }
}
