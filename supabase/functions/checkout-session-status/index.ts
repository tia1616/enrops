// checkout-session-status — tells the (anonymous) registration success page
// whether the just-completed payment settled instantly (card) or is still
// processing (ACH/bank transfer), AND returns a tenant-neutral calendar invite
// (real, closure-aware session dates) so the success page can offer an
// "Add to calendar" button (.ics download + Google Calendar quick-add).
//
// Reads the Stripe Checkout Session directly (authoritative + no dependence on
// our webhook having processed yet). The calendar payload is best-effort: any
// failure leaves paid/processing intact so the page never breaks. Gated by
// possession of the Stripe session_id — the same non-sensitive scope as the
// paid/processing signal (program schedule, no extra PII).
// verify_jwt = false (config.toml): the success page is anon.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { buildIcs, googleCalendarUrl, calendarEventsFromRegistrations } from '../_shared/calendarInvite.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// Build the tenant-neutral calendar payload for a completed checkout session.
// Best-effort: returns null on any problem so the caller can omit it.
async function buildCalendarPayload(sessionId: string, metaRegIds: string) {
  const regIds = (metaRegIds || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!regIds.length) return null;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: regs } = await admin
    .from('registrations')
    .select(
      `id, organization_id, programs(id, curriculum, start_time, end_time, first_session_date, program_locations(name, address)), students(first_name, last_name)`,
    )
    .in('id', regIds);
  if (!regs?.length) return null;

  // Org name for event titles — from the org's own row, never a tenant literal.
  const orgId = (regs[0] as { organization_id?: string }).organization_id;
  let orgName = 'your provider';
  if (orgId) {
    const { data: org } = await admin.from('organizations').select('name').eq('id', orgId).maybeSingle();
    if (org?.name) orgName = org.name;
  }

  const events = await calendarEventsFromRegistrations(
    regs as unknown as Parameters<typeof calendarEventsFromRegistrations>[0],
    orgName,
    async (pid: string) => {
      const { data } = await admin.rpc('derive_program_session_dates', { p_program_id: pid });
      return (data as string[] | null) ?? [];
    },
  );
  // This endpoint is anon (verify_jwt=false) and reachable by anyone holding the
  // Stripe session id (it rides in the success-page URL, so it can leak via
  // Referer). Expose only the child's FIRST name here. The emailed .ics goes to
  // the verified parent inbox and keeps the full name (built separately in
  // stripe-webhook).
  for (const e of events) {
    if (e.studentName) e.studentName = e.studentName.split(' ')[0];
  }
  const ics = buildIcs(events, { uidSeed: sessionId, nowIso: new Date().toISOString() });
  if (!ics) return null;

  const totalSessions = events.reduce((n, e) => n + e.sessionDates.length, 0);
  return {
    ics,
    totalSessions,
    events: events.map((e) => ({ programName: e.programName, googleUrl: googleCalendarUrl(e) })),
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { session_id } = await req.json();
    if (!session_id || typeof session_id !== 'string') return json({ error: 'Missing session_id' }, 400);

    // Phase 2: a DIRECT org's Checkout Session lives on its connected account,
    // so an unscoped retrieve 404s — and this function's catch-all fails OPEN
    // to {paid:true}, which would show a family a success page for a payment
    // that never settled. Resolve the right scope before retrieving.
    //
    // The scope comes from OUR OWN row: create-checkout stamped
    // stripe_checkout_session_id + stripe_charge_account_id on the registrations
    // before redirecting the family. No client input is involved, and it is the
    // account THIS session was created on rather than whatever model the org is
    // set to now — an operator who moves to direct charges gets a brand-new
    // connected account, and their older sessions stay on the platform.
    //
    // Not found (every registration created before this shipped, and any $0 comp
    // flow) → undefined → the platform-scoped retrieve, which is exactly right
    // for all of them. undefined, never {}: stripe-node treats an empty options
    // object as a stray argument and throws "Unknown arguments".
    let sessionScope: { stripeAccount: string } | undefined = undefined;
    try {
      const scopeAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const { data: regRow } = await scopeAdmin
        .from('registrations')
        .select('stripe_charge_account_id')
        .eq('stripe_checkout_session_id', session_id)
        .not('stripe_charge_account_id', 'is', null)
        .limit(1)
        .maybeSingle();
      if (regRow?.stripe_charge_account_id) {
        sessionScope = { stripeAccount: regRow.stripe_charge_account_id as string };
      }
    } catch (scopeErr) {
      // Non-fatal: fall through to the platform-scoped retrieve below.
      console.error('checkout-session-status scope lookup failed:', scopeErr);
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, sessionScope);
    // Card: payment_status === 'paid' on completion. ACH: session completes but
    // payment_status stays 'unpaid' until the bank transfer clears (days later).
    const paid = session.payment_status === 'paid';
    const processing = session.status === 'complete' && !paid;

    // Best-effort calendar invite — never let it break the paid/processing read.
    let calendar = null;
    try {
      calendar = await buildCalendarPayload(session_id, (session.metadata?.registration_ids as string) || '');
    } catch (calErr) {
      console.error('checkout-session-status calendar error:', calErr);
    }

    return json({ paid, processing, calendar });
  } catch (err) {
    // Fail safe: assume settled so we never alarm a card payer with a false
    // "processing" note. ACH families also saw the 1-3 day note at StepPay.
    //
    // Logged at error level with the session id BECAUSE this path is silent to
    // the family: if a direct org ever lands here it means the scope lookup
    // above didn't resolve (stale client not sending org_slug), and we are
    // showing "paid" without having confirmed it. That is the one thing worth
    // grepping the logs for after any direct-charge deploy.
    console.error('checkout-session-status error (FAILING OPEN to paid=true):', err);
    return json({ paid: true, processing: false, calendar: null });
  }
});
