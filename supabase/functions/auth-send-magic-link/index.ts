// supabase/functions/auth-send-magic-link/index.ts
// Generates a magic link via auth.admin.generateLink() and sends it
// through Resend directly — same proven path as stripe-webhook.
// Bypasses Supabase SMTP entirely.
//
// INPUT:  { email, redirect_to, context? }
//   context: "parent" (J2S branded) | "admin" (Enrops admin) | "instructor" (J2S instructor)
//          | "onboarding" (J2S contractor mid-wizard — different subject/body so they don't
//            see "view your schedule" before they have one)
// OUTPUT: { sent: true } or { error: "..." }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'Journey to STEAM <hello@updates.journeytosteam.com>';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { email, redirect_to, context } = await req.json();
    if (!email) throw new Error('email is required');

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const isInstructor = context === 'instructor';
    const isOnboarding = context === 'onboarding';
    // Onboarding emails are sent to contractors who have an instructors row but may not
    // yet have an auth.users row (admin invited them but they haven't signed in). Same
    // auto-create-on-first-sign-in behavior as instructor context.
    const needsInstructorLookup = isInstructor || isOnboarding;

    // Verify the user exists in auth.users
    const { data: userList } = await supabase.auth.admin.listUsers();
    let user = userList?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (!user) {
      if (needsInstructorLookup) {
        // For first-time instructor sign-in: if their email matches an active
        // instructor record, auto-create the auth user so they can sign in.
        const { data: instructorRow } = await supabase
          .from('instructors')
          .select('id')
          .ilike('email', email)
          .eq('is_active', true)
          .maybeSingle();
        if (instructorRow) {
          const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email,
            email_confirm: true,
          });
          if (createErr || !created?.user) {
            throw new Error(`Couldn't create auth user: ${createErr?.message ?? 'unknown error'}`);
          }
          user = created.user;
          console.log(`Auto-created auth user for instructor ${email} (context=${context})`);
        } else {
          // Email isn't a known instructor — silent no-op.
          return json({ sent: true });
        }
      } else {
        // Don't reveal whether email exists — always say "check your inbox"
        console.log(`No auth user found for ${email}, returning success silently`);
        return json({ sent: true });
      }
    }

    // Generate the magic link server-side
    const redirectTo = redirect_to || `${SUPABASE_URL}`;
    let signInUrl = redirectTo;

    try {
      const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo },
      });
      if (linkData?.properties?.action_link) {
        signInUrl = linkData.properties.action_link;
        console.log(`Magic link generated for ${email}`);
      } else {
        console.warn('generateLink returned no action_link:', linkErr?.message);
        throw new Error(linkErr?.message || 'Failed to generate link');
      }
    } catch (err) {
      console.error('generateLink failed:', (err as Error).message);
      throw new Error('Could not generate sign-in link');
    }

    // Build email HTML based on context
    const isAdmin = context === 'admin';

    // For instructors / onboarding contractors, prefer the first_name on their
    // instructors row over auth user metadata.
    let firstName = user.user_metadata?.full_name
      ? user.user_metadata.full_name.split(' ')[0]
      : 'there';
    if (needsInstructorLookup) {
      const { data: instructorRow } = await supabase
        .from('instructors')
        .select('first_name')
        .ilike('email', email)
        .eq('is_active', true)
        .maybeSingle();
      if (instructorRow?.first_name) firstName = instructorRow.first_name;
    }

    const subject = isAdmin
      ? 'Sign in to Enrops Admin'
      : isOnboarding
      ? 'Continue your Journey to STEAM onboarding'
      : isInstructor
      ? 'Sign in to view your schedule'
      : 'Sign in to Journey to STEAM';

    const html = isAdmin
      ? buildAdminEmail(firstName, signInUrl)
      : isOnboarding
      ? buildOnboardingEmail(firstName, signInUrl)
      : isInstructor
      ? buildInstructorEmail(firstName, signInUrl)
      : buildParentEmail(firstName, signInUrl);

    // Send via Resend
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: email,
        subject,
        html,
        tags: [{ name: 'type', value: 'magic_link' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend send failed:', resp.status, errText);
      throw new Error('Failed to send email');
    }

    console.log(`Magic link email sent to ${email} (${context || 'parent'})`);
    return json({ sent: true });
  } catch (e) {
    console.error('auth-send-magic-link error:', (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});

function buildAdminEmail(firstName: string, signInUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:#1C004F;padding:32px 28px;text-align:center;">
    <div style="color:#8C88FF;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Enrops</div>
    <h1 style="color:#fff;margin:8px 0 0;font-size:24px;font-weight:700;">Sign in to Admin</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hi ${firstName},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Tap the button below to sign in to your admin dashboard.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:#1C004F;color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:15px;font-weight:600;">
        Sign in to dashboard
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;">This link expires in 24 hours.</p>
  </div>
</div>
</body></html>`;
}

function buildOnboardingEmail(firstName: string, signInUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:#1C004F;padding:32px 28px;text-align:center;">
    <div style="color:#8C88FF;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Journey to STEAM</div>
    <h1 style="color:#fff;margin:8px 0 0;font-size:24px;font-weight:700;">Continue your onboarding</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hi ${firstName},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Pick up right where you left off — your progress is saved.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:#1C004F;color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:15px;font-weight:600;">
        Open my onboarding
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;">This link expires in 24 hours. Questions? Just reply to this email.</p>
  </div>
</div>
</body></html>`;
}

function buildInstructorEmail(firstName: string, signInUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:#1C004F;padding:32px 28px;text-align:center;">
    <div style="color:#8C88FF;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Journey to STEAM</div>
    <h1 style="color:#fff;margin:8px 0 0;font-size:24px;font-weight:700;">Sign in</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hi ${firstName},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Tap the button below to view your schedule, accept your camps, or request changes.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:#1C004F;color:#fff;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:15px;font-weight:600;">
        Open my schedule
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;">This link expires in 24 hours. Questions? Just reply to this email.</p>
  </div>
</div>
</body></html>`;
}

function buildParentEmail(firstName: string, signInUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:'Nunito Sans',Arial,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#674EE8,#4430AC);padding:32px 28px;text-align:center;">
    <div style="color:#F8A638;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Journey to STEAM</div>
    <h1 style="color:#fff;margin:8px 0 0;font-size:24px;font-weight:700;">Sign in</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1A1530;">Hi ${firstName},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#1A1530;line-height:1.6;">
      Tap the button below to view your child's program schedule and details.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:#674EE8;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        View my dashboard
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6880;">This link expires in 24 hours. Questions? Reach us at <a href="mailto:info@journeytosteam.com" style="color:#674EE8;">info@journeytosteam.com</a></p>
  </div>
</div>
</body></html>`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
