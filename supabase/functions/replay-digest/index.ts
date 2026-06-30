// replay-digest: Mon/Wed/Fri operational job. Pulls recent admin session
// recordings from PostHog, maps each to its provider via the Enrops DB, and
// emails Jessica a digest (with direct replay links) via Resend.
//
// Invoked by pg_cron (see migration). Gated by a Vault-stored shared secret in
// the Authorization header — verify_jwt is OFF; we do our own check.
//
// Query params (for manual test-fire only): ?include_staging=true&force=true
// - include_staging: also include enrops-staging admin sessions
// - force: send the email even when there are 0 sessions

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const DIGEST_EMAIL = Deno.env.get('REPLAY_DIGEST_EMAIL') ?? 'jessica@journeytosteam.com';
const FROM_EMAIL = 'Enrops <hello@updates.journeytosteam.com>';
const POSTHOG_HOST = 'https://us.posthog.com';
const POSTHOG_PROJECT = '437783';

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function pathOf(u: string): string {
  try { return new URL(u).pathname; } catch { return u; }
}

serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // --- Auth: only callers presenting the Vault-stored gate secret may run. ---
    const { data: expected } = await supabase.rpc('app_secret', { p_name: 'replay_digest_cron_secret' });
    const auth = req.headers.get('Authorization') ?? '';
    if (!expected || auth !== `Bearer ${expected}`) return json({ error: 'Unauthorized' }, 401);

    const url = new URL(req.url);
    const includeStaging = url.searchParams.get('include_staging') === 'true';
    const force = url.searchParams.get('force') === 'true';

    // --- 1. PostHog read key from Vault. ---
    const { data: phKey, error: keyErr } = await supabase.rpc('app_secret', { p_name: 'posthog_read_key' });
    if (keyErr || !phKey) return json({ error: 'Missing PostHog key' }, 500);

    // --- 2. Recent recordings (last 3 days covers the M/W/F gap). ---
    const phRes = await fetch(
      `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT}/session_recordings/?date_from=-3d&limit=100`,
      { headers: { Authorization: `Bearer ${phKey}` } },
    );
    if (!phRes.ok) return json({ error: 'PostHog query failed', status: phRes.status }, 502);
    const phData = await phRes.json();
    const all: any[] = Array.isArray(phData.results) ? phData.results : [];

    // --- 3. Keep admin sessions; prod-only unless include_staging. ---
    const sessions = all.filter((r) => {
      const u = String(r.start_url ?? '');
      if (!u.includes('/admin')) return false;
      const isProd = u.includes('enrops.com');
      const isStaging = u.includes('enrops-staging');
      return isProd || (includeStaging && isStaging);
    });

    // --- 4. Map distinct_id -> provider name. ---
    const uids = [...new Set(sessions.map((s) => s.distinct_id).filter(Boolean))];
    const orgByUid: Record<string, string | null> = {};
    if (uids.length) {
      const { data: members } = await supabase
        .from('org_members')
        .select('auth_user_id, organizations(name)')
        .in('auth_user_id', uids);
      for (const m of members ?? []) {
        const org = Array.isArray((m as any).organizations) ? (m as any).organizations[0] : (m as any).organizations;
        orgByUid[(m as any).auth_user_id] = org?.name ?? null;
      }
    }

    // --- 5. Skip noise: don't email when there's nothing (unless forced). ---
    if (sessions.length === 0 && !force) {
      return json({ sessions: 0, emailed: false, note: 'no admin sessions; email skipped' }, 200);
    }

    // --- 6. Build + send the digest. ---
    const mins = (sec: number) => Math.max(1, Math.round((sec ?? 0) / 60));
    const rows = sessions.map((s) => {
      const provider = orgByUid[s.distinct_id] ?? 'Unknown / not signed in';
      const env = String(s.start_url ?? '').includes('enrops-staging') ? ' <span style="color:#8a6d00">[staging]</span>' : '';
      const errs = (s.console_error_count ?? 0) > 0 ? ` · <span style="color:#b3261e">⚠ ${s.console_error_count} error(s)</span>` : '';
      const link = `${POSTHOG_HOST}/project/${POSTHOG_PROJECT}/replay/${s.id}`;
      const cell = 'padding:8px 12px;border-bottom:1px solid #e2dfd5';
      return `<tr>
        <td style="${cell}"><strong>${esc(provider)}</strong>${env}</td>
        <td style="${cell}">${mins(s.recording_duration)} min</td>
        <td style="${cell}">${esc(pathOf(String(s.start_url ?? '')))}</td>
        <td style="${cell}">${s.click_count ?? 0} clicks${errs}</td>
        <td style="${cell}"><a href="${link}" style="color:#5847C9;font-weight:600;text-decoration:none">Watch →</a></td>
      </tr>`;
    }).join('');

    const n = sessions.length;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a">
      <h2 style="color:#1C004F;margin:0 0 4px">Replay digest — ${n} session${n === 1 ? '' : 's'} to review</h2>
      <p style="color:#6b6b6b;margin:0 0 14px;font-size:13px">Admin sessions from the last 3 days. Names &amp; dollar amounts are masked in playback (privacy).</p>
      ${n ? `<table style="border-collapse:collapse;width:100%;font-size:14px">
        <tr style="text-align:left;color:#6b6b6b;font-size:11px;text-transform:uppercase">
          <th style="padding:8px 12px">Provider</th><th style="padding:8px 12px">Length</th><th style="padding:8px 12px">Started on</th><th style="padding:8px 12px">Activity</th><th style="padding:8px 12px"></th>
        </tr>${rows}</table>`
        : `<p style="font-size:14px">No new admin sessions in this window — nothing to review.</p>`}
      <p style="margin-top:18px;font-size:12px;color:#6b6b6b">Long pauses = confusion · repeated clicks = something's unclear · ⚠ errors = a bug to check.</p>
    </div>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: DIGEST_EMAIL,
        subject: `Enrops replay digest — ${n} session${n === 1 ? '' : 's'} to review`,
        html,
      }),
    });
    return json({ sessions: n, emailed: r.ok }, 200);
  } catch (e) {
    console.error('replay-digest error:', String(e));
    return json({ error: 'Unexpected', detail: String(e) }, 500);
  }
});
