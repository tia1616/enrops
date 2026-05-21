// resend-onboarding-invite — fallback when a contractor's magic link expired.
//
// Auth: verify_jwt: false (the user has no valid JWT — that's why they're
// asking for a new link). Authenticate by email match instead.
//
// Anti-enumeration: always return 200 { success: true }, regardless of whether
// the email actually matches an instructors row. The contractor sees the same
// "if your email is registered, we sent a new link" message either way.
//
// Rate limit: one resend per email per 60 minutes, tracked via
// instructors.last_resend_requested_at.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

interface ResendInviteBody {
  email?: string;
}

const RATE_LIMIT_MS = 60 * 60 * 1000; // 60 min

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Every non-error response is { success: true } to prevent enumeration.
  const success = () => json({ success: true });

  try {
    let body: ResendInviteBody;
    try {
      body = (await req.json()) as ResendInviteBody;
    } catch {
      // Malformed body still returns success (don't help the attacker).
      return success();
    }

    const email = body.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      // Invalid email format — still return success.
      return success();
    }

    const supabase = adminClient();

    // Find the instructor by email (case-insensitive). Don't filter on
    // is_active here — a deactivated instructor asking for a new link will
    // get one but won't be able to do anything with it (the wizard's auth
    // routing will catch them).
    const { data: instructor, error: lookupErr } = await supabase
      .from('instructors')
      .select('id, email, organization_id, last_resend_requested_at')
      .ilike('email', email)
      .maybeSingle();

    if (lookupErr) {
      console.error('instructor lookup failed:', lookupErr);
      // Log internally but return success — don't help the attacker probe.
      return success();
    }
    if (!instructor) {
      // No match — return success.
      return success();
    }

    // Rate limit: if last_resend_requested_at is within the window, silently
    // absorb (still return success — don't leak rate-limit state).
    if (instructor.last_resend_requested_at) {
      const last = new Date(instructor.last_resend_requested_at).getTime();
      if (Date.now() - last < RATE_LIMIT_MS) {
        return success();
      }
    }

    // Look up org for tenant-derived values.
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('slug, name, default_sender_name, default_sender_email')
      .eq('id', instructor.organization_id)
      .maybeSingle();
    if (orgErr) {
      console.error('org lookup failed:', orgErr);
      return success();
    }
    if (!org?.slug || !org.default_sender_name || !org.default_sender_email) {
      console.error('org missing slug or sender config:', instructor.organization_id);
      // This IS a real misconfiguration — log loudly but still return success
      // so the contractor isn't stuck on a confusing error.
      return success();
    }

    // Generate fresh magic link.
    const redirectTo = `https://enrops.com/${org.slug}/onboarding`;
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: instructor.email,
      options: { redirectTo },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      console.error('magic link regeneration failed:', linkErr);
      return success();
    }

    // Send email.
    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      console.error('RESEND_API_KEY not set');
      return success();
    }

    const magicLink = linkData.properties.action_link;
    const text = [
      `Hi,`,
      ``,
      `Here's a new link to continue your contractor onboarding with ${org.name ?? 'enrops'}.`,
      ``,
      `Continue onboarding: ${magicLink}`,
      ``,
      `This link expires in 1 hour. If you didn't request this, you can ignore this email.`,
    ].join('\n');

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${org.default_sender_name} <${org.default_sender_email}>`,
        to: instructor.email,
        subject: `Your new onboarding link for ${org.name ?? 'enrops'}`,
        text,
        tags: [{ name: 'type', value: 'invite_resend' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend invite-resend send failed:', resp.status, errText);
      // Still return success — the user already got the "if registered, we sent" message.
      return success();
    }

    // Stamp last_resend_requested_at.
    await supabase
      .from('instructors')
      .update({ last_resend_requested_at: new Date().toISOString() })
      .eq('id', instructor.id);

    return success();
  } catch (err) {
    console.error('resend-onboarding-invite fatal:', err);
    // Even on internal errors, return success to avoid leaking timing info.
    return success();
  }
});
