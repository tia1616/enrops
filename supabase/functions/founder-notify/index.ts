// founder-notify - sends ONE real-time email per operator milestone to the founder.
//
// Spec: "enrops Founder Notifications" (2026-07-27). Two triggers, one email each,
// no digest, no batching:
//   first_registration - the operator published their first enrops-hosted program/camp
//   first_transaction  - the operator collected their first family payment
//
// This function does NOT decide whether to send. The database already did: a row in
// public.founder_notifications exists only because UNIQUE(organization_id, trigger_key)
// let exactly one claim through. This function's whole job is to turn that claim into
// a readable email. That split is what makes "first" un-double-sendable even if pg_net
// retries or two publishes race.
//
// AUTH: verify_jwt = false. pg_net calls us with the Vault secret `founder_notify_secret`
// as a Bearer token and we check it ourselves (same shape as replay-digest /
// platform-intelligence-digest).
//
// IDEMPOTENT: a row with sent_at already set returns 200 and sends nothing.
//
// RECIPIENT is config, not code: FOUNDER_ALERT_EMAIL env var (comma-separated for more
// than one). Mirrors how platform-intelligence-digest takes REPLAY_DIGEST_EMAIL.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
// Formatting lives in lib.ts so it is unit-tested. Do NOT re-inline these here:
// a second copy is a copy the tests do not cover.
import { cityStateFrom, fmtWhen, fmtDate, fmtMoney, esc, pickOperatorName } from './lib.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const PUBLIC_SITE_URL = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com';
const FOUNDER_EMAILS = (Deno.env.get('FOUNDER_ALERT_EMAIL') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // --- Auth: the Vault gate secret, checked by us (verify_jwt is off). ---
    const { data: expected } = await supabase.rpc('app_secret', { p_name: 'founder_notify_secret' });
    const auth = req.headers.get('Authorization') ?? '';
    if (!expected || auth !== `Bearer ${expected}`) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const id: string | undefined = body?.notification_id;
    if (!id) return json({ error: 'notification_id required' }, 400);

    const { data: note } = await supabase
      .from('founder_notifications')
      .select('id, organization_id, trigger_key, subject_table, subject_id, occurred_at, sent_at, backfilled')
      .eq('id', id)
      .maybeSingle();

    if (!note) return json({ error: 'not found' }, 404);

    // Preview: render and return the exact email HTML without sending it. Same
    // secret gate. Exists so the rendered output can be eyeballed against real
    // data instead of taken on faith, and so a formatting bug can be diagnosed
    // without mailing anybody.
    const preview = body?.preview === true;

    // Already sent, or a historical suppression row: never send.
    if (!preview && note.sent_at) return json({ ok: true, skipped: 'already_sent' }, 200);
    if (!preview && note.backfilled) return json({ ok: true, skipped: 'backfilled' }, 200);

    if (!preview && !FOUNDER_EMAILS.length) {
      // Fail LOUD in the log but do not mark sent - so configuring the env var
      // later and re-dispatching still delivers.
      console.error('[founder-notify] FOUNDER_ALERT_EMAIL is not set; nothing sent');
      return json({ error: 'FOUNDER_ALERT_EMAIL not configured' }, 500);
    }

    // --- The operator ---
    const { data: org } = await supabase
      .from('organizations')
      .select('id, slug, name, email, timezone')
      .eq('id', note.organization_id)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);

    const tz = org.timezone || 'America/Los_Angeles';

    // Operator NAME + contact email: the owner on org_members is the human who
    // signed up. organizations.email is the fallback (and is all we have for
    // orgs provisioned by hand).
    const { data: members } = await supabase
      .from('org_members')
      .select('name, email, role, created_at, auth_user_id')
      .eq('organization_id', org.id)
      .order('created_at', { ascending: true });

    const owner = (members ?? []).find((m: any) => m.role === 'owner') ?? (members ?? [])[0] ?? null;
    const contactEmail = owner?.email || org.email || null;

    let authFullName: string | null = null;
    let authName: string | null = null;

    // org_members.name is null for HALF the real operators (7 of 14 on prod), but
    // the name they typed at signup survives on the auth user. Checked against live
    // data, this recovers a real name for two more operators that would otherwise
    // print as nameless. Skip values that are just the business name repeated -
    // that is already the headline.
    if (!(owner?.name ?? '').trim() && owner?.auth_user_id) {
      try {
        const { data: authUser } = await supabase.auth.admin.getUserById(owner.auth_user_id);
        const meta = (authUser?.user?.user_metadata ?? {}) as Record<string, unknown>;
        authFullName = meta.full_name ? String(meta.full_name) : null;
        authName = meta.name ? String(meta.name) : null;
      } catch (_) {
        // Never let a name lookup cost us the whole notification.
      }
    }

    const operatorName = pickOperatorName(owner?.name, authFullName, authName, org.name);

    // --- Trigger-specific facts ---
    const facts: Array<[string, string]> = [];
    let subjectNoun = '';
    let cityState: string | null = null;

    if (note.trigger_key === 'first_registration') {
      subjectNoun = 'First registration';

      if (note.subject_table === 'programs') {
        const { data: p } = await supabase
          .from('programs')
          .select('curriculum, first_session_date, day_of_week, program_location_id')
          .eq('id', note.subject_id)
          .maybeSingle();
        if (p) {
          if (p.curriculum) facts.push(['Program', p.curriculum]);
          const d = fmtDate(p.first_session_date);
          if (d) facts.push(['First session', d]);
          else if (p.day_of_week) facts.push(['First session', `${p.day_of_week}s - date not set yet`]);
          if (p.program_location_id) {
            const { data: loc } = await supabase
              .from('program_locations').select('address, area').eq('id', p.program_location_id).maybeSingle();
            cityState = cityStateFrom(loc?.address) ?? (loc?.area || null);
          }
        }
      } else if (note.subject_table === 'camp_sessions') {
        const { data: c } = await supabase
          .from('camp_sessions')
          .select('curriculum_name, starts_on, location_id, location_name')
          .eq('id', note.subject_id)
          .maybeSingle();
        if (c) {
          if (c.curriculum_name) facts.push(['Camp', c.curriculum_name]);
          const d = fmtDate(c.starts_on);
          if (d) facts.push(['First session', d]);
          if (c.location_id) {
            const { data: loc } = await supabase
              .from('program_locations').select('address, area').eq('id', c.location_id).maybeSingle();
            cityState = cityStateFrom(loc?.address) ?? (loc?.area || null);
          }
        }
      }
    } else {
      subjectNoun = 'First transaction';

      if (note.subject_id) {
        // Scoped to the notification's own org as well as the id: defence in depth
        // so a leaked gate secret still cannot read another operator's money.
        const { data: reg } = await supabase
          .from('registrations')
          .select('amount_cents, parent_id')
          .eq('id', note.subject_id)
          .eq('organization_id', org.id)
          .maybeSingle();
        const amount = fmtMoney(reg?.amount_cents ?? null);
        if (amount) facts.push(['Amount', amount]);
        if (reg?.parent_id) {
          const { data: parent } = await supabase
            .from('parents').select('first_name').eq('id', reg.parent_id).maybeSingle();
          // First name only - enough to make it a person, not a full contact record.
          if (parent?.first_name) facts.push(['First family', parent.first_name]);
        }
      }
    }

    // City/state fallback: any location this org has an address for. Still null for
    // an operator running out of their own unlisted space - we print nothing then.
    if (!cityState) {
      const { data: anyLoc } = await supabase
        .from('program_locations')
        .select('address, area')
        .eq('organization_id', org.id)
        .not('address', 'is', null)
        .limit(1);
      cityState = cityStateFrom(anyLoc?.[0]?.address) ?? (anyLoc?.[0]?.area || null);
    }

    // --- Compose ---
    // The link is the operator's real, live public page. There is deliberately NO
    // "open their account" link: no such founder-facing surface exists, and an
    // invented URL is worse than none.
    const publicUrl = org.slug ? `${PUBLIC_SITE_URL}/${org.slug}` : null;

    // No 'Business' row: the business name is already the headline. Repeating it
    // here just made every email say it twice.
    const header: Array<[string, string | null]> = [
      ['Operator', operatorName],
      ['Where', cityState],
      ['Contact', contactEmail],
      ['When', fmtWhen(note.occurred_at, tz)],
    ];

    const rows = [...header, ...facts.map(([k, v]) => [k, v] as [string, string | null])]
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr>
        <td style="padding:6px 16px 6px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${esc(k)}</td>
        <td style="padding:6px 0;color:#1a1a1a;font-size:15px;font-weight:600;">${esc(v)}</td>
      </tr>`).join('');

    const subject = `[enrops] ${subjectNoun === 'First registration' ? 'First registration' : 'First transaction'}: ${org.name ?? org.slug ?? 'unknown operator'}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="background:#1C004F;padding:24px 28px;">
    <div style="color:#8C88FF;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${esc(subjectNoun)}</div>
    <div style="color:#fff;margin-top:6px;font-size:21px;font-weight:700;">${esc(org.name ?? org.slug ?? '')}</div>
  </div>
  <div style="padding:24px 28px;">
    <table style="border-collapse:collapse;width:100%;">${rows}</table>
    ${publicUrl ? `<div style="margin-top:24px;">
      <a href="${esc(publicUrl)}" style="display:inline-block;background:#8C88FF;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:14px;font-weight:600;">See their page</a>
    </div>` : ''}
  </div>
</div>
</body></html>`;

    if (preview) {
      return new Response(JSON.stringify({ subject, html }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    const brand = await loadOrgBrand(supabase, null); // Enrops platform sender

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: formatFromAddress(brand),
        to: FOUNDER_EMAILS,
        subject,
        html,
        tags: [{ name: 'type', value: 'founder_notification' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[founder-notify] Resend failed:', resp.status, errText);
      // Record the failure but leave sent_at null so it stays visibly unsent.
      await supabase.from('founder_notifications')
        .update({ send_error: `${resp.status}: ${errText}`.slice(0, 500) })
        .eq('id', note.id);
      return json({ error: 'send failed' }, 502);
    }

    await supabase.from('founder_notifications')
      .update({ sent_at: new Date().toISOString(), send_error: null })
      .eq('id', note.id);

    return json({ ok: true, sent_to: FOUNDER_EMAILS.length }, 200);
  } catch (e) {
    console.error('[founder-notify] error:', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
