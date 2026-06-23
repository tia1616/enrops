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
//   { partners_created, partners_merged, partners_skipped, contacts_created,
//     contacts_skipped, locations_created, locations_linked,
//     partners_without_location[], errors[] }
//
// Location linkage: a venue-type partner (school / community org) auto-creates
// or links a 1:1 program_location. Umbrella partners (district / Parks & Rec)
// never auto-create one — they're returned in partners_without_location so the
// UI can invite the operator to add their real venues.

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

// Partner types that ARE a single physical venue → a school/community org maps
// 1:1 to a program_location. Umbrella types (a district, a Parks & Rec dept)
// manage MANY venues, so importing them must NOT auto-create a location — their
// real venues are added separately, and the operator is prompted about them.
const VENUE_TYPES = new Set(['public_school','private_school','charter_school','community_org']);

function normName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// School-name normalization for the location-matching path: strip suffixes
// that vary between partner-side and location-side ("Ainsworth Elementary"
// partner ↔ "Ainsworth" location). Conservative: only strip well-known
// suffix words; if stripping empties the string, fall back to normName.
function normSchoolName(s: string | null | undefined): string {
  let n = normName(s);
  if (!n) return n;
  // Order matters — strip longer phrases first so "elementary school"
  // doesn't leave a dangling "school".
  const suffixes = [
    'elementary school', 'middle school', 'high school', 'charter school',
    'summer camp',
    'elementary', 'academy', 'school', 'church',
    'sun', 'k 8', 'k 12', 'k8', 'k12', 'pre k', 'prek',
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const sfx of suffixes) {
      if (n === sfx) break;
      if (n.endsWith(' ' + sfx)) {
        n = n.slice(0, -sfx.length - 1).trim();
        changed = true;
        break;
      }
    }
  }
  return n || normName(s);
}

// Mirror the client-side venue-add slug rule (LocationsList.jsx): slug is
// NOT NULL + globally UNIQUE, so derive from the name + a short random suffix.
function makeSlug(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'venue';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
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
      .select('id, partner_name, partner_type')
      .eq('organization_id', orgId);
    const byNormName = new Map<string, string>();
    // Track existing partner_type by partner_id so a merge whose payload type
    // is null can fall back to whatever's already saved on the partner.
    const existingTypeById = new Map<string, string | null>();
    for (const p of existing ?? []) {
      byNormName.set(normName(p.partner_name), p.id);
      existingTypeById.set(p.id, (p.partner_type as string | null) ?? null);
    }

    // Build a normalized-name → location index for the org so a venue partner
    // can be linked to an existing location (by name OR a recorded alias)
    // instead of creating a duplicate. Conservative: exact normalized match
    // only — anything that doesn't match is surfaced to the operator, never
    // silently linked to the wrong school.
    const { data: existingLocs } = await supabase
      .from('program_locations')
      .select('id, name, name_aliases, partner_id')
      .eq('organization_id', orgId);
    const locByNorm = new Map<string, { id: string; partner_id: string | null }>();
    // Secondary index for suffix-stripped matching ("ainsworth" → row whose
    // name was "Ainsworth Elementary"). Stores arrays so we can detect
    // ambiguity — if more than one location shares the same stripped form,
    // we refuse to auto-link to avoid picking the wrong school.
    const locsBySchool = new Map<string, Array<{ id: string; partner_id: string | null }>>();
    for (const l of existingLocs ?? []) {
      const entry = { id: l.id as string, partner_id: (l.partner_id as string | null) ?? null };
      locByNorm.set(normName(l.name), entry);
      for (const a of (l.name_aliases as string[] | null) ?? []) {
        const k = normName(a);
        if (k) locByNorm.set(k, entry);
      }
      const sk = normSchoolName(l.name);
      if (sk) {
        const arr = locsBySchool.get(sk) ?? [];
        arr.push(entry);
        locsBySchool.set(sk, arr);
      }
    }

    let partnersCreated = 0;
    let partnersMerged = 0;
    let partnersSkipped = 0;
    let contactsCreated = 0;
    let contactsSkipped = 0;
    let locationsCreated = 0;
    let locationsLinked = 0;
    // Umbrella partners (district / Parks & Rec) imported this batch — the UI
    // asks the operator whether to add a venue for each.
    const partnersWithoutLocation: Array<{ partner_id: string; partner_name: string; partner_type: string | null }> = [];
    // Every venue location touched this run, so the UI can offer per-row
    // "Edit details" links (arrival instructions, food policy, etc).
    const touchedLocations: Array<{ location_id: string; location_name: string; was_created: boolean }> = [];
    const errors: Array<{ partner: string; reason: string }> = [];

    for (const p of partners) {
      const action: 'create' | 'merge' | 'skip' = p.action || 'create';
      const name = (p.partner_name ?? '').toString().trim();
      if (!name) { partnersSkipped++; continue; }
      if (action === 'skip') { partnersSkipped++; continue; }

      let ptype: string | null = typeof p.partner_type === 'string' && PARTNER_TYPES.has(p.partner_type) ? p.partner_type : null;

      let partnerId: string | null = null;

      if (action === 'merge') {
        partnerId = (p.match_partner_id as string | null) || byNormName.get(normName(name)) || null;
        // Fall back to the existing partner's saved type when the import
        // didn't carry one (common when partner-level data lives on a
        // different sheet than contacts — Contacts-sheet rows have no
        // partner_type column). Required for the venue auto-link check.
        if (partnerId && !ptype) {
          const saved = existingTypeById.get(partnerId);
          if (saved && PARTNER_TYPES.has(saved)) ptype = saved;
        }
      }

      // Create if no existing partner resolved
      if (!partnerId) {
        const insertRow: Record<string, unknown> = {
          organization_id: orgId,
          partner_name: name,
          partner_type: ptype,
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

      // ── Location linkage ──────────────────────────────────────────────
      // A single-venue partner (school, community org) maps 1:1 to a
      // program_location. Umbrella partners (district, Parks & Rec) manage
      // many venues, so we never auto-create one — we surface them so the
      // operator can add their real venues by hand.
      //
      // link_existing_location_id: when the caller is reconciling an EXISTING
      // orphan venue (the "Needs linking" surface creating a new partner from
      // a venue), link THAT venue to the new partner instead of name-matching
      // or creating a duplicate. Works for any partner type.
      const linkExistingId = strOrNull(p.link_existing_location_id);
      if (linkExistingId) {
        const { error: linkErr } = await supabase
          .from('program_locations')
          .update({ partner_id: partnerId })
          .eq('id', linkExistingId)
          .eq('organization_id', orgId)
          .is('partner_id', null);
        if (linkErr) {
          errors.push({ partner: name, reason: `location link: ${linkErr.message}` });
        } else {
          locationsLinked++;
          touchedLocations.push({ location_id: linkExistingId, location_name: name, was_created: false });
        }
      } else if (VENUE_TYPES.has(ptype ?? '')) {
        // Pull optional location fields off the payload — written on create,
        // only fill blanks on link-existing (never overwrite operator data).
        const locAddress = strOrNull(p.location_address);
        const locRoom = strOrNull(p.location_room_number);
        const locDistrict = strOrNull(p.location_district);
        // Primary lookup: exact-name match (existing behavior).
        // Fallback: suffix-stripped match — but ONLY when exactly one location
        // matches, so "Ainsworth Elementary" partner finds the "Ainsworth"
        // location without accidentally clobbering a same-stem sibling.
        let existingLoc = locByNorm.get(normName(name));
        if (!existingLoc) {
          const candidates = locsBySchool.get(normSchoolName(name)) ?? [];
          if (candidates.length === 1) existingLoc = candidates[0];
        }
        if (existingLoc) {
          if (!existingLoc.partner_id) {
            // Existing location is unclaimed → link it AND fill any blanks.
            const patch: Record<string, unknown> = { partner_id: partnerId };
            // Read the full row so we know which fields are blank.
            const { data: currentLoc } = await supabase
              .from('program_locations').select('address, room_number, district')
              .eq('id', existingLoc.id).maybeSingle();
            if (locAddress && !(currentLoc?.address)) patch.address = locAddress;
            if (locRoom && !(currentLoc?.room_number)) patch.room_number = locRoom;
            if (locDistrict && !(currentLoc?.district)) patch.district = locDistrict;
            const { error: linkErr } = await supabase
              .from('program_locations').update(patch).eq('id', existingLoc.id).is('partner_id', null);
            if (linkErr) {
              errors.push({ partner: name, reason: `location link: ${linkErr.message}` });
            } else {
              existingLoc.partner_id = partnerId;
              locationsLinked++;
              touchedLocations.push({ location_id: existingLoc.id, location_name: name, was_created: false });
            }
          } else if (existingLoc.partner_id !== partnerId) {
            // Same-named location is claimed by another partner → surface, don't overwrite.
            partnersWithoutLocation.push({ partner_id: partnerId, partner_name: name, partner_type: ptype });
          } else {
            // Already correctly linked to THIS partner. Still fill any blank
            // address/room/district fields from the import (never overwrite
            // existing values) so address/room/district from a spreadsheet
            // actually persist for partners that were already linked.
            const patch: Record<string, unknown> = {};
            if (locAddress || locRoom || locDistrict) {
              const { data: currentLoc } = await supabase
                .from('program_locations').select('address, room_number, district')
                .eq('id', existingLoc.id).maybeSingle();
              if (locAddress && !(currentLoc?.address)) patch.address = locAddress;
              if (locRoom && !(currentLoc?.room_number)) patch.room_number = locRoom;
              if (locDistrict && !(currentLoc?.district)) patch.district = locDistrict;
            }
            if (Object.keys(patch).length > 0) {
              const { error: fillErr } = await supabase
                .from('program_locations').update(patch).eq('id', existingLoc.id);
              if (fillErr) errors.push({ partner: name, reason: `location fill: ${fillErr.message}` });
            }
            touchedLocations.push({ location_id: existingLoc.id, location_name: name, was_created: false });
          }
        } else {
          // No matching location → create with whatever location fields were on the row.
          const insertLoc: Record<string, unknown> = {
            organization_id: orgId, name, slug: makeSlug(name), partner_id: partnerId,
          };
          if (locAddress) insertLoc.address = locAddress;
          if (locRoom) insertLoc.room_number = locRoom;
          if (locDistrict) insertLoc.district = locDistrict;
          const { data: newLoc, error: locErr } = await supabase
            .from('program_locations').insert(insertLoc).select('id').maybeSingle();
          if (locErr || !newLoc) {
            errors.push({ partner: name, reason: `location create: ${locErr?.message ?? 'insert failed'}` });
          } else {
            const newEntry = { id: newLoc.id as string, partner_id: partnerId };
            locByNorm.set(normName(name), newEntry);
            const sk = normSchoolName(name);
            if (sk) {
              const arr = locsBySchool.get(sk) ?? [];
              arr.push(newEntry);
              locsBySchool.set(sk, arr);
            }
            locationsCreated++;
            touchedLocations.push({ location_id: newLoc.id, location_name: name, was_created: true });
          }
        }
      } else if (ptype === 'school_district' || ptype === 'parks_rec') {
        partnersWithoutLocation.push({ partner_id: partnerId, partner_name: name, partner_type: ptype });
      }
    }

    return json({
      partners_created: partnersCreated,
      partners_merged: partnersMerged,
      partners_skipped: partnersSkipped,
      contacts_created: contactsCreated,
      contacts_skipped: contactsSkipped,
      locations_created: locationsCreated,
      locations_linked: locationsLinked,
      partners_without_location: partnersWithoutLocation,
      touched_locations: touchedLocations,
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
