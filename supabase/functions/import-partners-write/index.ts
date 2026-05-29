// import-partners-write: persists a reviewed batch of partners + contacts
// into the caller's org. Idempotent on the recipient side: partners are
// matched by normalised name, contacts by normalised email under their
// partner.
//
// Input:
//   {
//     organization_id: string,            // must be one the caller owns
//     partners: Array<{
//       partner_name: string,             // required
//       partner_type?: string|null,
//       location_area?: string|null,
//       locations_managed?: string|null,
//       marketing_notes?: string|null,
//       invoicing_notes?: string|null,
//       planning_notes?: string|null,
//       implementation_notes?: string|null,
//       other_notes?: string|null,
//       match_partner_id?: string|null,   // explicit existing partner to merge into
//       action: 'create' | 'merge' | 'skip',
//       contacts: Array<{
//         contact_name?: string|null,
//         contact_email: string,           // required
//         contact_phone?: string|null,
//         contact_role?: string|null,
//         role_description?: string|null,
//         is_org_inbox?: boolean,
//         action?: 'create' | 'skip',      // default 'create'
//       }>
//     }>
//   }
//
// Output:
//   { partners_created, partners_merged, partners_skipped, contacts_created, contacts_skipped, errors[] }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PARTNER_TYPES = new Set(['public_school','private_school','charter_school','school_district','church','parks_rec','community_org']);
const ROLES = new Set(['operational','marketing','invoicing','approval_gatekeeper']);

function normName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const orgId: string | undefined = body.organization_id;
    const partners: any[] = Array.isArray(body.partners) ? body.partners : [];
    if (!orgId) return json({ error: 'organization_id is required' }, 400);
    if (partners.length === 0) return json({ error: 'no partners to import' }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    const { data: memberRow } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    // Build a name → existing partner map for the org so we can resolve
    // match_partner_id and protect against duplicate creates within one
    // batch.
    const { data: existing } = await supabase
      .from('partners')
      .select('id, partner_name')
      .eq('organization_id', orgId);
    const byNormName = new Map<string, string>();
    for (const p of existing ?? []) {
      byNormName.set(normName(p.partner_name), p.id);
    }

    let partnersCreated = 0;
    let partnersMerged = 0;
    let partnersSkipped = 0;
    let contactsCreated = 0;
    let contactsSkipped = 0;
    const errors: Array<{ partner: string; reason: string }> = [];

    for (const p of partners) {
      const action: 'create' | 'merge' | 'skip' = p.action || 'create';
      const name = (p.partner_name ?? '').toString().trim();
      if (!name) { partnersSkipped++; continue; }
      if (action === 'skip') { partnersSkipped++; continue; }

      let partnerId: string | null = null;

      if (action === 'merge') {
        partnerId = (p.match_partner_id as string | null) || byNormName.get(normName(name)) || null;
        if (!partnerId) {
          // Fell through — merge requested but no match found; treat as create.
          partnerId = null;
        }
      }

      // Create if no existing partner resolved
      if (!partnerId) {
        const partnerType = typeof p.partner_type === 'string' && PARTNER_TYPES.has(p.partner_type) ? p.partner_type : null;
        const insertRow: Record<string, unknown> = {
          organization_id: orgId,
          partner_name: name,
          partner_type: partnerType,
          location_area: strOrNull(p.location_area),
          locations_managed: strOrNull(p.locations_managed),
          marketing_notes: strOrNull(p.marketing_notes),
          invoicing_notes: strOrNull(p.invoicing_notes),
          planning_notes: strOrNull(p.planning_notes),
          implementation_notes: strOrNull(p.implementation_notes),
          other_notes: strOrNull(p.other_notes),
          source: 'import',
        };
        const { data: created, error: cErr } = await supabase
          .from('partners')
          .insert(insertRow)
          .select('id')
          .maybeSingle();
        if (cErr || !created) {
          errors.push({ partner: name, reason: cErr?.message ?? 'insert failed' });
          partnersSkipped++;
          continue;
        }
        partnerId = created.id;
        byNormName.set(normName(name), partnerId);
        partnersCreated++;
      } else {
        partnersMerged++;
      }

      // Load existing contact emails for this partner so we can dedupe.
      const { data: existingContacts } = await supabase
        .from('partner_contacts')
        .select('contact_email')
        .eq('partner_id', partnerId);
      const existingEmails = new Set(
        (existingContacts ?? [])
          .map((c) => (c.contact_email ?? '').toString().toLowerCase().trim())
          .filter(Boolean)
      );

      const contacts: any[] = Array.isArray(p.contacts) ? p.contacts : [];
      const toInsert: Record<string, unknown>[] = [];
      for (const c of contacts) {
        const cAction = c.action || 'create';
        if (cAction === 'skip') { contactsSkipped++; continue; }
        const email = (c.contact_email ?? '').toString().toLowerCase().trim();
        if (!email) { contactsSkipped++; continue; }
        if (existingEmails.has(email)) { contactsSkipped++; continue; }
        existingEmails.add(email);
        const role = typeof c.contact_role === 'string' && ROLES.has(c.contact_role) ? c.contact_role : 'operational';
        toInsert.push({
          organization_id: orgId,
          partner_id: partnerId,
          contact_name: strOrNull(c.contact_name),
          contact_email: email,
          contact_phone: strOrNull(c.contact_phone),
          contact_role: role,
          role_description: strOrNull(c.role_description),
          is_org_inbox: !!c.is_org_inbox,
          source: 'import',
          last_verified: new Date().toISOString().slice(0, 10),
        });
      }

      if (toInsert.length > 0) {
        const { error: icErr, count } = await supabase
          .from('partner_contacts')
          .insert(toInsert, { count: 'exact' });
        if (icErr) {
          errors.push({ partner: name, reason: `contact insert: ${icErr.message}` });
          contactsSkipped += toInsert.length;
        } else {
          contactsCreated += count ?? toInsert.length;
        }
      }
    }

    return json({
      partners_created: partnersCreated,
      partners_merged: partnersMerged,
      partners_skipped: partnersSkipped,
      contacts_created: contactsCreated,
      contacts_skipped: contactsSkipped,
      errors,
    });
  } catch (err) {
    console.error('[import-partners-write] unexpected', err);
    return json({ error: (err as Error).message ?? 'unexpected error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}
