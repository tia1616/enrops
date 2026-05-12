// Public marketing unsubscribe endpoint.
//
// Handles two cases:
// 1. GET with ?email&org&t — user clicked the link in an email. Verify HMAC,
//    insert suppression (idempotent), render a branded confirmation page.
// 2. POST with the same query params — Gmail/Yahoo one-click (RFC 8058). Same
//    verify + insert, return 200 JSON. No HTML body required.
//
// HMAC token is computed over `${lowercased_email}:${org_id}` using
// MARKETING_UNSUBSCRIBE_SECRET. Constant-time compare on verify.
//
// Tenant-aware: confirmation page reads org_branding + organizations so other
// tenants get their own colors, logo, and name without any code change.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = Deno.env.get('MARKETING_UNSUBSCRIBE_SECRET')!;

const DEFAULT_PRIMARY = '#674EE8';
const DEFAULT_ACCENT = '#F8A638';
const DEFAULT_PAGE_BG = '#f5f5f7';
const DEFAULT_FONT_STACK = "-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif";

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
    .select('id, name, logo_url, logo_email_url')
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

  // Browser click — render a branded confirmation page using the org's colors.
  const branding = await loadBranding(supabase, orgId);
  const html = renderConfirmationPage(email, org, branding);
  return new Response(html, {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
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

// =====================================================================
// Branding + rendering
// =====================================================================

type Branding = {
  primary: string;
  accent: string;
  pageBg: string;
  bodyFontStack: string;
  headingFontStack: string;
  googleFontsUrl: string | null;
};

async function loadBranding(supabase: any, orgId: string): Promise<Branding> {
  const { data: b } = await supabase
    .from('org_branding')
    .select('primary_color, accent_color, page_bg_color, heading_font, body_font')
    .eq('organization_id', orgId)
    .maybeSingle();

  let headingStack = DEFAULT_FONT_STACK;
  let bodyStack = DEFAULT_FONT_STACK;
  const fontParams: string[] = [];

  const fontNames = [b?.heading_font, b?.body_font].filter(Boolean) as string[];
  if (fontNames.length > 0) {
    const { data: fonts } = await supabase
      .from('available_fonts')
      .select('name, google_fonts_param, fallback_stack')
      .in('name', fontNames);
    const byName = new Map<string, { name: string; google_fonts_param: string; fallback_stack: string }>(
      (fonts ?? []).map((f: any) => [f.name, f]),
    );
    if (b?.heading_font && byName.has(b.heading_font)) {
      const f = byName.get(b.heading_font)!;
      headingStack = `'${f.name}',${f.fallback_stack}`;
      fontParams.push(f.google_fonts_param);
    }
    if (b?.body_font && byName.has(b.body_font)) {
      const f = byName.get(b.body_font)!;
      bodyStack = `'${f.name}',${f.fallback_stack}`;
      fontParams.push(f.google_fonts_param);
    }
  }

  return {
    primary: b?.primary_color ?? DEFAULT_PRIMARY,
    accent: b?.accent_color ?? DEFAULT_ACCENT,
    pageBg: b?.page_bg_color ?? DEFAULT_PAGE_BG,
    bodyFontStack: bodyStack,
    headingFontStack: headingStack,
    googleFontsUrl: fontParams.length > 0
      ? `https://fonts.googleapis.com/css2?${fontParams.map(p => `family=${p}`).join('&')}&display=swap`
      : null,
  };
}

function renderConfirmationPage(
  email: string,
  org: { name: string; logo_url: string | null; logo_email_url: string | null },
  branding: Branding,
): string {
  const fontsLink = branding.googleFontsUrl
    ? `<link rel="stylesheet" href="${escapeHtml(branding.googleFontsUrl)}">`
    : '';
  const logoUrl = org.logo_email_url ?? org.logo_url;
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(org.name)}" style="width:160px;height:auto;display:block;margin:0 auto 24px;" />`
    : `<p style="margin:0 0 24px;font-family:${branding.headingFontStack};font-size:22px;font-weight:700;color:${branding.primary};">${escapeHtml(org.name)}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed from ${escapeHtml(org.name)}</title>
${fontsLink}
<style>
  body { margin:0; padding:0; background:${branding.pageBg}; font-family:${branding.bodyFontStack}; color:#1f2937; line-height:1.55; }
  .wrap { max-width:520px; margin:0 auto; padding:48px 20px; text-align:center; }
  .card { background:#ffffff; border:1px solid #e5e7eb; border-radius:14px; padding:40px 32px; }
  h1 { font-family:${branding.headingFontStack}; font-size:26px; margin:0 0 12px; color:#1f2937; }
  p { font-size:16px; margin:0 0 12px; }
  .email { font-weight:600; color:${branding.primary}; word-break:break-all; }
  .muted { color:#6b7280; font-size:14px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    ${logo}
    <h1>You're unsubscribed.</h1>
    <p>We won't send any more marketing emails to <span class="email">${escapeHtml(email)}</span>.</p>
    <p class="muted">If you signed up by mistake or change your mind, just reply to any past email from us and we'll add you back.</p>
  </div>
</div>
</body>
</html>`;
}

function errorResponse(req: Request, status: number, message: string): Response {
  if (req.method === 'POST') {
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title>
<style>
  body { margin:0; padding:0; background:#f5f5f7; font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif; color:#1f2937; }
  .wrap { max-width:520px; margin:0 auto; padding:48px 20px; text-align:center; }
  .card { background:#ffffff; border:1px solid #e5e7eb; border-radius:14px; padding:40px 32px; }
  h1 { font-size:22px; margin:0 0 12px; }
  p { font-size:16px; margin:0; color:#6b7280; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>We couldn't process that request.</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
