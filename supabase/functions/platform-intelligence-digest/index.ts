// platform-intelligence-digest: WEEKLY (Monday) platform-owner email.
//
// Answers "what are operators USING across the whole platform, what do they NOT
// use, and where does it succeed/fail?" — reading the sealed intelligence DB
// layer (NOT PostHog, NOT the front-end):
//   1. platform_usage_summary()  → per-feature adoption + success/fail, cross-tenant
//   2. platform_funnel_summary() → the enrollment funnel (one section)
// …and emails the digest to Jessica via Resend.
//
// Mirrors `replay-digest`: Vault-gated (verify_jwt OFF, we check the secret
// ourselves). No PostHog dependency — usage is captured server-side via
// log_platform_event() (edge fns) + DB triggers.
//
// Query params (manual test-fire only): ?force=true (send even if no usage yet),
//   ?days=N (window; default 7).
//
// DEPLOY (prod-manual, like replay-digest — see companion infra migration):
//   reuses `replay_digest_cron_secret`; pg_cron '0 15 * * 1' (~8am PT Monday).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const DIGEST_EMAIL = Deno.env.get('REPLAY_DIGEST_EMAIL') ?? 'jessica@journeytosteam.com';
const FROM_EMAIL = 'Enrops <hello@updates.journeytosteam.com>';

// Features we ACTUALLY capture today (edge-fn log calls or DB triggers). A feature
// here with zero events = an honest "untouched" (instrumented-but-unused) signal.
// Add each as its capture is wired (see docs/moat/INTELLIGENCE_LAYER_RULES.md).
const INSTRUMENTED_FEATURES: Record<string, string> = {
  programs: 'Programs',       // DB triggers (create/publish)
  scheduling: 'Scheduling',   // send-offers edge fn (offer_sent)
  // Next: rosters, campaigns, curricula, instructors, payroll, finances, …
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // --- Auth: only callers with the Vault-stored gate secret may run. ---
    const { data: expected } = await supabase.rpc('app_secret', { p_name: 'replay_digest_cron_secret' });
    const auth = req.headers.get('Authorization') ?? '';
    if (!expected || auth !== `Bearer ${expected}`) return json({ error: 'Unauthorized' }, 401);

    const url = new URL(req.url);
    const force = url.searchParams.get('force') === 'true';
    const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') ?? '7', 10) || 7));

    // --- 1. Feature usage + funnel, straight from the sealed intelligence layer. ---
    const [{ data: usage }, { data: funnel }] = await Promise.all([
      supabase.rpc('platform_usage_summary', { p_days: days }),
      supabase.rpc('platform_funnel_summary', { p_days: days }),
    ]);
    const usageRowsRaw: any[] = Array.isArray(usage) ? usage : [];
    const f = (funnel as any) ?? {};

    // Map org ids -> names for a friendlier read.
    const allOrgIds = new Set<string>();
    for (const u of usageRowsRaw) for (const id of (u.org_ids ?? [])) if (id) allOrgIds.add(id);
    const orgName: Record<string, string> = {};
    if (allOrgIds.size) {
      const { data: orgs } = await supabase.from('organizations').select('id, name').in('id', [...allOrgIds]);
      for (const o of orgs ?? []) orgName[(o as any).id] = (o as any).name ?? '';
    }

    const seen = new Set(usageRowsRaw.map((u) => u.feature));
    const trackedUsed = usageRowsRaw.filter((u) => u.feature in INSTRUMENTED_FEATURES);
    const untouched = Object.keys(INSTRUMENTED_FEATURES).filter((k) => !seen.has(k));
    const totalTrackedEvents = trackedUsed.reduce((s, u) => s + (Number(u.success) || 0) + (Number(u.fail) || 0), 0);

    // --- 2. Skip noise when there's nothing yet (unless forced). ---
    if (totalTrackedEvents === 0 && !force) {
      return json({ events: 0, emailed: false, note: 'no feature usage in window; email skipped' }, 200);
    }

    // --- 3. Build + send. ---
    const cell = 'padding:8px 12px;border-bottom:1px solid #e2dfd5';
    const usageHtml = trackedUsed.map((u) => {
      const label = INSTRUMENTED_FEATURES[u.feature] ?? u.feature;
      const who = (u.org_ids ?? []).map((id: string) => esc(orgName[id] || id)).join(', ') || '—';
      const failCell = (Number(u.fail) || 0) > 0
        ? `<span style="color:#b3261e">⚠ ${u.fail} failed</span>`
        : `<span style="color:#3a7c3a">0 failed</span>`;
      return `<tr>
        <td style="${cell}"><strong>${esc(label)}</strong></td>
        <td style="${cell}">${u.orgs} tenant${u.orgs === 1 ? '' : 's'}</td>
        <td style="${cell}">${u.success} success</td>
        <td style="${cell}">${failCell}</td>
        <td style="${cell}">${who}</td>
      </tr>`;
    }).join('');

    const untouchedHtml = untouched.length
      ? `<p style="font-size:14px;margin:14px 0 0"><strong>Not used at all this week:</strong> ${untouched.map((k) => esc(INSTRUMENTED_FEATURES[k])).join(' · ')}</p>`
      : `<p style="font-size:14px;margin:14px 0 0;color:#3a7c3a">Every tracked feature saw some use. 🎉</p>`;

    const rec = f.recent ?? {}; const at = f.all_time ?? {};
    const funnelHtml = `<h3 style="color:#1C004F;margin:22px 0 6px">Enrollment funnel</h3>
      <p style="font-size:14px;margin:0">Last ${days}d: <strong>${rec.initiated ?? 0}</strong> started checkout → <strong>${rec.paid ?? 0}</strong> paid.
      All-time (tracked): ${at.initiated ?? 0} started, ${at.paid ?? 0} paid, ${at.abandoned ?? 0} abandoned, ${at.payment_failed ?? 0} payment failures.</p>`;

    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:640px">
      <h2 style="color:#1C004F;margin:0 0 4px">Platform intelligence — last ${days} days</h2>
      <p style="color:#6b6b6b;margin:0 0 14px;font-size:13px">What operators used across Enrops, where it worked, and what went untouched. (Captured server-side in your database.)</p>
      <h3 style="color:#1C004F;margin:8px 0 6px">Feature usage</h3>
      ${usageHtml
        ? `<table style="border-collapse:collapse;width:100%;font-size:14px">
            <tr style="text-align:left;color:#6b6b6b;font-size:11px;text-transform:uppercase">
              <th style="padding:8px 12px">Feature</th><th style="padding:8px 12px">Reach</th><th style="padding:8px 12px">Worked</th><th style="padding:8px 12px">Failed</th><th style="padding:8px 12px">Who</th>
            </tr>${usageHtml}</table>`
        : `<p style="font-size:14px">No tracked-feature usage in this window yet — this fills in as operators work in the app.</p>`}
      ${untouchedHtml}
      ${funnelHtml}
      <p style="margin-top:18px;font-size:12px;color:#6b6b6b">Usage = server-side platform_events (edge-fn logs + DB triggers). Untouched features are candidates for onboarding nudges.</p>
    </div>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: DIGEST_EMAIL,
        subject: `Enrops platform intelligence — ${trackedUsed.length} feature${trackedUsed.length === 1 ? '' : 's'} used, ${untouched.length} untouched`,
        html,
      }),
    });
    return json({ events: totalTrackedEvents, features_used: trackedUsed.length, untouched: untouched.length, emailed: r.ok }, 200);
  } catch (e) {
    console.error('platform-intelligence-digest error:', String(e));
    return json({ error: 'Unexpected', detail: String(e) }, 500);
  }
});
