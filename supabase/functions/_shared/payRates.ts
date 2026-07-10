// Single source of truth for instructor pay-rate resolution.
//
// Replaces the flat J2S rate card that was previously hardcoded and duplicated
// verbatim across four pay-writing functions (confirm-session-taught,
// confirm-session-delivery, session-confirmation-cron, confirm-sub-delivery).
// Rates now live per-tenant in the `tenant_pay_rates` table, keyed by
// (organization_id, role, session_type).
//
// IMPORTANT — no cross-tenant default. When a tenant has NOT configured a rate
// for a given (role, session_type), resolution returns null. The callers then
// leave pay_amount_cents null and the admin sets the amount on the Payroll
// screen (the existing graceful-null behavior). This is deliberate: the old
// hardcoded card meant every tenant silently inherited J2S's dollar amounts.
// Null-until-configured is the multi-tenant-correct floor — a provider's pay is
// their own, never J2S's by default.
//
// Edge functions call these with a service-role client, which bypasses RLS.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export type PayRole = 'lead' | 'developing';
export type PaySessionType = 'morning' | 'afternoon' | 'full_day' | 'after_school';

// key = `${role}|${session_type}` → amount_cents
export type PayRateMap = Map<string, number>;

function rateKey(role: string, sessionType: string): string {
  return `${role}|${sessionType}`;
}

function isPayRole(role: unknown): role is PayRole {
  return role === 'lead' || role === 'developing';
}

/**
 * Load every configured rate for one org into a map with a single query.
 * Use this in loops (e.g. session-confirmation-cron) so the DB is hit once per
 * org rather than once per confirmation row.
 */
export async function loadOrgPayRates(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<PayRateMap> {
  const { data, error } = await supabase
    .from('tenant_pay_rates')
    .select('role, session_type, amount_cents')
    .eq('organization_id', organizationId);
  if (error) {
    console.error('[payRates] loadOrgPayRates failed:', error);
    throw error;
  }
  const map: PayRateMap = new Map();
  for (const r of (data ?? []) as Array<{ role: string; session_type: string; amount_cents: number }>) {
    map.set(rateKey(r.role, r.session_type), r.amount_cents);
  }
  return map;
}

/**
 * Resolve one rate from a preloaded map. Returns null when the role/session_type
 * are unrecognized OR the tenant simply hasn't configured that cell.
 */
export function rateFromMap(
  map: PayRateMap,
  role: unknown,
  sessionType: unknown,
): number | null {
  if (!isPayRole(role)) return null;
  if (typeof sessionType !== 'string') return null;
  const v = map.get(rateKey(role, sessionType));
  return v === undefined ? null : v;
}

/**
 * Convenience single-lookup (one query) for the single-confirmation paths.
 * Returns null when the role/session_type are unrecognized OR the tenant hasn't
 * configured that cell — callers record a null pay_amount_cents in that case.
 */
export async function resolvePayAmount(
  supabase: SupabaseClient,
  organizationId: string,
  role: unknown,
  sessionType: unknown,
): Promise<number | null> {
  if (!isPayRole(role)) return null;
  if (typeof sessionType !== 'string') return null;
  const { data, error } = await supabase
    .from('tenant_pay_rates')
    .select('amount_cents')
    .eq('organization_id', organizationId)
    .eq('role', role)
    .eq('session_type', sessionType)
    .maybeSingle();
  if (error) {
    console.error('[payRates] resolvePayAmount failed:', error);
    throw error;
  }
  return data ? (data as { amount_cents: number }).amount_cents : null;
}
