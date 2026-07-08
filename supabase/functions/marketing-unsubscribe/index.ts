// Public marketing unsubscribe endpoint.
//
// Handles two cases:
// 1. GET with ?email&org&t — user clicked the link in an email. Verify HMAC,
//    insert suppression (idempotent), then 302-REDIRECT to the app's
//    /unsubscribed page. We can't render HTML here: the Supabase edge platform
//    force-serves function HTML as text/plain (anti-phishing), so a page returned
//    from this function shows as raw source. The SPA renders the confirmation.
// 2. POST with the same query params — Gmail/Yahoo one-click (RFC 8058). Same
//    verify + insert, return 200 JSON. No HTML body required.
//
// HMAC token is computed over `${lowercased_email}:${org_id}` using
// MARKETING_UNSUBSCRIBE_SECRET. Constant-time compare on verify.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = Deno.env.get('MARKETING_UNSUBSCRIBE_SECRET')!;
// Browser GET clicks redirect to this site's /unsubscribed page. The Supabase
// edge platform force-serves function HTML as text/plain (anti-phishing), so an
// HTML page returned here renders as raw source. A 302 to the app (enrops.com /
// staging site) sidesteps that — the browser follows the redirect and the SPA
// renders a real confirmation. Per-environment via PUBLIC_SITE_URL.
const PUBLIC_SITE = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');
function confirmationRedirect(params: Record<string, string>): Response {
  const qs = new URLSearchParams(params).toString();
  return Response.redirect(`${PUBLIC_SITE}/unsubscribed?${qs}`, 302);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const orgId = (url.searchParams.get('org') ?? '').trim();
  const token = (url.searchParams.get('t') ?? '').trim();

  if (!email || !orgId || !token) {
    return errorResponse(req, 400, 'Missing required parameters.');
  }

  let signatureOk = false;
  try {
    signatureOk = await verifyToken(email, orgId, token);
  } catch (_e) {
    signatureOk = false;
  }
  if (!signatureOk) {
    return errorResponse(req, 401, 'This unsubscribe link is invalid or has expired.');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Verify the org exists. Bail early if not — prevents arbitrary writes from a
  // leaked secret being used against a deleted/unknown org.
  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name, logo_url, logo_email_url')
    .eq('id', orgId)
    .maybeSingle();
  if (!org) {
    return errorResponse(req, 404, 'Organization not found.');
  }

  const userAgent = req.headers.get('user-agent') ?? null;
  const ipAddress =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('cf-connecting-ip') ??
    null;

  // RFC 8058: a POST without explicit form fields is the one-click flow.
  // GET = browser click on the link. Source distinguishes them for analytics.
  const source = req.method === 'POST' ? 'one_click' : 'link_click';

  // Idempotent: re-clicking the same link should not error.
  const { error: insertErr } = await supabase
    .from('marketing_suppressions')
    .insert({
      organization_id: orgId,
      email,
      source,
      user_agent: userAgent,
      ip_address: ipAddress,
    });
  // Unique-constraint violation (23505) means already suppressed — fine.
  if (insertErr && (insertErr as any).code !== '23505') {
    console.error('suppression insert failed:', insertErr);
    return errorResponse(req, 500, 'Something went wrong. Please reply to the email instead.');
  }

  // RFC 8058 one-click expects a simple 200. No body required.
  if (req.method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Browser click — redirect to the app's /unsubscribed page (see PUBLIC_SITE
  // note). It renders the confirmation with the org name; React escapes the
  // values, so email/name in the query string are display-safe.
  return confirmationRedirect({
    org: org.slug ?? '',
    name: org.name ?? '',
    email,
  });
});

// =====================================================================
// HMAC token verification
// =====================================================================

async function verifyToken(email: string, orgId: string, token: string): Promise<boolean> {
  const expected = await computeToken(email, orgId);
  return constantTimeEquals(expected, token);
}

async function computeToken(email: string, orgId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${email.toLowerCase()}:${orgId}`),
  );
  return base64UrlEncode(new Uint8Array(sig));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function errorResponse(req: Request, status: number, message: string): Response {
  if (req.method === 'POST') {
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  // Browser GET error — redirect to the app's /unsubscribed page in an error
  // state (it shows a generic "invalid or expired" message + a reply fallback).
  // Same reason as the success path: HTML returned here renders as raw source.
  return confirmationRedirect({ error: '1' });
}
