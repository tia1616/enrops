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
import { esc } from '../_shared/escapeHtml.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const PUBLIC_SITE_URL = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com';
// The founder's own mailbox. Defined ONCE because it appears in two places that must
// never disagree: the visible signature, and the Reply-To header. The letter tells the
// reader "Save my email, I read my messages and respond personally", so a Reply-To
// pointing anywhere else would make that sentence untrue.
// Arielle's instruction, 2026-07-31: enrops mail reaches her at the enrops address,
// not the journeytosteam one.
const FOUNDER_REPLY_TO = (Deno.env.get('FOUNDER_REPLY_TO') ?? 'arielle@enrops.com').trim();

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

    const brand = await loadOrgBrand(supabase, null); // sends AS enrops, not as the tenant

    // COPY BELOW IS ARIELLE'S, APPROVED VERBATIM 2026-07-31.
    // She rewrote the whole letter in her own voice and signed off on it in the
    // review doc ("good to go for live prod site?" / "yep"). Do not reword it,
    // tighten it, or re-add anything she cut. If it needs to change, it changes
    // through her. Her standing note: she owns user-facing copy from here on.
    // Subject is Arielle's greeting rather than her original "read this super important
    // welcome email". Jessica's call, 2026-07-31: "super important" is a well-worn spam
    // trigger and this is the first email a new operator ever gets, so landing in
    // Promotions would cost more than the joke earns. Kept in her voice and her words.
    // Flagged back to Arielle since the copy is hers.
    const subject = 'hello my fellow enrops peep';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FBFBFB;font-family:'Poppins',system-ui,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">a quick hello, and the one thing worth doing next</div>
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;">
  <div style="padding:32px 32px 8px;">
    <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a;">Hello my fellow enrops peep!</p>
    <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      ${businessName
        ? `${esc(businessName)} is set up on enrops.`
        : `You're set up on enrops.`}
    </p>
    <p style="margin:0 0 24px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      I'm Arielle, the founder of enrops. As a fellow kids enrichment owner-operator, I
      know we have a lot on our plates, so I made a quick video to welcome you to the
      enrops community. It's about a minute long.
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
    <p style="margin:0 0 20px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      Here's what to do next: Build one program and publish it. I've timed it, and it
      takes less than five minutes. That gives you a registration link you can send to
      families today, while they are still deciding what their fall looks like. I've
      talked to hundreds of families over the years, and two of the leading factors in
      their decision to enroll in an enrichment program is how early they learn of the
      program, and how difficult it is to register. Our registration is the most
      mobile-friendly and parent-friendly on the market. See for yourself:
    </p>
    <div style="margin:0 0 28px;">
      <a href="${esc(buildUrl)}" style="display:inline-block;background:#8C88FF;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600;">Build your first program</a>
    </div>

    <p style="margin:0 0 24px;font-size:16px;color:#1a1a1a;line-height:1.6;">
      -Dr. Arielle Hammond, EdD<br>
      Founder, enrops<br>
      <a href="mailto:${esc(FOUNDER_REPLY_TO)}" style="color:#1C004F;">${esc(FOUNDER_REPLY_TO)}</a><br>
      tireless and relentless champion of kids enrichment business owners
    </p>

    <p style="margin:0;padding-top:20px;border-top:1px solid #eee;font-size:15px;color:#1a1a1a;line-height:1.6;">
      P.S. If you didn't watch the video, I'll reiterate it here. This can be a lonely
      business to run, but it doesn't have to be. You are part of my tribe, so reach out.
      Save my email, I read my messages and respond personally, in my own writing. I'd
      love to hear from you, whether it's to celebrate a win, walk through a challenge,
      provide ideas or feedback on enrops, or something else. Until next time, may you
      be well.
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

    // Bounded so a hung connection cannot pin the claim open indefinitely.
    let resp: Response;
    try {
      resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: formatFromAddress(brand),
          to: [to],
          // Replies go to the founder personally, matching what the letter promises.
          reply_to: FOUNDER_REPLY_TO,
          subject,
          html,
          tags: [{ name: 'type', value: 'operator_welcome' }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (netErr) {
      // TIMED OUT OR THE CONNECTION DIED. We do NOT know whether Resend accepted the
      // message, so the claim STAYS. Releasing here is what would double-send: a
      // request that timed out client-side is very often one the server processed.
      // A missed welcome is recoverable by hand; two copies of a founder's personal
      // letter is not.
      console.error('[operator-welcome] Resend request failed before a response:', (netErr as Error).message);
      await supabase.from('organizations')
        .update({ welcome_send_error: `no response: ${(netErr as Error).message}`.slice(0, 500) })
        .eq('id', org.id);
      return json({ error: 'send indeterminate, claim held' }, 502);
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[operator-welcome] Resend failed:', resp.status, errText);

      // RELEASE ONLY ON 4xx. A 4xx is Resend telling us it rejected the message, so
      // nothing was delivered and a retry is safe. A 5xx is ambiguous - Resend may
      // well have accepted and queued it before failing - so releasing the claim
      // would let the 15-minute sweep send a SECOND copy. Hold the claim, record the
      // error, and let a human decide.
      const rejected = resp.status >= 400 && resp.status < 500;
      const patch: Record<string, unknown> = {
        welcome_send_error: `${resp.status}: ${errText}`.slice(0, 500),
      };
      if (rejected) patch.welcome_email_sent_at = null;

      const { error: releaseErr } = await supabase
        .from('organizations').update(patch).eq('id', org.id);
      if (releaseErr) {
        console.error('[operator-welcome] STUCK: claimed but not sent, and the update failed for',
          org.id, releaseErr.message);
      }
      return json({ error: 'send failed', retriable: rejected }, 502);
    }

    return json({ ok: true, sent_to: to }, 200);
  } catch (e) {
    console.error('[operator-welcome] error:', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
