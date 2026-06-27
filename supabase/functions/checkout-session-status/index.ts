// checkout-session-status — tells the (anonymous) registration success page
// whether the just-completed payment settled instantly (card) or is still
// processing (ACH/bank transfer). Used to show families an accurate
// "payment processing, 1-3 business days" note instead of implying it's done.
//
// Reads the Stripe Checkout Session directly (authoritative + no dependence on
// our webhook having processed yet). Returns a minimal, non-sensitive payload.
// verify_jwt = false (config.toml): the success page is anon.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

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

    return json({ paid, processing });
  } catch (err) {
    console.error('checkout-session-status error:', err);
    // Fail safe: assume settled so we never alarm a card payer with a false
    // "processing" note. ACH families also saw the 1-3 day note at StepPay.
    return json({ paid: true, processing: false });
  }
});
