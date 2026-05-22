// link-instructor: links the signed-in auth user to a matching instructor row.
// Called by the Instructor Portal on first load after magic-link auth.
//
// - Verifies the caller's session
// - Looks up the instructor row by email (case-insensitive, organization-agnostic
//   because instructors.email is globally unique enough for J2S; multi-tenant
//   we'd disambiguate via the org-slug in the URL)
// - If found and auth_user_id is null, sets it to the caller's auth user id
// - Returns { instructor_id, organization_id } or { error }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    const email = userData.user.email;
    if (!email) return json({ error: 'no email on auth user' }, 400);

    const { data: instructor, error: lookupErr } = await supabase
      .from('instructors')
      .select('id, organization_id, auth_user_id, first_name, last_name, preferred_name, email, is_active')
      .ilike('email', email)
      .eq('is_active', true)
      .maybeSingle();
    if (lookupErr) return json({ error: lookupErr.message }, 500);
    if (!instructor) return json({ error: 'no instructor record for this email' }, 404);

    if (!instructor.auth_user_id) {
      const { error: linkErr } = await supabase
        .from('instructors')
        .update({ auth_user_id: userData.user.id })
        .eq('id', instructor.id);
      if (linkErr) return json({ error: `link failed: ${linkErr.message}` }, 500);
    } else if (instructor.auth_user_id !== userData.user.id) {
      return json({ error: 'instructor is already linked to a different account' }, 409);
    }

    return json({
      instructor_id: instructor.id,
      organization_id: instructor.organization_id,
      first_name: instructor.first_name,
      last_name: instructor.last_name,
      preferred_name: instructor.preferred_name,
    });
  } catch (err: any) {
    console.error('link-instructor fatal:', err);
    return json({ error: err.message ?? String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
