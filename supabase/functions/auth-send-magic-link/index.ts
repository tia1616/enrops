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
    let isInstructor = context === 'instructor';
    let isOnboarding = context === 'onboarding';
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

    // Choose the wording from the recipient's ACTUAL role, not just the login
    // page's context hint — so an instructor who signs in via the parent login
    // (or vice-versa) still gets the right copy. Context only governs the
    // auto-create behavior (above) and keeps admin wording for an admin who
    // signed in through the admin page.
    //
    // Instructor is matched by EMAIL (not auth_user_id): a first-time
    // contractor's auth user may have just been created and their instructors
    // row isn't linked to it yet (linking happens later in the portal).
    const [{ data: instructorRow }, { data: adminRow }, { data: parentRow }] = await Promise.all([
      supabase.from('instructors').select('id, first_name').ilike('email', email).eq('is_active', true).limit(1).maybeSingle(),
      supabase.from('org_members').select('id').eq('auth_user_id', user.id).not('accepted_at', 'is', null).limit(1).maybeSingle(),
      supabase.from('parents').select('first_name').eq('auth_id', user.id).limit(1).maybeSingle(),
    ]);

    // Contractor still mid-onboarding keeps the gentler onboarding copy so we
    // never say "view your schedule" before they have one.
    let template: 'admin' | 'onboarding' | 'instructor' | 'parent';
    if (isOnboarding) {
      template = 'onboarding';
    } else if (context === 'admin' && adminRow) {
      template = 'admin';
    } else if (instructorRow) {
      const { data: onboardingRow } = await supabase
        .from('contractor_onboarding_status')
        .select('overall_status')
        .eq('instructor_id', instructorRow.id)
        .maybeSingle();
      template = onboardingRow && onboardingRow.overall_status !== 'complete' ? 'onboarding' : 'instructor';
    } else if (adminRow) {
      template = 'admin';
    } else {
      template = 'parent';
    }
    console.log(`magic-link template=${template} (context=${context}) for ${email}`);

    // Prefer the name on the matching role row over auth metadata.
    let firstName = user.user_metadata?.full_name
      ? user.user_metadata.full_name.split(' ')[0]
      : 'there';
    if (instructorRow?.first_name) firstName = instructorRow.first_name;
    else if (parentRow?.first_name) firstName = parentRow.first_name;

    const subject =
      template === 'admin' ? 'Sign in to Enrops Admin'
      : template === 'onboarding' ? 'Continue your Journey to STEAM onboarding'
      : template === 'instructor' ? 'Sign in to view your schedule'
      : 'Sign in to Journey to STEAM';

    const html =
      template === 'admin' ? buildAdminEmail(firstName, signInUrl)
      : template === 'onboarding' ? buildOnboardingEmail(firstName, signInUrl)
      : template === 'instructor' ? buildInstructorEmail(firstName, signInUrl)
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
    <p style="margin:0;font-size:13px;color:#6b6880;">This link expires in 24 hours. Questions? Reach us at <a href="mailto:support@journeytosteam.com" style="color:#674EE8;">support@journeytosteam.com</a></p>
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
