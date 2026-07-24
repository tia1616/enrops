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

    const session = await stripe.checkout.sessions.retrieve(session_id);
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
    console.error('checkout-session-status error:', err);
    // Fail safe: assume settled so we never alarm a card payer with a false
    // "processing" note. ACH families also saw the 1-3 day note at StepPay.
    return json({ paid: true, processing: false, calendar: null });
  }
});
