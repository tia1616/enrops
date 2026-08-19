// waitlist-accept — resolve an invite token for the accept page.
//
// Public (verify_jwt = false), because an invited family has no account: the whole point
// of the token is that it stands in for one. It holds the service role, so it re-resolves
// everything server-side and returns exactly one registration's prefill or nothing.
//
// READ ONLY. It does not spend the invite, move the family, or take money. Spending
// happens in create-registration, after a real registration exists - so a family who
// opens the link, reads it and closes the tab keeps their place.
//
// WHAT IT DELIBERATELY DOES NOT DO: distinguish "expired" from "never existed" in the
// response. waitlist_invite_lookup returns nothing for unknown, expired, spent and
// cancelled alike, and this passes that silence through as one `valid: false`. A
// response that said "expired" would confirm a guessed token had once been real.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    // String(...) before trim: a number or object would resolve .trim to undefined and
    // throw, turning a malformed URL into a 500. Same shape join-waitlist was corrected to.
    const token = String(body?.token ?? '').trim();
    if (!token) return json({ valid: false });

    const { data, error } = await admin.rpc('waitlist_invite_lookup', { p_token: token });
    if (error) {
      console.error('[waitlist-accept] lookup failed', error.message);
      // An outage is NOT an invalid token. Saying valid:false here would tell a family
      // with a perfectly good invite that it had expired, and they would stop trying.
      return json({ error: 'We could not check that invitation just now. Please try again.' }, 503);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return json({ valid: false });

    return json({
      valid: true,
      program_id: row.program_id,
      org_slug: row.org_slug,
      expires_at: row.expires_at,
      program_name: row.program_name,
      site_name: row.site_name,
      child: {
        first_name: row.child_first_name,
        last_name: row.child_last_name,
        grade: row.child_grade,
      },
      parent: {
        first_name: row.parent_first_name,
        last_name: row.parent_last_name,
        email: row.parent_email,
        phone: row.parent_phone,
      },
    });
  } catch (err) {
    console.error('waitlist-accept error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
