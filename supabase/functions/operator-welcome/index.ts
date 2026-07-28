// operator-welcome - the Day 1 letter, sent to a provider once they finish setup.
//
// Spec: "enrops Founder Notifications" (2026-07-27), section 4. The spec asked to
// embed the founder's welcome video "into the existing Day 1 first-run letter".
// There is no Day 1 letter: the only thing a new provider receives today is their
// sign-in link, and the product's "first-run" thing is an in-app card. So this is
// that letter.
//
// FIRES on onboarding_completed_at, not at signup. At signup the only fact we hold
// is an email address, so the letter could not say anything real. By the time
// onboarding completes we know the business name.
//
// ONCE, EVER: the send is CLAIMED with a conditional update on
// organizations.welcome_email_sent_at. Same lesson as founder-notify: marking sent
// after the send lets a dropped write turn one email into a retry loop.
//
// AUTH: verify_jwt = false. pg_net calls with the Vault secret operator_welcome_secret.
//
// ASSETS: the video and poster are read from this environment's own public storage
// bucket, derived from SUPABASE_URL. No extra configuration, and staging cannot
// accidentally serve prod's file.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
import { esc } from '../founder-notify/lib.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const PUBLIC_SITE_URL = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com';
// Who signs the letter. Config, not code: the video is the founder's and the
// signature has to match whoever is speaking in it. Falls back to the platform
// sender name rather than guessing a person.
const WELCOME_SIGNATURE_NAME = (Deno.env.get('WELCOME_SIGNATURE_NAME') ?? '').trim();

// Per-environment, derived rather than configured.
const ASSET_BASE = `${SUPABASE_URL}/storage/v1/object/public/public-assets/welcome`;
const VIDEO_URL = `${ASSET_BASE}/welcome-720.mp4`;
const POSTER_URL = `${ASSET_BASE}/welcome-poster.jpg`;

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: expected } = await supabase.rpc('app_secret', { p_name: 'operator_welcome_secret' });
    const auth = req.headers.get('Authorization') ?? '';
    if (!expected || auth !== `Bearer ${expected}`) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const orgId: string | undefined = body?.organization_id;
    if (!orgId) return json({ error: 'organization_id required' }, 400);
    const preview = body?.preview === true;

    const { data: org } = await supabase
      .from('organizations')
      .select('id, slug, name, email, alert_email, is_internal, onboarding_completed_at, welcome_email_sent_at')
      .eq('id', orgId)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);

    if (!preview) {
      if (org.is_internal) return json({ ok: true, skipped: 'internal_org' }, 200);
      if (!org.onboarding_completed_at) return json({ ok: true, skipped: 'not_onboarded' }, 200);
      if (org.welcome_email_sent_at) return json({ ok: true, skipped: 'already_sent' }, 200);
    }

    // Recipient: the provider's own address. alert_email is guaranteed populated by
    // 20260728d (backfill + triggers), with organizations.email as the belt-and-braces
    // fallback. Never the platform's inbox.
    const to = org.alert_email || org.email || null;
    if (!preview && !to) {
      console.error('[operator-welcome] no recipient address for org', org.id);
      return json({ error: 'no recipient' }, 500);
    }

    const businessName = (org.name ?? '').trim();
    const buildUrl = `${PUBLIC_SITE_URL}/admin/programs/quick-new`;

    // Resolve the signature before rendering. loadOrgBrand is needed for the sender
    // anyway, so this costs nothing extra.
    const brand = await loadOrgBrand(supabase, null); // sends AS enrops, not as the tenant
    const signature = WELCOME_SIGNATURE_NAME || brand.sender_name;

    const subject = 'you\'re all set';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">a 70-second hello, and the one thing worth doing next</div>
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="padding:32px 32px 8px;">
    <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a;">Hi there,</p>
    <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      ${esc(businessName)} is set up on enrops. The fiddly part is done.
    </p>
    <p style="margin:0 0 24px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      I recorded something for you. It's about a minute, and I'll be straight with you:
      it's the same video every new provider gets. I'd rather record one real thing than
      pretend I made it just for you.
    </p>
  </div>

  <!-- Video. Apple Mail and iOS play this inline; Gmail, Outlook and the rest ignore
       the <video> tag and fall through to the poster, which is a normal linked image.
       Either way the reader sees a face and a play button, and clicking always works. -->
  <div style="padding:0 32px;">
    <a href="${esc(VIDEO_URL)}" style="text-decoration:none;display:block;">
      <video width="100%" poster="${esc(POSTER_URL)}" controls preload="none"
             style="width:100%;border-radius:8px;display:block;">
        <source src="${esc(VIDEO_URL)}" type="video/mp4">
        <img src="${esc(POSTER_URL)}" width="100%" alt="A short hello from enrops"
             style="width:100%;border-radius:8px;display:block;">
      </video>
    </a>
  </div>

  <div style="padding:24px 32px 32px;">
    <h2 style="margin:24px 0 8px;font-size:17px;color:#1C004F;">The one thing worth doing next</h2>
    <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      Build one program and publish it. Not your whole term. Just one.
    </p>
    <p style="margin:0 0 20px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      That gives you a registration link you can send to families today, while they are
      still deciding what their fall looks like. And the demand is real: in the
      Afterschool Alliance's 2025 America After 3PM study, 58% of elementary schoolers
      not in an after-school program would be enrolled by their parents if one were
      available. Unmet demand is higher for elementary than for any other grade level.
    </p>
    <div style="margin:0 0 28px;">
      <a href="${esc(buildUrl)}" style="display:inline-block;background:#8C88FF;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600;">Build your first program</a>
    </div>

    <h2 style="margin:0 0 8px;font-size:17px;color:#1C004F;">If now isn't the moment</h2>
    <p style="margin:0 0 24px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      Nothing here expires and nothing gets deleted. Your setup stays exactly where you
      left it, and it will still be here when your term is planned.
    </p>

    <h2 style="margin:0 0 8px;font-size:17px;color:#1C004F;">Something I'd genuinely like to know</h2>
    <p style="margin:0 0 24px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      What made you go looking for something like enrops? Hit reply. It comes straight to me.
    </p>

    <p style="margin:0 0 24px;font-size:16px;color:#1a1a1a;">${esc(signature)}</p>

    <p style="margin:0;padding-top:20px;border-top:1px solid #eee;font-size:13px;color:#666;line-height:1.6;">
      Free to start. We earn when you earn. You will not see a bill from us before you
      have taken a payment.
    </p>
  </div>
</div>
</body></html>`;

    if (preview) return json({ subject, html, to, video: VIDEO_URL, poster: POSTER_URL }, 200);

    // CLAIM BEFORE SENDING. Same reasoning as founder-notify: if the "sent" write is
    // done afterwards and fails, the retry sweep re-sends. Zero rows updated means
    // another dispatch already owns this send.
    const { data: claimed, error: claimErr } = await supabase
      .from('organizations')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', org.id)
      .is('welcome_email_sent_at', null)
      .select('id');

    if (claimErr) {
      console.error('[operator-welcome] could not claim send:', claimErr.message);
      return json({ error: 'claim failed' }, 500);
    }
    if (!claimed?.length) return json({ ok: true, skipped: 'already_claimed' }, 200);

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: formatFromAddress(brand),
        to: [to],
        reply_to: brand.reply_to,
        subject,
        html,
        tags: [{ name: 'type', value: 'operator_welcome' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[operator-welcome] Resend failed:', resp.status, errText);
      // Release the claim so the sweep can retry.
      const { error: releaseErr } = await supabase
        .from('organizations')
        .update({ welcome_email_sent_at: null })
        .eq('id', org.id);
      if (releaseErr) {
        console.error('[operator-welcome] STUCK: claimed but not sent, release failed for',
          org.id, releaseErr.message);
      }
      return json({ error: 'send failed' }, 502);
    }

    return json({ ok: true, sent_to: to }, 200);
  } catch (e) {
    console.error('[operator-welcome] error:', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
