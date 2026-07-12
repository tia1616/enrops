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
// OUTPUT: preview -> { from, reply_to, sender_source, org_name }
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
      return json({ from, reply_to: brand.reply_to, sender_source: brand.sender_source, org_name: brand.org_name });
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
