// admin-remove-registration — hard-delete a single registration from a roster.
//
// Used by /admin/rosters (both camps + afterschool) to remove a kid added by
// mistake or as a test. Money-safe: REFUSES to delete any registration that has
// a real payment on file (paid status, a Stripe payment intent, or any paid
// installment). Those must be cancelled/refunded from the Money tab instead —
// deleting them would destroy the financial record.
//
// Body: { registration_id: string }
// Auth: caller must be org_members owner/admin in the registration's org.
// Returns: { ok: true, deleted: registration_id } | { error: 'has_payment' } | ...

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // 1. Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // 2. Body
    let body: { registration_id?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const registrationId = body.registration_id?.trim();
    if (!registrationId) return json({ error: 'registration_id_required' }, 400);

    // 3. Load the registration
    const { data: reg, error: rErr } = await supabase
      .from('registrations')
      .select('id, organization_id, payment_status, stripe_payment_intent_id, student_id')
      .eq('id', registrationId)
      .maybeSingle();
    if (rErr) {
      console.error('registration lookup failed:', rErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!reg) return json({ error: 'forbidden' }, 403);

    // 4. Caller must be owner/admin of the registration's org
    const { data: member, error: memErr } = await supabase
      .from('org_members')
      .select('organization_id')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', reg.organization_id)
      .in('role', ['owner', 'admin'])
      .maybeSingle();
    if (memErr) {
      console.error('org_members lookup failed:', memErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!member) return json({ error: 'forbidden' }, 403);

    // 5. Money guard — never hard-delete a registration with a real payment.
    if (reg.payment_status === 'paid' || reg.stripe_payment_intent_id) {
      return json({ error: 'has_payment' }, 409);
    }
    const { data: paidInstallments } = await supabase
      .from('installments')
      .select('id')
      .eq('registration_id', registrationId)
      .eq('status', 'paid')
      .limit(1);
    if (paidInstallments && paidInstallments.length > 0) {
      return json({ error: 'has_payment' }, 409);
    }

    // 6. Delete child rows whose FK is NO ACTION (would otherwise block the
    //    delete): installments + waiver_signatures. refunds cascade on their
    //    own, and a row with refunds would have been caught by the money guard.
    await supabase.from('installments').delete().eq('registration_id', registrationId);
    await supabase.from('waiver_signatures').delete().eq('registration_id', registrationId);

    const { error: delErr } = await supabase
      .from('registrations')
      .delete()
      .eq('id', registrationId);
    if (delErr) {
      console.error('registration delete failed:', delErr);
      return json({ error: 'delete_failed', detail: delErr.message }, 500);
    }

    return json({ ok: true, deleted: registrationId });
  } catch (err) {
    console.error('admin-remove-registration fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
