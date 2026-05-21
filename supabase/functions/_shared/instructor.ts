// Shared helpers for contractor portal edge functions (chunks 2-5).
//
// Every instructor-facing function in the contractor portal needs the same
// preamble: pull the JWT, resolve to an instructor row, check is_active,
// check onboarding overall_status for terminal states (declined/abandoned),
// and short-circuit with the right HTTP code if any step fails.
//
// resolveInstructor() does all of that and returns either the data the
// function needs, or a Response the function should return as-is.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export interface ResolvedInstructor {
  id: string;
  organization_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  auth_user_id: string;
  org_slug: string;
  onboarding: {
    overall_status: string;
    current_step: number;
  } | null; // null if no contractor_onboarding_status row exists yet
}

// Either resolves the instructor + their onboarding status, OR returns a
// Response the function should send back as-is. The caller checks `error`
// first; if truthy, return it.
export interface ResolveResult {
  instructor?: ResolvedInstructor;
  error?: Response;
}

export interface ResolveOptions {
  // If true (default), require is_active = true on the instructor.
  // Set false for endpoints that should reach deactivated/abandoned instructors
  // (e.g., request-resume-onboarding).
  requireActive?: boolean;

  // If true (default), return 410 when overall_status is 'declined' or 'abandoned'.
  // Set false for endpoints that need to bypass the terminal-state guard
  // (Function 7 submit-onboarding-declined SETS the status to declined;
  // Function 15 request-resume-onboarding is for abandoned instructors).
  checkTerminalStatus?: boolean;
}

/**
 * Standard preamble for instructor-facing edge functions in the contractor portal.
 *
 * 1. Read Authorization: Bearer <jwt> header → 401 if missing.
 * 2. Verify the JWT via supabase.auth.getUser → 401 if invalid.
 * 3. Look up instructors row WHERE auth_user_id = jwt.user.id (and is_active = true
 *    unless overridden) → 403 if no row.
 * 4. Look up organizations.slug for the instructor's org → 500 if null (org misconfigured).
 * 5. Look up contractor_onboarding_status for the instructor → may be null.
 * 6. If overall_status is 'declined' or 'abandoned' AND checkTerminalStatus is true,
 *    return 410 with { error, overall_status, redirect } so the wizard navigates away.
 *
 * Functions call this at the top, check the returned `error`, return it as-is if set,
 * and otherwise proceed with `instructor`.
 */
export async function resolveInstructor(
  req: Request,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const requireActive = opts.requireActive ?? true;
  const checkTerminalStatus = opts.checkTerminalStatus ?? true;

  // Step 1: auth header
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return { error: json({ error: 'auth_required' }, 401) };

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'auth_required' }, 401) };

  // Step 2: verify JWT
  const supabase = adminClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return { error: json({ error: 'invalid_auth' }, 401) };

  const authUserId = userData.user.id;
  const authEmail = userData.user.email ?? null;

  // Step 3: instructor lookup
  let query = supabase
    .from('instructors')
    .select('id, organization_id, email, first_name, last_name, phone, auth_user_id, is_active')
    .eq('auth_user_id', authUserId);

  if (requireActive) {
    query = query.eq('is_active', true);
  }

  const { data: instructorRow, error: instructorErr } = await query.maybeSingle();
  if (instructorErr) {
    console.error('instructor lookup error:', instructorErr);
    return { error: json({ error: 'lookup_failed' }, 500) };
  }
  if (!instructorRow) {
    return { error: json({ error: 'not_an_instructor' }, 403) };
  }

  // Step 4: org slug (needed for redirect URLs in terminal-state response)
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('slug')
    .eq('id', instructorRow.organization_id)
    .maybeSingle();
  if (orgErr) {
    console.error('org lookup error:', orgErr);
    return { error: json({ error: 'lookup_failed' }, 500) };
  }
  if (!org?.slug) {
    console.error('org_misconfigured: org has no slug', {
      instructor_id: instructorRow.id,
      organization_id: instructorRow.organization_id,
    });
    return { error: json({ error: 'org_misconfigured' }, 500) };
  }

  // Step 5: onboarding status (may be null if invite hasn't been sent yet)
  const { data: onboardingRow, error: onboardingErr } = await supabase
    .from('contractor_onboarding_status')
    .select('overall_status, current_step')
    .eq('instructor_id', instructorRow.id)
    .maybeSingle();
  if (onboardingErr) {
    console.error('onboarding lookup error:', onboardingErr);
    return { error: json({ error: 'lookup_failed' }, 500) };
  }

  // Step 6: terminal-state guard
  if (
    checkTerminalStatus &&
    onboardingRow &&
    (onboardingRow.overall_status === 'declined' || onboardingRow.overall_status === 'abandoned')
  ) {
    return {
      error: json(
        {
          error: 'onboarding_terminated',
          overall_status: onboardingRow.overall_status,
          redirect: `/${org.slug}/onboarding/${onboardingRow.overall_status}`,
        },
        410,
      ),
    };
  }

  return {
    instructor: {
      id: instructorRow.id,
      organization_id: instructorRow.organization_id,
      email: instructorRow.email ?? authEmail ?? '',
      first_name: instructorRow.first_name,
      last_name: instructorRow.last_name,
      phone: instructorRow.phone,
      auth_user_id: instructorRow.auth_user_id,
      org_slug: org.slug,
      onboarding: onboardingRow
        ? {
            overall_status: onboardingRow.overall_status,
            current_step: onboardingRow.current_step,
          }
        : null,
    },
  };
}

/**
 * Returns a service-role Supabase client.
 *
 * Edge functions ALWAYS use the service-role client (bypasses RLS) — RLS is a
 * defense-in-depth layer for direct client queries from the wizard, but the
 * legal-record tables (contractor_acknowledgments, contractor_agreements,
 * contractor_ors_certification) have no instructor write policies. The edge
 * functions are the authorized write path.
 */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/**
 * Get the client IP from the request headers. Edge functions sit behind
 * Supabase's edge proxy; x-forwarded-for has the original client IP.
 * Falls back to null if not present.
 */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    // Take the first IP in the chain (the original client)
    return xff.split(',')[0].trim();
  }
  return req.headers.get('x-real-ip') ?? null;
}

/**
 * Get the User-Agent string from request headers. Used as audit data on
 * acknowledgments and agreements.
 */
export function userAgent(req: Request): string | null {
  return req.headers.get('user-agent');
}
