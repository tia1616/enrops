// invite-parents — invite a program's roster families into the parent portal.
//
// For programs where a partner runs registration, families enter Enrops only via
// an uploaded roster: they have a `parents` row but no login, no waivers, and
// can't be reached as portal users. This function (operator-triggered, NOT
// public) creates an auth account for each roster parent — the
// `on_auth_user_created_link_parent` trigger links their parents row by email —
// then emails a tenant-branded magic-link welcome so they can see details and
// sign waivers.
//
// AUTH: caller must be owner / admin / staff of organization_id.
// INPUT:  { organization_id, program_id, redirect_to }   (redirect_to = parent dashboard URL)
// OUTPUT: { invited, skipped_existing, skipped_no_email, failed, total_candidates }
//
// Idempotent: parents who already have an auth account (by email) are skipped,
// so re-running never double-invites.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress, OrgBrand } from '../_shared/orgBrand.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    const organizationId: string | undefined = body.organization_id;
    const programId: string | undefined = body.program_id;
    const redirectTo: string | undefined = body.redirect_to;
    const loginUrl: string | undefined = body.login_url; // fallback sign-in page if the one-click link expires
    const preview: boolean = body.preview === true; // preview: return who + the email, send nothing
    if (!organizationId) return json({ error: 'organization_id required' }, 400);
    if (!programId) return json({ error: 'program_id required' }, 400);

    // ----- Auth: caller must be owner/admin/staff of this org -----
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);
    const { data: memberRow } = await admin
      .from('org_members')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin', 'staff'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    // ----- Program must belong to this org -----
    const { data: prog } = await admin
      .from('programs')
      .select('id, curriculum')
      .eq('id', programId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (!prog) return json({ error: 'program not found' }, 404);

    // ----- Roster parents: registrations -> students -> parents -----
    const { data: regs, error: regErr } = await admin
      .from('registrations')
      .select('student_id')
      .eq('organization_id', organizationId)
      .eq('program_id', programId)
      .neq('status', 'cancelled');
    if (regErr) return json({ error: `Load roster: ${regErr.message}` }, 500);
    const studentIds = [...new Set((regs ?? []).map((r: any) => r.student_id).filter(Boolean))];
    if (studentIds.length === 0) {
      return json({ invited: 0, skipped_existing: 0, skipped_no_email: 0, failed: 0, total_candidates: 0,
        message: 'No families on this roster yet.' });
    }

    const { data: studs } = await admin.from('students').select('parent_id').in('id', studentIds);
    const parentIds = [...new Set((studs ?? []).map((s: any) => s.parent_id).filter(Boolean))];

    const { data: parents } = await admin
      .from('parents')
      .select('id, first_name, last_name, email, auth_id')
      .in('id', parentIds);

    let skippedNoEmail = 0;
    const candidates: Array<{ id: string; first_name: string; last_name: string; email: string }> = [];
    for (const p of parents ?? []) {
      const email = (p.email ?? '').trim();
      if (!email || email.toLowerCase().endsWith('@import.local')) { skippedNoEmail++; continue; }
      candidates.push({ id: p.id, first_name: (p.first_name ?? '').trim() || 'there', last_name: (p.last_name ?? '').trim(), email });
    }

    // ----- Tenant branding for the email -----
    const brand = await loadOrgBrand(admin, organizationId);
    const fromAddr = formatFromAddress(brand);
    const subject = `Your ${brand.org_name} family portal is ready`;

    // Look up existing auth users. We RE-SEND to accounts that exist but never
    // signed in (e.g. a prior send failed) instead of silently skipping them, and
    // skip only families who have actually signed in already (truly onboarded).
    const { data: userList } = await admin.auth.admin.listUsers();
    const userByEmail = new Map<string, any>();
    for (const u of userList?.users ?? []) {
      if (u.email) userByEmail.set(u.email.toLowerCase(), u);
    }

    let skippedActive = 0;
    const toInvite: Array<{ first_name: string; last_name: string; email: string; hasAccount: boolean }> = [];
    for (const c of candidates) {
      const existing = userByEmail.get(c.email.toLowerCase());
      if (existing?.last_sign_in_at) { skippedActive++; continue; } // already signed in — truly has access
      toInvite.push({ first_name: c.first_name, last_name: c.last_name, email: c.email, hasAccount: !!existing });
    }

    // Preview mode: return exactly who would be emailed + the rendered email.
    // Nothing is created and nothing is sent.
    if (preview) {
      return json({
        preview: true,
        total_candidates: toInvite.length,
        skipped_active: skippedActive,
        skipped_no_email: skippedNoEmail,
        from: fromAddr,
        subject,
        recipients: toInvite.map((c) => ({ name: `${c.first_name} ${c.last_name}`.trim() || c.email, email: c.email })),
        preview_html: buildInviteEmail(brand, toInvite[0]?.first_name || 'there', '#', prog.curriculum, loginUrl),
      });
    }

    let invited = 0, failed = 0;
    const failedEmails: string[] = [];
    for (const c of toInvite) {
      // Create the account only if missing — the auth.users trigger links
      // parents.auth_id by email. Existing-but-never-signed-in just gets a re-send.
      if (!c.hasAccount) {
        const { error: createErr } = await admin.auth.admin.createUser({ email: c.email, email_confirm: true });
        if (createErr) { console.error('createUser failed', c.email, createErr.message); failed++; failedEmails.push(c.email); continue; }
      }

      let signInUrl = redirectTo || SUPABASE_URL;
      const { data: linkData } = await admin.auth.admin.generateLink({
        type: 'magiclink', email: c.email, options: { redirectTo: redirectTo || SUPABASE_URL },
      });
      if (linkData?.properties?.action_link) signInUrl = linkData.properties.action_link;

      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: fromAddr,
          to: c.email,
          reply_to: brand.reply_to,
          subject,
          html: buildInviteEmail(brand, c.first_name, signInUrl, prog.curriculum, loginUrl),
          tags: [{ name: 'type', value: 'parent_invite' }],
        }),
      });
      if (!resp.ok) { console.error('Resend failed', c.email, await resp.text()); failed++; failedEmails.push(c.email); continue; }
      invited++;
    }

    console.log(`invite-parents: org=${organizationId} program=${programId} invited=${invited} skipped_active=${skippedActive} failed=${failed}`);
    return json({ invited, skipped_active: skippedActive, skipped_no_email: skippedNoEmail, failed, failed_emails: failedEmails, total_candidates: toInvite.length });
  } catch (e) {
    console.error('invite-parents error:', (e as Error).message);
    return json({ error: (e as Error).message || 'Internal error' }, 500);
  }
});

function buildInviteEmail(brand: OrgBrand, firstName: string, signInUrl: string, programName: string | null, loginUrl?: string | null): string {
  const primary = brand.primary_color;
  const accent = brand.accent_color;
  const logo = brand.logo_url
    ? `<img src="${brand.logo_url}" alt="${brand.org_name}" style="max-height:40px;margin-bottom:8px;">`
    : `<div style="color:${accent};font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${brand.org_name}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:${brand.page_bg_color};font-family:Arial,sans-serif;">
<div style="max-width:500px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:${primary};padding:32px 28px;text-align:center;">
    ${logo}
    <h1 style="color:#fff;margin:8px 0 0;font-size:22px;font-weight:700;">Your family portal is ready</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hi ${firstName},</p>
    <p style="margin:0 0 20px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Your child is enrolled${programName ? ` in <strong>${programName}</strong>` : ''}. Set up your portal to see the schedule and class details, sign any required forms, and get updates.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        Open my portal
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;line-height:1.6;">This one-click link works for 24 hours.${loginUrl ? ` After that you can sign in any time at <a href="${loginUrl}" style="color:${primary};">your family portal</a> — we'll email you a fresh link.` : ''} Questions? Just reply to this email.</p>
  </div>
</div>
</body></html>`;
}
