// tenant-sender — preview + test the org's outgoing email identity.
//
// The provider sets their sender display name + reply-to in Settings; the actual
// FROM address is derived server-side by orgBrand (a per-tenant address on the
// verified platform domain, or the tenant's own verified domain). This function
// is the single source of truth the UI reads, so the preview always matches what
// real emails will use.
//
// AUTH: caller must be owner/admin of organization_id.
// INPUT:  { organization_id, action: 'preview' | 'test', to? }
// OUTPUT: preview -> { from, sender_name, sender_email, reply_to, sender_source, org_name }
//         test    -> { sent, held_back?, to, from, error? }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress, renderSignatureBlock } from '../_shared/orgBrand.ts';
import { isEmailAllowed, emailGuardActive } from '../_shared/emailGuard.ts';

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

/** Escape a string for safe display in HTML text content. */
function escHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    const action: string = body.action ?? 'preview';
    if (!organizationId) return json({ error: 'organization_id required' }, 400);

    // ----- Auth: caller must be owner/admin of this org -----
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);
    const { data: memberRow } = await admin
      .from('org_members').select('role')
      .eq('auth_user_id', userData.user.id).eq('organization_id', organizationId).maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) return json({ error: 'forbidden' }, 403);

    const brand = await loadOrgBrand(admin, organizationId);
    const from = formatFromAddress(brand);

    if (action === 'preview') {
      // sender_name/sender_email are the SAME values `from` is built from,
      // returned split so a caller that renders the two parts separately (the
      // campaign review screen) doesn't have to parse the header back apart —
      // or, as it did before, rebuild them from the raw org columns and
      // disagree with what actually sends.
      return json({
        from,
        sender_name: brand.sender_name,
        sender_email: brand.sender_email,
        reply_to: brand.reply_to,
        sender_source: brand.sender_source,
        // The reply-to half of what sender_source already did for the FROM half.
        // Without it this endpoint handed the screen a bare address, the screen
        // printed it under "Replies go to", and an address the operator never
        // chose was indistinguishable from one they did. Three values, not two:
        // see the OrgBrand field comment for why 'org_email' has to be its own
        // state rather than counting as configured.
        reply_to_source: brand.reply_to_source,
        org_name: brand.org_name,
      });
    }

    if (action === 'test') {
      const to = String(body.to ?? userData.user.email ?? '').trim();
      if (!to) return json({ error: 'No recipient address.' }, 400);
      // Staging recipient guard: never send a test to a non-allowlisted inbox.
      if (emailGuardActive() && !isEmailAllowed(to)) {
        return json({ sent: false, held_back: true, to, from });
      }
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from,
          to,
          reply_to: brand.reply_to,
          subject: `Test email from ${brand.org_name}`,
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.6;max-width:600px;margin:0 auto;">
            ${brand.logo_url ? `<div style="text-align:center;padding:4px 0 18px;"><img src="${String(brand.logo_url).replace(/"/g, "&quot;")}" alt="${String(brand.org_name).replace(/[<>"]/g, "")}" style="max-height:56px;max-width:220px;height:auto;" /></div>` : ""}
            <p>This is a test email from <strong>${escHtml(brand.org_name)}</strong>, sent through Enrops.</p>
            <p>If it landed in your inbox, your sender is working. It was sent from <strong>${escHtml(brand.sender_name)}</strong> (${escHtml(brand.sender_email)}), and replies go to <strong>${escHtml(brand.reply_to)}</strong>.</p>
            ${brand.reply_to_source === 'platform' ? `<p style="background:#fff7ed;border-left:3px solid #c2410c;padding:10px 12px;color:#7c2d12;"><strong>Replies are not reaching you.</strong> You haven't set a reply-to email, so a family who hits reply on any of your emails reaches Enrops instead of you. Add your own address under Settings &rarr; Email sender.</p>` : ''}
            ${brand.reply_to_source === 'org_email' ? `<p style="background:#f5f3ff;border-left:3px solid #5847c9;padding:10px 12px;color:#1a1530;">That reply-to is your account email, because you haven't set one specifically for families. Replies do reach you. If you'd rather they went somewhere else, set it under Settings &rarr; Email sender.</p>` : ''}
            ${renderSignatureBlock(brand)}
          </div>`,
          tags: [{ name: 'type', value: 'sender_test' }],
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return json({ sent: false, to, from, error: errText.slice(0, 240) });
      }
      return json({ sent: true, to, from });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || 'Internal error' }, 500);
  }
});
