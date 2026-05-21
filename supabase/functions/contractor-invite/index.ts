// contractor-invite — admin-triggered endpoint that sends a contractor their
// onboarding magic link and creates / updates their onboarding row.
//
// Different auth model than the instructor-facing functions: the JWT belongs
// to an ORG ADMIN, not the instructor being invited. The admin's auth.uid()
// must match an org_members row with role IN ('owner', 'admin') AND
// organization_id = the target instructor's org.
//
// Anti-enumeration: a missing instructor and a non-admin caller both return
// the same 403 response — an attacker can't probe valid instructor IDs.
//
// Tenant identity: org slug, default sender name/email come from the
// organizations row. Never hardcoded as /j2s/ or "Journey to STEAM".

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

interface ContractorInviteBody {
  instructor_id?: string;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // 1. Verify JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // 2. Parse body
    let body: ContractorInviteBody;
    try {
      body = (await req.json()) as ContractorInviteBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const instructorId = body.instructor_id?.trim();
    if (!instructorId) return json({ error: 'instructor_id_required' }, 400);

    // 3. Look up instructor (service_role bypasses RLS).
    // Don't 404 yet — combine missing-instructor with not-authorized below.
    const { data: instructorRow, error: instErr } = await supabase
      .from('instructors')
      .select('id, email, first_name, last_name, auth_user_id, organization_id')
      .eq('id', instructorId)
      .maybeSingle();
    if (instErr) {
      console.error('instructor lookup failed:', instErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // 4. Authorize: caller must be owner/admin in the instructor's org.
    // If instructor doesn't exist, we still want to 403 (same response as
    // not-authorized) to prevent enumeration.
    if (!instructorRow) return FORBIDDEN;

    const { data: orgMemberRow, error: omErr } = await supabase
      .from('org_members')
      .select('organization_id')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', instructorRow.organization_id)
      .in('role', ['owner', 'admin'])
      .maybeSingle();
    if (omErr) {
      console.error('org_members lookup failed:', omErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!orgMemberRow) return FORBIDDEN;

    // Instructor missing email is unusual — block invite.
    if (!instructorRow.email) {
      return json({ error: 'instructor_missing_email' }, 400);
    }

    // 5. If auth_user_id is null, create the auth user.
    let authUserId = instructorRow.auth_user_id as string | null;
    if (!authUserId) {
      const { data: createdUser, error: createErr } = await supabase.auth.admin.createUser({
        email: instructorRow.email,
        email_confirm: true,
      });
      if (createErr) {
        // Email may already be in use by another auth.users row (e.g., they
        // registered as a parent). Try to look that up and link.
        if (/already.+registered|exists/i.test(createErr.message ?? '')) {
          const { data: usersList } = await supabase.auth.admin.listUsers();
          const existing = usersList?.users?.find(
            (u) => u.email?.toLowerCase() === instructorRow.email!.toLowerCase(),
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

      if (!authUserId) {
        return json({ error: 'auth_create_failed' }, 500);
      }

      // Link the new auth user to the instructor row.
      const { error: linkErr } = await supabase
        .from('instructors')
        .update({ auth_user_id: authUserId })
        .eq('id', instructorRow.id);
      if (linkErr) {
        console.error('instructor auth_user_id update failed:', linkErr);
        return json({ error: 'link_failed' }, 500);
      }
    }

    // 6. Upsert contractor_onboarding_status.
    const nowIso = new Date().toISOString();
    const { data: existingOnb, error: onbFetchErr } = await supabase
      .from('contractor_onboarding_status')
      .select('id, overall_status')
      .eq('instructor_id', instructorRow.id)
      .maybeSingle();
    if (onbFetchErr) {
      console.error('onboarding fetch failed:', onbFetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    if (existingOnb) {
      // Resend — keep the existing status (don't demote a contractor who's
      // already in_progress back to 'invited'). Just refresh invited_at.
      const { error: updErr } = await supabase
        .from('contractor_onboarding_status')
        .update({ invited_at: nowIso, updated_at: nowIso })
        .eq('id', existingOnb.id);
      if (updErr) {
        console.error('onboarding update failed:', updErr);
        return json({ error: 'onboarding_update_failed' }, 500);
      }
    } else {
      // First invite.
      // The sync trigger trg_sync_onboarding_status will mirror overall_status
      // to instructors.onboarding_status — don't touch that column directly.
      const { error: insErr } = await supabase
        .from('contractor_onboarding_status')
        .insert({
          instructor_id: instructorRow.id,
          organization_id: instructorRow.organization_id,
          overall_status: 'invited',
          invited_at: nowIso,
        });
      if (insErr) {
        console.error('onboarding insert failed:', insErr);
        return json({ error: 'onboarding_insert_failed' }, 500);
      }
    }

    // 7. Look up org for tenant-derived values (NEVER hardcode J2S identity).
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('slug, name, default_sender_name, default_sender_email')
      .eq('id', instructorRow.organization_id)
      .maybeSingle();
    if (orgErr) {
      console.error('org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!org?.slug || !org.default_sender_name || !org.default_sender_email) {
      console.error('org missing slug or sender config:', {
        organization_id: instructorRow.organization_id,
      });
      return json({ error: 'org_missing_sender_config', organization_id: instructorRow.organization_id }, 500);
    }

    // 8. Generate magic link via Supabase auth admin.
    const redirectTo = `https://enrops.com/${org.slug}/onboarding`;
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: instructorRow.email,
      options: { redirectTo },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      console.error('magic link generation failed:', linkErr);
      return json({ error: 'magic_link_failed' }, 500);
    }
    const magicLink = linkData.properties.action_link;

    // 9. Send email via Resend.
    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      console.error('RESEND_API_KEY not set');
      return json({ error: 'email_not_configured' }, 500);
    }

    const firstName = instructorRow.first_name ?? 'there';
    const subject = `${org.name} — start your contractor onboarding in enrops`;

    const text = [
      `Hi ${firstName},`,
      ``,
      `${org.name} is moving to enrops for all contractor paperwork, scheduling, and payments. Click below to start your onboarding — it takes about 15 minutes.`,
      ``,
      `Start onboarding: ${magicLink}`,
      ``,
      `If you have questions, reach out to the admin.`,
      ``,
      `Please complete by Friday, June 12.`,
    ].join('\n');

    const html = buildEmailHtml({
      firstName,
      orgName: org.name ?? 'enrops',
      magicLink,
    });

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${org.default_sender_name} <${org.default_sender_email}>`,
        to: instructorRow.email,
        subject,
        text,
        html,
        tags: [{ name: 'type', value: 'contractor_invite' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend invite send failed:', resp.status, errText);
      // Auth user + onboarding row are already created — return error but
      // make clear the state was partially advanced so the admin can retry
      // sending without re-creating the user.
      return json(
        {
          error: 'email_send_failed',
          detail: 'Onboarding record created but invite email did not send. You can re-send from the admin panel.',
        },
        502,
      );
    }

    return json({
      success: true,
      instructor_id: instructorRow.id,
      status: 'invited',
    });
  } catch (err) {
    console.error('contractor-invite fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

function buildEmailHtml(args: { firstName: string; orgName: string; magicLink: string }): string {
  const { firstName, orgName, magicLink } = args;
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;line-height:1.6;">
  <h2 style="font-size:20px;margin:0 0 16px 0;">Start your contractor onboarding</h2>
  <p>Hi ${escapeHtml(firstName)},</p>
  <p>${escapeHtml(orgName)} is moving to enrops for all contractor paperwork, scheduling, and payments. Click below to start your onboarding — it takes about 15 minutes.</p>
  <p style="margin:24px 0;">
    <a href="${magicLink}" style="display:inline-block;padding:12px 24px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">Start onboarding →</a>
  </p>
  <p style="color:#666;font-size:14px;">If the button doesn't work, paste this link into your browser:<br/><span style="word-break:break-all;">${magicLink}</span></p>
  <p>Please complete by Friday, June 12.</p>
</div>`.trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
