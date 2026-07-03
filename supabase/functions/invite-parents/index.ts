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
//
// MANUAL CHECK (auth pagination): on a project with > PER_PAGE (1000) auth users,
// invite a program whose roster includes a parent whose auth account sorts onto a
// LATER page. Run in preview mode and confirm that parent shows as skipped_active
// (if they've signed in) rather than a fresh candidate — proving existing users
// beyond the first page are detected and not re-created.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress, OrgBrand } from '../_shared/orgBrand.ts';
import { isEmailAllowed, emailGuardActive } from '../_shared/emailGuard.ts';
import { logPlatformEvent, FEATURE, ACTION, OUTCOME } from '../_shared/logPlatformEvent.ts';

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

// Condense a Resend / auth error into one short human-readable line for the operator.
function shortErr(raw: string): string {
  if (!raw) return 'unknown error';
  try {
    const j = JSON.parse(raw);
    return String(j.message || j.error || j.name || raw).slice(0, 160);
  } catch {
    return raw.slice(0, 160);
  }
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
    const subject = `Your parent portal is ready — ${brand.org_name}`;

    // Look up existing auth users. We RE-SEND to accounts that exist but never
    // signed in (e.g. a prior send failed) instead of silently skipping them, and
    // skip only families who have actually signed in already (truly onboarded).
    //
    // Paginate through ALL auth users: a single unpaginated listUsers() returns
    // only the first page (default 50), so once the project has more users than
    // one page, existing parents beyond it look missing → duplicate createUser
    // attempts, failed invites, and un-healed parents.auth_id. Match the
    // perPage=1000 that admin-list-members already uses, and loop pages so we're
    // correct beyond 1000 users too. MAX_PAGES is a defensive runaway cap.
    const userByEmail = new Map<string, any>();
    const PER_PAGE = 1000;
    const MAX_PAGES = 50;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data: pageData, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (listErr) return json({ error: `List users: ${listErr.message}` }, 500);
      const users = pageData?.users ?? [];
      for (const u of users) {
        if (u.email) userByEmail.set(u.email.toLowerCase(), u);
      }
      if (users.length < PER_PAGE) break;
    }

    let skippedActive = 0;
    const toInvite: Array<{ first_name: string; last_name: string; email: string; hasAccount: boolean; parentId: string; existingId: string | null }> = [];
    for (const c of candidates) {
      const existing = userByEmail.get(c.email.toLowerCase());
      if (existing?.last_sign_in_at) { skippedActive++; continue; } // already signed in — truly has access
      toInvite.push({ first_name: c.first_name, last_name: c.last_name, email: c.email, hasAccount: !!existing, parentId: c.id, existingId: existing?.id ?? null });
    }

    // Staging recipient guard: on staging, only allowlisted inboxes actually
    // receive — so a test never blasts synthetic/real families. Prod = allow all.
    const guardOn = emailGuardActive();
    const deliverable = guardOn ? toInvite.filter((c) => isEmailAllowed(c.email)) : toInvite;
    const heldBack = toInvite.length - deliverable.length;

    // Preview mode: return exactly who would be emailed + the rendered email.
    // Nothing is created and nothing is sent.
    if (preview) {
      return json({
        preview: true,
        total_candidates: deliverable.length,
        held_back: heldBack,
        skipped_active: skippedActive,
        skipped_no_email: skippedNoEmail,
        from: fromAddr,
        subject,
        recipients: deliverable.map((c) => ({ name: `${c.first_name} ${c.last_name}`.trim() || c.email, email: c.email })),
        preview_html: buildInviteEmail(brand, deliverable[0]?.first_name || 'there', '#', prog.curriculum, loginUrl),
      });
    }

    let invited = 0, failed = 0;
    const failedReasons: Array<{ email: string; reason: string }> = [];
    for (const c of deliverable) {
      // Create the account only if missing — the auth.users trigger links
      // parents.auth_id by email. Existing-but-never-signed-in just gets a re-send.
      let authUserId = c.existingId;
      if (!c.hasAccount) {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: c.email, email_confirm: true });
        if (createErr) { console.error('createUser failed', c.email, createErr.message); failed++; failedReasons.push({ email: c.email, reason: shortErr(createErr.message) }); continue; }
        authUserId = created?.user?.id ?? null;
      }
      // Self-heal: the on-create trigger links parents.auth_id, but a pre-existing
      // account leaves it unlinked → the parent's portal can't resolve. Link it
      // now (only when null, so we never steal a correct link or hit the unique idx).
      if (authUserId) {
        await admin.from('parents').update({ auth_id: authUserId }).eq('id', c.parentId).is('auth_id', null);
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
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('Resend failed', c.email, errText);
        failed++; failedReasons.push({ email: c.email, reason: shortErr(errText) });
        continue;
      }
      invited++;
    }

    console.log(`invite-parents: org=${organizationId} program=${programId} invited=${invited} skipped_active=${skippedActive} held_back=${heldBack} failed=${failed}`);
    if (!preview) {
      await logPlatformEvent(admin, {
        feature: FEATURE.ROSTERS, action: ACTION.FAMILIES_INVITED,
        outcome: invited > 0 ? OUTCOME.SUCCESS : OUTCOME.FAIL,
        organizationId: organizationId, actorUserId: userData.user.id,
        metadata: { invited, skipped_active: skippedActive, failed, program_id: programId },
      });
    }
    return json({ invited, skipped_active: skippedActive, skipped_no_email: skippedNoEmail, held_back: heldBack, failed, failed_reasons: failedReasons, total_candidates: deliverable.length });
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
    <h1 style="color:#fff;margin:8px 0 0;font-size:22px;font-weight:700;">Your parent portal is ready</h1>
  </div>
  <div style="padding:28px;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Hi ${firstName},</p>
    <p style="margin:0 0 20px;font-size:15px;color:#1a1a1a;line-height:1.6;">
      Your child is enrolled${programName ? ` in <strong>${programName}</strong>` : ''}. Sign in to your parent portal to see your child's program details, sign any required forms, and get updates.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signInUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        Sign in
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6b6b6b;line-height:1.6;">This one-click link works for 24 hours.${loginUrl ? ` After that you can sign in any time at <a href="${loginUrl}" style="color:${primary};">your parent portal</a> — we'll email you a fresh link.` : ''} Questions? Just reply to this email.</p>
  </div>
</div>
</body></html>`;
}
