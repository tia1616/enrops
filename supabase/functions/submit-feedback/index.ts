// submit-feedback: receives in-app feedback from a logged-in user, stores it
// in public.feedback (under the caller's JWT so RLS applies), and emails the
// platform support inbox so it reaches a human immediately.
//
// Input (POST JSON): { organization_id, message, page_url?, page_path?, user_agent? }
// Auth: requires a valid user JWT (verify_jwt). Identity (uid + email) is read
// from the JWT, never trusted from the body. organization_id is taken from the
// body but RLS (WITH CHECK is_org_member) blocks filing under a foreign org.
//
// The feedback row is the durable record; the email is the reach-a-human path.
// Email failure never fails the request — the row is already saved.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// Platform support inbox — overridable via env; defaults to the founder address.
const NOTIFY_EMAIL = Deno.env.get('FEEDBACK_NOTIFY_EMAIL') ?? 'jessica@journeytosteam.com';
const FROM_EMAIL = 'Enrops <hello@updates.journeytosteam.com>';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Not signed in' }, 401);

    // User-context client: inserts run under the caller's RLS context.
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({}));
    const organization_id = String(body.organization_id ?? '').trim();
    const message = String(body.message ?? '').trim();
    const page_url = body.page_url ? String(body.page_url).slice(0, 2000) : null;
    const page_path = body.page_path ? String(body.page_path).slice(0, 1000) : null;
    const user_agent = body.user_agent ? String(body.user_agent).slice(0, 1000) : null;

    if (!organization_id) return json({ error: 'Missing organization' }, 400);
    if (!message) return json({ error: 'Please enter some feedback' }, 400);
    if (message.length > 5000) return json({ error: 'Feedback is too long (5000 char max)' }, 400);

    // Insert under the caller's JWT — RLS enforces org membership + uid match.
    const { data: inserted, error: insErr } = await supabase
      .from('feedback')
      .insert({
        organization_id,
        auth_user_id: user.id,
        user_email: user.email ?? null,
        message,
        page_url,
        page_path,
        user_agent,
      })
      .select('id, created_at')
      .single();

    if (insErr) {
      // RLS denial or a DB error surfaces here. Log the detail server-side;
      // never leak internal Postgres/RLS messages to the browser.
      console.error('submit-feedback insert failed:', insErr.message);
      return json({ error: 'Could not save your feedback. Please try again.' }, 400);
    }

    // Best-effort org name for the email (caller can read their own org).
    let orgName = organization_id;
    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', organization_id)
      .maybeSingle();
    if (org?.name) orgName = org.name;

    // Notify the platform inbox. Never fail the request on email error.
    let emailed = false;
    try {
      const where = page_path ?? page_url ?? 'unknown';
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5">
          <h2 style="color:#1C004F;margin:0 0 12px">New Enrops feedback</h2>
          <p style="margin:0 0 4px"><strong>From:</strong> ${esc(user.email ?? 'unknown')}</p>
          <p style="margin:0 0 4px"><strong>Provider:</strong> ${esc(orgName)}</p>
          <p style="margin:0 0 12px"><strong>Page:</strong> ${esc(where)}</p>
          <div style="background:#F2F0FF;border:1px solid #e2dfd5;border-radius:10px;padding:14px 16px;white-space:pre-wrap">${esc(message)}</div>
          <p style="color:#6b6b6b;font-size:12px;margin-top:16px">Reply to this email to respond directly to ${esc(user.email ?? 'the sender')}.</p>
        </div>`;
      const text = `New Enrops feedback\nFrom: ${user.email ?? 'unknown'}\nProvider: ${orgName}\nPage: ${where}\n\n${message}`;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: NOTIFY_EMAIL,
          reply_to: user.email ?? undefined,
          subject: `[Enrops feedback] ${orgName} — ${user.email ?? 'user'}`,
          html,
          text,
        }),
      });
      emailed = r.ok;
    } catch (_e) {
      emailed = false;
    }

    return json({ ok: true, id: inserted?.id, emailed }, 200);
  } catch (e) {
    console.error('submit-feedback unexpected error:', String(e));
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
