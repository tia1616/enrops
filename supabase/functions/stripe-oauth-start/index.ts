// stripe-oauth-start — mint the URL that lets an operator connect the Stripe
// account they ALREADY HAVE.
//
// THE GAP THIS CLOSES. stripe-connect-onboard calls stripe.accounts.create, which
// always mints a BRAND NEW Stripe account. Stripe's "networked onboarding" offers
// to reuse an existing account's verified details, but per Stripe's docs it
// "creates a new connected account while reusing and sharing verified information
// from the existing account" - it does not connect the account. So until now,
// every operator got a new Stripe account whether they wanted one or not, and the
// Finances screen told them otherwise.
//
// Connect OAuth is the mechanism that attaches an account that already exists:
// "The process of creating a Stripe account is incorporated into our
// authorization flow. You don't need to worry about whether or not your users
// already have accounts." Verified empirically 2026-07-29 - the authorize screen
// lists the operator's existing accounts to pick from.
//
// SECURITY. This endpoint is the ONLY place that decides which org a connect flow
// belongs to. The callback is a browser redirect from Stripe with no JWT, so it
// cannot re-derive that; it can only trust the state token minted here. Hence:
// owner/admin is checked HERE, the state is a single-use row in
// stripe_oauth_states, and it expires in 10 minutes.
//
// Env: STRIPE_CONNECT_CLIENT_ID (the ca_... from Connect > Settings > OAuth).
// Test mode and live mode have DIFFERENT client IDs; each environment holds its
// own, which is why this reads a secret rather than hardcoding.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

const CLIENT_ID = Deno.env.get('STRIPE_CONNECT_CLIENT_ID') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

// How long an operator has between clicking "Connect" and finishing at Stripe.
// Long enough to sign in and pick an account, short enough that an abandoned
// token is not lying around.
const STATE_TTL_MINUTES = 10;

interface RequestBody {
  org_id?: string;
  /** Where to send the operator after the callback finishes. Validated below. */
  origin?: string;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    if (!CLIENT_ID) {
      console.error('[oauth-start] STRIPE_CONNECT_CLIENT_ID is not set');
      return json({ error: 'platform_misconfigured' }, 500);
    }

    // ── auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      // optional body
    }
    const origin = sanitizeOrigin(body.origin) || DEFAULT_ORIGIN;

    // ── resolve the org, and prove the caller may act for it ──────────────
    // Same shape as stripe-connect-onboard so the two connect paths cannot
    // disagree about who is allowed to connect an account.
    // .limit(1) on BOTH branches, and the error is distinguished from "no match".
    //
    // A bare .maybeSingle() RESOLVES WITH AN ERROR when more than one row
    // matches. The org-less branch can legitimately match several: only OWNER
    // membership is capped at one per user (20260724a_owner_org_unique_index),
    // so somebody who owns one org and administers another matched twice, got an
    // error instead of a row, and - because the error was discarded - was told
    // `forbidden`. A legitimate admin could not start a connect flow at all.
    //
    // Discarding the error also collapsed two different outcomes into one: a
    // transient database failure looked exactly like "you are not a member", so
    // the 403 was indistinguishable from a real permission denial in the logs.
    // Both branches still FAIL CLOSED - an unreadable membership is never
    // treated as permission - but they now say which happened.
    let targetOrgId: string | null = body.org_id || null;
    if (targetOrgId) {
      // Scoped to one org, so at most one row can match; .limit(1) costs nothing
      // and keeps the two branches identical in shape.
      const { data: cm, error: cmErr } = await supabase
        .from('org_members')
        .select('role, organization_id')
        .eq('auth_user_id', callerAuthId)
        .eq('organization_id', targetOrgId)
        .in('role', ['owner', 'admin'])
        .not('accepted_at', 'is', null)
        .limit(1)
        .maybeSingle();
      if (cmErr) {
        console.error('[oauth-start] membership check failed for org', targetOrgId, cmErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if (!cm) return FORBIDDEN;
    } else {
      // Deterministic pick, so the same caller resolves to the same org on every
      // request rather than whichever row the planner happened to return.
      const { data: cm, error: cmErr } = await supabase
        .from('org_members')
        .select('role, organization_id')
        .eq('auth_user_id', callerAuthId)
        .in('role', ['owner', 'admin'])
        .not('accepted_at', 'is', null)
        .order('accepted_at', { ascending: true })
        .order('organization_id', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cmErr) {
        console.error('[oauth-start] membership lookup failed:', cmErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if (!cm) return FORBIDDEN;
      targetOrgId = (cm as { organization_id: string }).organization_id;
    }

    // ── refuse if this org already has an account ─────────────────────────
    // Connecting a second account would silently change where every future
    // payment lands, and leave existing charges and payment plans pointing at an
    // account we no longer record. Disconnecting first is a deliberate act.
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('id, stripe_account_id, stripe_account_status')
      .eq('id', targetOrgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[oauth-start] org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const org = orgData as {
      id: string;
      stripe_account_id: string | null;
      stripe_account_status: string | null;
    } | null;
    if (!org) return json({ error: 'org_not_found' }, 404);

    if (org.stripe_account_id && org.stripe_account_status !== 'disconnected') {
      return json({
        error: 'already_connected',
        message: 'This organization already has a Stripe account connected. Disconnect it in Stripe first if you want to use a different one.',
      }, 409);
    }

    // ── mint a single-use state ───────────────────────────────────────────
    const state = crypto.randomUUID() + '.' + crypto.randomUUID();
    const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60_000).toISOString();

    const { error: insErr } = await supabase.from('stripe_oauth_states').insert({
      state,
      organization_id: org.id,
      created_by_user_id: callerAuthId,
      expires_at: expiresAt,
      return_origin: origin,
    });
    if (insErr) {
      // Do NOT hand back a URL we cannot later validate - the callback would
      // reject it and the operator would watch a successful Stripe flow end in
      // an error. Fail here, where it is still explainable.
      console.error('[oauth-start] state insert failed:', insErr);
      return json({ error: 'state_persist_failed' }, 500);
    }

    // Opportunistic cleanup - keeps the table self-emptying instead of needing a
    // cron. Never fatal, but check the error properly: a PostgREST builder
    // resolves with { error } rather than rejecting, so a .then(undefined, ...)
    // rejection handler would never fire and a failing cleanup would look
    // handled while silently doing nothing.
    const { error: cleanupErr } = await supabase
      .from('stripe_oauth_states')
      .delete()
      .lt('expires_at', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    if (cleanupErr) console.warn('[oauth-start] expired-state cleanup failed:', cleanupErr.message);

    // ── build the authorize URL ───────────────────────────────────────────
    // The /oauth/v2/authorize path is what Stripe's own dashboard "Test OAuth"
    // button generates for this client ID, and is the flow verified on
    // 2026-07-29 to list the operator's existing accounts. redirect_uri must
    // EXACTLY match one registered in Connect > Settings > OAuth for this mode.
    const redirectUri = `${SUPABASE_URL}/functions/v1/stripe-oauth-callback`;
    // Nothing about where to return the operator goes in this URL - it is
    // already on the state row, which the callback reads. A return address in
    // the query string is an open redirect waiting to happen.
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: 'read_write',
      redirect_uri: redirectUri,
      state,
    });

    const authorizeUrl = `https://connect.stripe.com/oauth/v2/authorize?${params.toString()}`;

    return json({ authorize_url: authorizeUrl, expires_at: expiresAt, return_origin: origin });
  } catch (err) {
    console.error('[oauth-start] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

// The origin the operator gets sent back to after Stripe. This is NOT a cosmetic
// value: the callback 302s the browser to it, so anything we accept here is a
// redirect target on our own OAuth endpoint. A plain "looks like a URL" check
// would let an owner/admin hand us https://evil.example and have Enrops bounce
// the operator there mid-connect. Allowlist, and fall back to our own site
// rather than honouring anything unrecognised.
//
// PUBLIC_SITE_URL is per-environment, which is what keeps staging out of prod.
const DEFAULT_ORIGIN = (Deno.env.get('PUBLIC_SITE_URL') || 'https://enrops.com').replace(/\/$/, '');

function isAllowedOrigin(origin: string): boolean {
  if (origin === DEFAULT_ORIGIN) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'enrops.com' ||
    host === 'www.enrops.com' ||
    host === 'enrops-staging.netlify.app' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    // Netlify deploy previews for our own sites, e.g.
    // deploy-preview-42--zesty-eclair-31c105.netlify.app
    /^[a-z0-9-]+--(zesty-eclair-31c105|enrops-staging)\.netlify\.app$/.test(host)
  );
}

function sanitizeOrigin(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\/$/, '');
  if (!t) return null;
  if (!/^https?:\/\/[^\s/]+$/i.test(t)) return null;
  if (!isAllowedOrigin(t)) {
    console.warn(`[oauth-start] refusing unrecognised return origin: ${t}`);
    return null;
  }
  return t;
}
