// Shared helper that translates a Stripe Account object into a
// contractor_onboarding_status update. Used by both the webhook (Function 3)
// and the user-triggered refresh (Function 16) so the status-decision logic
// stays in one place.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export interface AccountSnapshot {
  payouts_enabled: boolean;
  details_submitted: boolean;
  charges_enabled: boolean;
}

export interface ApplyResult {
  next_status: string;
  payouts_enabled: boolean;
  regressed: boolean; // true if payouts went from enabled → disabled
  changed: boolean; // true if anything got written
}

// Apply the account state to the onboarding row keyed by stripe_connect_
// account_id. Caller decides what to do with the result (run gate check,
// send alert email on regression, etc.). Returns null if no onboarding row
// exists for the given account ID (unknown account — webhook can safely 200,
// refresh can return 400).
export async function applyStripeAccountStatus(
  supabase: SupabaseClient,
  accountId: string,
  account: AccountSnapshot,
): Promise<ApplyResult | null> {
  const { data: row, error: fetchErr } = await supabase
    .from('contractor_onboarding_status')
    .select(
      'instructor_id, organization_id, stripe_connect_status, stripe_payouts_enabled'
    )
    .eq('stripe_connect_account_id', accountId)
    .maybeSingle();
  if (fetchErr) {
    console.error('stripe row fetch failed:', fetchErr);
    return null;
  }
  if (!row) return null;

  const prevPayouts = row.stripe_payouts_enabled === true;
  const prevStatus = row.stripe_connect_status as string | null;

  let nextStatus: string;
  if (account.payouts_enabled) {
    nextStatus = 'complete';
  } else if (prevPayouts) {
    // Regression: Stripe previously approved payouts and now turned them
    // off. Usually means verification info expired and contractor needs to
    // re-verify.
    nextStatus = 'payouts_disabled';
  } else if (account.details_submitted) {
    nextStatus = 'pending_verification';
  } else {
    nextStatus = 'onboarding_in_progress';
  }

  const regressed = prevPayouts && !account.payouts_enabled;
  const nextPayouts = account.payouts_enabled === true;

  const changed = nextStatus !== prevStatus || nextPayouts !== prevPayouts;
  if (changed) {
    const { error: updErr } = await supabase
      .from('contractor_onboarding_status')
      .update({
        stripe_connect_status: nextStatus,
        stripe_payouts_enabled: nextPayouts,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_connect_account_id', accountId);
    if (updErr) {
      console.error('stripe status update failed:', updErr);
    }
  }

  return {
    next_status: nextStatus,
    payouts_enabled: nextPayouts,
    regressed,
    changed,
  };
}
