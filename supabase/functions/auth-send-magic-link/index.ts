// supabase/functions/auth-send-magic-link/index.ts
// Generates a magic link via auth.admin.generateLink() and sends it
// through Resend directly — same proven path as stripe-webhook.
// Bypasses Supabase SMTP entirely.
//
// INPUT:  { email, redirect_to, context? }
//   context: "parent" (J2S branded) | "admin" (Enrops admin) | "instructor" (J2S instructor)
//          | "onboarding" (J2S contractor mid-wizard — different subject/body so they don't
//            see "view your schedule" before they have one)
//          | "signup" (Enrops operator self-serve signup — CREATES the auth user for a
//            brand-new email so the link actually signs them in, then routes them to name
//            their business. Login contexts intentionally no-op on unknown emails to avoid
//            enumeration; a signup surface inherently creates an account, so there's no leak.)
// OUTPUT: { sent: true } or { error: "..." }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { logPlatformEvent, FEATURE, ACTION } from '../_shared/logPlatformEvent.ts';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
// No FROM_EMAIL constant on purpose. Every template now resolves its sender
// through loadOrgBrand/formatFromAddress, so the FROM always belongs to the
// org the email is actually about. The previous
// `RESEND_FROM_EMAIL || 'Journey to STEAM <hello@updates.journeytosteam.com>'`
// meant an env miss sent EVERY tenant's sign-in mail as the first tenant.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Look a user up by email across ALL pages. auth.admin.listUsers() returns only
// the first page (50, newest-first), so the earliest-registered accounts would
// look non-existent once the user base grows past one page — which made old
// instructors hit a bogus "already registered" error and old parents get a
// silent no-op with no email. Paging to the end fixes both.
async function findUserByEmail(supabase: any, email: string) {
  const target = email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    const match = users.find((u: any) => u.email?.toLowerCase() === target);
    if (match) return match;
    if (users.length < perPage) return null; // reached the last page
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { email, redirect_to, context, org_id } = await req.json();
    if (!email) throw new Error('email is required');

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    let isInstructor = context === 'instructor';
    let isOnboarding = context === 'onboarding';
    const isSignup = context === 'signup';
    // Onboarding emails are sent to contractors who have an instructors row but may not
    // yet have an auth.users row (admin invited them but they haven't signed in). Same
    // auto-create-on-first-sign-in behavior as instructor context.
    const needsInstructorLookup = isInstructor || isOnboarding;

    // Verify the user exists in auth.users (paged lookup — see findUserByEmail).
    let user = await findUserByEmail(supabase, email);
    // Onboarding funnel: was this signup attempt a brand-new account (a genuine
    // top-of-funnel entry) or someone re-requesting a link? Logged below.
    let createdNewAccount = false;
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
      } else if (isSignup) {
        // Operator self-serve signup: create the account for a brand-new email
        // so the magic link actually signs them in. (No enumeration concern — a
        // signup surface creates an account by design.)
        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
          email,
          email_confirm: true,
        });
        if (createErr || !created?.user) {
          throw new Error(`Couldn't create auth user: ${createErr?.message ?? 'unknown error'}`);
        }
        user = created.user;
        createdNewAccount = true;
        console.log(`Auto-created auth user for operator signup ${email}`);
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
      supabase.from('instructors').select('id, first_name, organization_id').ilike('email', email).eq('is_active', true).limit(1).maybeSingle(),
      supabase.from('org_members').select('id').eq('auth_user_id', user.id).not('accepted_at', 'is', null).limit(1).maybeSingle(),
      supabase.from('parents').select('first_name').eq('auth_id', user.id).limit(1).maybeSingle(),
    ]);

    // Contractor still mid-onboarding keeps the gentler onboarding copy so we
    // never say "view your schedule" before they have one.
    let template: 'admin' | 'onboarding' | 'instructor' | 'parent' | 'signup';
    if (isSignup) {
      template = 'signup';
    } else if (isOnboarding) {
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

    // Tenant-branded sign-in emails. Parents, instructors and mid-onboarding
    // contractors all belong to a specific operator, so the email has to speak
    // as THAT operator. Instructor and onboarding used to hardcode "Journey to
    // STEAM" in the header, subject and FROM, which meant every tenant's
    // contractors got a sign-in email branded as the first tenant.
    //
    // Org precedence: the caller-passed org_id wins, because the login page
    // knows which tenant's portal the person is actually on — that is also the
    // correct disambiguator if one email ever exists as an instructor at two
    // operators (none do today in staging or prod, but nothing prevents it).
    // Then the instructor's own organization_id. Failing both, loadOrgBrand
    // returns the ENROPS brand — never J2S.
    //
    // Unchanged for parents: that branch is only reached when instructorRow is
    // null, so the resolved org is still exactly `org_id ?? null`.
    const tenantBrand = (template === 'parent' || template === 'instructor' || template === 'onboarding')
      ? await loadOrgBrand(supabase, org_id ?? instructorRow?.organization_id ?? null)
      : null;

    const subject =
      template === 'signup' ? 'Finish setting up your enrops page'
      : template === 'admin' ? 'Sign in to Enrops Admin'
      : template === 'onboarding' ? `Continue your ${tenantBrand?.org_name ?? 'enrops'} onboarding`
      : template === 'instructor' ? 'Sign in to view your schedule'
      : `Sign in to ${tenantBrand?.org_name ?? 'enrops'}`;

    const html =
      template === 'signup' ? buildSignupEmail(signInUrl)
      : template === 'admin' ? buildAdminEmail(firstName, signInUrl)
      : template === 'onboarding' ? buildOnboardingEmail(firstName, signInUrl, tenantBrand)
      : template === 'instructor' ? buildInstructorEmail(firstName, signInUrl, tenantBrand)
      : buildParentEmail(firstName, signInUrl, tenantBrand);

    // Operator-facing auth emails (signup + admin) send AS enrops from the
    // verified enrops domain, with replies going to the enrops inbox — sourced
    // from the enrops org row (no hardcoded address). Tenant flows
    // (parent/instructor/onboarding) send as their OWN operator.
    // Keyed off the RESOLVED template, not the requested context. The template is
    // re-derived above from what the recipient actually IS (an admin who signs in
    // from a parent page still gets the admin email), so gating the sender on the
    // requested context let an Enrops-branded "Sign in to Admin" email go out FROM
    // the J2S sending domain — caught in a real send, invisible in the HTML.
    //
    // Every branch now resolves a brand, so there is no unbranded fallback left:
    // the old `RESEND_FROM_EMAIL || 'Journey to STEAM <...>'` default is gone.
    // It was the last path that could send a tenant's mail under J2S's name.
    // loadOrgBrand only returns a tenant's own address when its domain is that
    // tenant's VERIFIED sending domain, so this cannot break deliverability.
    const senderBrand = (template === 'signup' || template === 'admin')
      ? await loadOrgBrand(supabase, null)
      : (tenantBrand ?? await loadOrgBrand(supabase, null));
    const fromLine = formatFromAddress(senderBrand);
    const replyTo: string | undefined = senderBrand.reply_to;

    // Send via Resend
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: fromLine,
        to: email,
        subject,
        html,
        reply_to: replyTo,
        tags: [{ name: 'type', value: 'magic_link' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend send failed:', resp.status, errText);
      throw new Error('Failed to send email');
    }

    console.log(`Magic link email sent to ${email} (${context || 'parent'})`);

    // ONBOARDING FUNNEL — top of funnel, signup context only. This is the one
    // step that leaves NO row behind when the operator abandons (they never
    // create an org), so it cannot be reconstructed later. actor_user_id ties
    // this attempt to the org they eventually create. NO EMAIL in metadata —
    // the intelligence contract allows IDs + facts only, never PII.
    // Fail-safe by contract: a telemetry failure can never break signup.
    // NOTE: the Google OAuth signup path does NOT come through this function,
    // so it is not counted here — see the funnel caveat in the memory notes.
    if (isSignup) {
      await logPlatformEvent(supabase, {
        feature: FEATURE.ONBOARDING,
        action: ACTION.SIGNUP_STARTED,
        outcome: 'success',
        organizationId: null, // no org exists yet — that is the point of this event
        actorUserId: user?.id ?? null,
        metadata: { method: 'magic_link', created_new_account: createdNewAccount },
        dedupeKey: user?.id ? `signup_started:${user.id}` : null,
      });
    }

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

function buildSignupEmail(signInUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:#1C004F;padding:32px 28px;text-align:center;">
    <div style="color:#8C88FF;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">enrops</div>
    <h1 style="color:#fff;margin:8px 0 0;font-size:24px;font-weight:700;">You're almost live</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 24px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Tap below to finish creating your registration page. Name your program and you'll have a shareable link in minutes &mdash; free for businesses, no credit card.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:#26D687;color:#1C004F;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        Finish setup
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;">This link expires in 24 hours. Didn't request this? You can ignore this email.</p>
  </div>
</div>
</body></html>`;
}

// Contractor onboarding sign-in email, tenant-branded. `brand` comes from
// loadOrgBrand (the contractor's own operator, or the enrops fallback — never
// J2S). Mirrors buildParentEmail: operator's logo, or its name when it has none.
function buildOnboardingEmail(firstName: string, signInUrl: string, brand: any): string {
  const orgName = brand?.org_name || 'enrops';
  const accent = brand?.primary_color || '#1C004F';
  const ink = readableOn(accent);
  const logoBlock = brand?.logo_url
    ? `<img src="${escapeAttr(brand.logo_url)}" alt="${escapeAttr(orgName)}" style="max-height:44px;width:auto;display:inline-block;" />`
    : `<div style="color:${escapeAttr(ink.muted)};font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(orgName)}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:${escapeAttr(accent)};padding:32px 28px;text-align:center;">
    ${logoBlock}
    <h1 style="color:${escapeAttr(ink.fg)};margin:8px 0 0;font-size:24px;font-weight:700;">Continue your onboarding</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Pick up right where you left off — your progress is saved.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${escapeAttr(signInUrl)}" style="display:inline-block;background:${escapeAttr(accent)};color:${escapeAttr(ink.fg)};text-decoration:none;padding:14px 36px;border-radius:6px;font-size:15px;font-weight:600;">
        Open my onboarding
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;">This link expires in 24 hours. Questions? Just reply to this email.</p>
  </div>
</div>
</body></html>`;
}

// Instructor sign-in email, tenant-branded. Same contract as buildParentEmail
// and buildOnboardingEmail: the operator's own logo/name and colour, never the
// first tenant's.
function buildInstructorEmail(firstName: string, signInUrl: string, brand: any): string {
  const orgName = brand?.org_name || 'enrops';
  const accent = brand?.primary_color || '#1C004F';
  const ink = readableOn(accent);
  const logoBlock = brand?.logo_url
    ? `<img src="${escapeAttr(brand.logo_url)}" alt="${escapeAttr(orgName)}" style="max-height:44px;width:auto;display:inline-block;" />`
    : `<div style="color:${escapeAttr(ink.muted)};font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(orgName)}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:${escapeAttr(accent)};padding:32px 28px;text-align:center;">
    ${logoBlock}
    <h1 style="color:${escapeAttr(ink.fg)};margin:8px 0 0;font-size:24px;font-weight:700;">Sign in</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Tap the button below to view your schedule, accept your camps, or request changes.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${escapeAttr(signInUrl)}" style="display:inline-block;background:${escapeAttr(accent)};color:${escapeAttr(ink.fg)};text-decoration:none;padding:14px 36px;border-radius:6px;font-size:15px;font-weight:600;">
        Open my schedule
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;">This link expires in 24 hours. Questions? Just reply to this email.</p>
  </div>
</div>
</body></html>`;
}

// Parent (family) sign-in email, tenant-branded. `brand` comes from loadOrgBrand
// (the family's own org, or the enrops fallback — never J2S). Shows the org's
// logo (or its name when no logo), its primary color, and its support/reply-to.
function buildParentEmail(firstName: string, signInUrl: string, brand: any): string {
  const orgName = brand?.org_name || 'enrops';
  const support = brand?.reply_to || 'jessica@enrops.com';
  const accent = brand?.primary_color || '#5847C9';
  const logoBlock = brand?.logo_url
    ? `<img src="${escapeAttr(brand.logo_url)}" alt="${escapeHtml(orgName)}" style="max-height:44px;width:auto;display:inline-block;" />`
    : `<div style="color:#fff;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(orgName)}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:'Poppins',Arial,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:${escapeAttr(accent)};padding:28px;text-align:center;">
    ${logoBlock}
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1A1530;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#1A1530;line-height:1.6;">
      Tap the button below to view your child's program schedule and details.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${escapeAttr(signInUrl)}" style="display:inline-block;background:${escapeAttr(accent)};color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        View my dashboard
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6880;">This link expires in 24 hours. Questions? Reach us at <a href="mailto:${escapeAttr(support)}" style="color:${escapeAttr(accent)};">${escapeHtml(support)}</a></p>
  </div>
</div>
</body></html>`;
}

/**
 * Readable text colour for a given background. The header band used to be a
 * fixed dark purple, so white text was always safe; now it is the tenant's own
 * primary_color, and a pale brand colour would render white-on-white.
 *
 * Decided by actual WCAG contrast RATIO, not a luminance threshold. A bare
 * luminance cut is arbitrary and gets real brands wrong: shoreview-chess uses
 * #64D2D2, whose luminance is 0.534 — under a 0.6 cut it would keep white text
 * at a 1.8:1 ratio, which is unreadable.
 *
 * White is PREFERRED and only abandoned when it fails AA for large text (3:1).
 * That keeps every brand in use today rendering exactly as it does now
 * (#674EE8 J2S 5.5:1, #E85C37 3.5:1, #1C004F 15:1 all stay white) and flips
 * only the cases where white genuinely cannot be read (#64D2D2 -> 1.8:1).
 *
 * Known limitation: 3:1 is the large-text threshold, correct for the 24px
 * heading. The button label is 15px, where AA wants 4.5:1, so a mid-tone brand
 * keeps a button that passes large-text but not normal-text contrast. Tightening
 * that would restyle existing tenants' emails, which is a design call, not a
 * silent one.
 *
 * Unparseable or missing colours keep the previous behaviour (white).
 */
function readableOn(bg: string): { fg: string; muted: string } {
  const WHITE = { fg: '#fff', muted: '#8C88FF' };
  const DARK = { fg: '#1A1530', muted: '#4A4470' };
  const hex = String(bg ?? '').trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return WHITE;
  const chan = (i: number) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const bgL = 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
  const ratio = (aL: number, bL: number) =>
    (Math.max(aL, bL) + 0.05) / (Math.min(aL, bL) + 0.05);
  // Luminance of #fff is 1; #1A1530 is ~0.0113.
  return ratio(1, bgL) >= 3 ? WHITE : (ratio(0.0113, bgL) > ratio(1, bgL) ? DARK : WHITE);
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
