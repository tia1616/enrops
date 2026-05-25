// admin-invite — grant an existing person admin access to the caller's org.
//
// Caller must be an owner or admin (own org_members row, accepted_at not null).
// The target org is derived from the caller's membership — admins can only
// invite into the org they belong to.
//
// Flow:
//   1. Verify JWT, confirm caller is owner/admin.
//   2. Get-or-create auth.users row for the target email.
//   3. Upsert org_members(auth_user_id, organization_id, role, accepted_at=now()).
//      accepted_at is set immediately because the inviting admin pre-approved.
//   4. Generate magic link → /admin and send via Resend.
//
// Only owners can mint another owner. Defaults to role 'admin'.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

interface AdminInviteBody {
  email?: string;
  role?: 'admin' | 'owner';
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    let body: AdminInviteBody;
    try {
      body = (await req.json()) as AdminInviteBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const email = body.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'invalid_email' }, 400);
    }
    const role: 'admin' | 'owner' = body.role === 'owner' ? 'owner' : 'admin';

    const { data: callerMember, error: cmErr } = await supabase
      .from('org_members')
      .select('organization_id, role')
      .eq('auth_user_id', callerAuthId)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (cmErr) {
      console.error('caller org_members lookup failed:', cmErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!callerMember) return FORBIDDEN;

    // Only owners can mint owners.
    if (role === 'owner' && callerMember.role !== 'owner') return FORBIDDEN;

    const organizationId = callerMember.organization_id;

    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, slug, name, default_sender_name, default_sender_email')
      .eq('id', organizationId)
      .maybeSingle();
    if (orgErr || !org) {
      console.error('org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!org.slug || !org.default_sender_name || !org.default_sender_email) {
      return json({ error: 'org_missing_sender_config' }, 500);
    }

    let authUserId: string | null = null;
    const { data: createdUser, error: createErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr) {
      if (/already.+registered|exists/i.test(createErr.message ?? '')) {
        const { data: usersList } = await supabase.auth.admin.listUsers();
        const existing = usersList?.users?.find(
          (u) => u.email?.toLowerCase() === email,
        );
        if (existing) {
          authUserId = existing.id;
        } else {
          console.error('createUser failed, no existing user found:', createErr);
          return json({ error: 'auth_create_failed', detail: createErr.message }, 500);
        }
      } else {
        console.error('createUser failed:', createErr);
        return json({ error: 'auth_create_failed', detail: createErr.message }, 500);
      }
    } else {
      authUserId = createdUser.user?.id ?? null;
    }
    if (!authUserId) return json({ error: 'auth_create_failed' }, 500);

    const nowIso = new Date().toISOString();
    const { data: existingMember, error: emErr } = await supabase
      .from('org_members')
      .select('id, accepted_at, role')
      .eq('auth_user_id', authUserId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (emErr) {
      console.error('existing org_members lookup failed:', emErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    let outcome: 'added' | 'updated' | 'resent';
    if (existingMember) {
      const { error: updErr } = await supabase
        .from('org_members')
        .update({
          role,
          accepted_at: existingMember.accepted_at ?? nowIso,
        })
        .eq('id', existingMember.id);
      if (updErr) {
        console.error('org_members update failed:', updErr);
        return json({ error: 'membership_update_failed' }, 500);
      }
      outcome = existingMember.role === role ? 'resent' : 'updated';
    } else {
      const { error: insErr } = await supabase
        .from('org_members')
        .insert({
          auth_user_id: authUserId,
          organization_id: organizationId,
          role,
          accepted_at: nowIso,
        });
      if (insErr) {
        console.error('org_members insert failed:', insErr);
        return json({ error: 'membership_insert_failed' }, 500);
      }
      outcome = 'added';
    }

    const origin = req.headers.get('origin') ?? 'https://enrops.com';
    const redirectTo = `${origin}/admin`;
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      console.error('magic link generation failed:', linkErr);
      return json({ error: 'magic_link_failed' }, 500);
    }
    const magicLink = linkData.properties.action_link;

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      console.error('RESEND_API_KEY not set');
      return json({ error: 'email_not_configured' }, 500);
    }

    const subject = `You're invited to ${org.name} on Enrops`;
    const text = [
      `You've been invited to join ${org.name} on Enrops as ${role === 'owner' ? 'an owner' : 'an admin'}.`,
      ``,
      `Click below to sign in:`,
      `${magicLink}`,
      ``,
      `If you weren't expecting this invite, you can ignore this email.`,
    ].join('\n');

    const html = buildEmailHtml({ orgName: org.name ?? 'Enrops', role, magicLink });

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${org.default_sender_name} <${org.default_sender_email}>`,
        to: email,
        subject,
        text,
        html,
        tags: [{ name: 'type', value: 'admin_invite' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend admin invite send failed:', resp.status, errText);
      // Membership is already created — surface that so the admin knows the
      // user can still sign in via /admin/login even though the email failed.
      return json(
        {
          error: 'email_send_failed',
          detail: 'Membership was created but the invite email did not send. The user can still sign in via /admin/login.',
          outcome,
        },
        502,
      );
    }

    return json({
      success: true,
      email,
      role,
      outcome,
      organization_id: organizationId,
    });
  } catch (err) {
    console.error('admin-invite fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

function buildEmailHtml(args: { orgName: string; role: string; magicLink: string }): string {
  const { orgName, role, magicLink } = args;
  const roleLabel = role === 'owner' ? 'an owner' : 'an admin';
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;line-height:1.6;">
  <h2 style="font-size:20px;margin:0 0 16px 0;">You're invited to ${escapeHtml(orgName)} on Enrops</h2>
  <p>You've been added as ${escapeHtml(roleLabel)} on ${escapeHtml(orgName)}'s Enrops workspace.</p>
  <p style="margin:24px 0;">
    <a href="${magicLink}" style="display:inline-block;padding:12px 24px;background:#1C004F;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">Sign in →</a>
  </p>
  <p style="color:#666;font-size:14px;">If the button doesn't work, paste this link into your browser:<br/><span style="word-break:break-all;">${magicLink}</span></p>
  <p style="color:#999;font-size:12px;">If you weren't expecting this invite, you can ignore this email.</p>
</div>`.trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
