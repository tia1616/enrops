// admin-import-camp-roster — bulk upsert per-camper data for a camp_session.
//
// Called by /admin/rosters after the operator picks a CSV (or types
// registrants manually). Each registrant in the batch is normalized into
// parent + student + registration rows; idempotent via unique index on
// (camp_session_id, student_id).
//
// Body:
//   {
//     camp_session_id: string,
//     registrants: [
//       {
//         student_first_name: string,    // required
//         student_last_name?: string,
//         grade?: number|string,
//         birthdate?: string,            // YYYY-MM-DD
//         pronouns?: string,
//         allergies?: string,
//         dietary_restrictions?: string,
//         medical_notes?: string,
//         medical_conditions?: string,
//         epipen_required?: boolean|string,
//         medications_at_program?: string,
//         emergency_contact_name?: string,
//         emergency_contact_phone?: string,
//         special_needs_accommodations?: string,
//         photo_release_consent?: boolean|string,
//         authorized_pickup_contacts?: string,
//         notes?: string,
//         parent_first_name?: string,
//         parent_last_name?: string,
//         parent_email?: string,         // strongly recommended — matching key
//         parent_phone?: string,
//       }, ...
//     ]
//   }
//
// Auth: caller must be an org_members row with role owner/admin in the
// camp_session's organization.
//
// Per-row matching:
//   parent: by lower(email) when provided; else by (first_name, last_name, phone)
//   student: by (parent_id, lower(first_name), lower(last_name))
//   registration: by (camp_session_id, student_id) — upserted via unique index
//
// Returns: { imported, updated, skipped, errors: [{row_index, error}] }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

interface Registrant {
  student_first_name?: string;
  student_last_name?: string;
  grade?: number | string;
  birthdate?: string;
  pronouns?: string;
  allergies?: string;
  dietary_restrictions?: string;
  medical_notes?: string;
  medical_conditions?: string;
  epipen_required?: boolean | string;
  medications_at_program?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  special_needs_accommodations?: string;
  photo_release_consent?: boolean | string;
  authorized_pickup_contacts?: string;
  notes?: string;
  parent_first_name?: string;
  parent_last_name?: string;
  parent_email?: string;
  parent_phone?: string;
}

interface RequestBody {
  camp_session_id?: string;
  registrants?: Registrant[];
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // 1. Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // 2. Body
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const campSessionId = body.camp_session_id?.trim();
    const registrants = Array.isArray(body.registrants) ? body.registrants : null;
    if (!campSessionId) return json({ error: 'camp_session_id_required' }, 400);
    if (!registrants || registrants.length === 0) {
      return json({ error: 'registrants_required' }, 400);
    }
    if (registrants.length > 500) {
      return json({ error: 'too_many_rows', limit: 500 }, 413);
    }

    // 3. Resolve camp_session + verify caller authorized for that org
    const { data: campSession, error: csErr } = await supabase
      .from('camp_sessions')
      .select('id, organization_id, curriculum_name, starts_on')
      .eq('id', campSessionId)
      .maybeSingle();
    if (csErr) {
      console.error('camp_session lookup failed:', csErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!campSession) return FORBIDDEN;

    const { data: member, error: memErr } = await supabase
      .from('org_members')
      .select('organization_id')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', campSession.organization_id)
      .in('role', ['owner', 'admin'])
      .maybeSingle();
    if (memErr) {
      console.error('org_members lookup failed:', memErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!member) return FORBIDDEN;

    const orgId = campSession.organization_id;

    // 4. Process rows
    const results = {
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: [] as Array<{ row_index: number; error: string }>,
    };

    for (let i = 0; i < registrants.length; i++) {
      const r = registrants[i];
      try {
        const studentFirst = String(r.student_first_name ?? '').trim();
        if (!studentFirst) {
          results.skipped++;
          results.errors.push({ row_index: i, error: 'missing_student_first_name' });
          continue;
        }
        const studentLast = String(r.student_last_name ?? '').trim();

        // PARENT — match by email (lowercase) if present, else by name+phone.
        let parentId: string | null = null;
        const parentEmail = String(r.parent_email ?? '').trim().toLowerCase();
        const parentFirst = String(r.parent_first_name ?? '').trim();
        const parentLast = String(r.parent_last_name ?? '').trim();
        const parentPhone = String(r.parent_phone ?? '').trim();

        if (parentEmail) {
          const { data: existingParent } = await supabase
            .from('parents')
            .select('id')
            .ilike('email', parentEmail)
            .limit(1)
            .maybeSingle();
          if (existingParent) parentId = existingParent.id;
        }

        if (!parentId && parentFirst && parentLast) {
          let q = supabase
            .from('parents')
            .select('id')
            .ilike('first_name', parentFirst)
            .ilike('last_name', parentLast);
          if (parentPhone) q = q.eq('phone', parentPhone);
          const { data: parentByName } = await q.limit(1).maybeSingle();
          if (parentByName) parentId = parentByName.id;
        }

        if (!parentId) {
          // Create. parents.email is NOT NULL — fall back to a placeholder
          // when the operator didn't provide one (rare for Squarespace).
          const fallbackEmail = parentEmail
            || `${studentFirst.toLowerCase()}.${studentLast.toLowerCase() || 'unknown'}.${Date.now()}.${i}@import.local`;
          const { data: newParent, error: pErr } = await supabase
            .from('parents')
            .insert({
              first_name: parentFirst || studentFirst,
              last_name: parentLast || studentLast || 'Unknown',
              email: fallbackEmail,
              phone: parentPhone || null,
            })
            .select('id')
            .single();
          if (pErr) throw new Error(`parent_create_failed: ${pErr.message}`);
          parentId = newParent.id;
        }

        // STUDENT — match by (parent_id, first_name, last_name).
        let studentId: string | null = null;
        {
          const { data: existingStudent } = await supabase
            .from('students')
            .select('id')
            .eq('parent_id', parentId)
            .ilike('first_name', studentFirst)
            .ilike('last_name', studentLast || '')
            .limit(1)
            .maybeSingle();
          if (existingStudent) studentId = existingStudent.id;
        }

        const studentFields = {
          parent_id: parentId,
          organization_id: orgId,
          first_name: studentFirst,
          last_name: studentLast || null,
          grade: parseGrade(r.grade),
          birthdate: parseDate(r.birthdate),
          pronouns: emptyToNull(r.pronouns),
          allergies: emptyToNull(r.allergies),
          dietary_restrictions: emptyToNull(r.dietary_restrictions),
          medical_notes: emptyToNull(r.medical_notes),
          medical_conditions: emptyToNull(r.medical_conditions),
          epipen_required: parseBool(r.epipen_required),
          medications_at_program: emptyToNull(r.medications_at_program),
          emergency_contact_name: emptyToNull(r.emergency_contact_name),
          emergency_contact_phone: emptyToNull(r.emergency_contact_phone),
          special_needs_accommodations: emptyToNull(r.special_needs_accommodations),
        };

        if (studentId) {
          // Update student fields with whatever's provided this round.
          // Don't blow away existing values with nulls — only overwrite
          // when the incoming row has a non-null value.
          const updateFields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(studentFields)) {
            if (k === 'parent_id' || k === 'organization_id') continue;
            if (v !== null && v !== undefined) updateFields[k] = v;
          }
          if (Object.keys(updateFields).length > 0) {
            const { error: sErr } = await supabase
              .from('students')
              .update(updateFields)
              .eq('id', studentId);
            if (sErr) throw new Error(`student_update_failed: ${sErr.message}`);
          }
        } else {
          const { data: newStudent, error: sErr } = await supabase
            .from('students')
            .insert(studentFields)
            .select('id')
            .single();
          if (sErr) throw new Error(`student_create_failed: ${sErr.message}`);
          studentId = newStudent.id;
        }

        // REGISTRATION — upsert on (camp_session_id, student_id).
        const regFields = {
          camp_session_id: campSessionId,
          student_id: studentId,
          parent_id: parentId,
          organization_id: orgId,
          status: 'confirmed',
          registered_at: new Date().toISOString(),
          notes: emptyToNull(r.notes),
          photo_release_consent: parseBool(r.photo_release_consent),
          authorized_pickup_contacts: emptyToNull(r.authorized_pickup_contacts),
        };

        const { data: existingReg } = await supabase
          .from('registrations')
          .select('id')
          .eq('camp_session_id', campSessionId)
          .eq('student_id', studentId)
          .maybeSingle();

        if (existingReg) {
          const updateFields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(regFields)) {
            if (k === 'camp_session_id' || k === 'student_id' || k === 'parent_id' || k === 'organization_id') continue;
            if (k === 'registered_at') continue; // preserve original registration date
            if (v !== null && v !== undefined) updateFields[k] = v;
          }
          if (Object.keys(updateFields).length > 0) {
            const { error: rErr } = await supabase
              .from('registrations')
              .update(updateFields)
              .eq('id', existingReg.id);
            if (rErr) throw new Error(`registration_update_failed: ${rErr.message}`);
          }
          results.updated++;
        } else {
          const { error: rErr } = await supabase
            .from('registrations')
            .insert(regFields);
          if (rErr) throw new Error(`registration_insert_failed: ${rErr.message}`);
          results.imported++;
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.error(`row ${i} failed:`, msg);
        results.errors.push({ row_index: i, error: msg });
        results.skipped++;
      }
    }

    return json(results);
  } catch (err) {
    console.error('admin-import-camp-roster fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

function emptyToNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseGrade(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  if (Number.isNaN(n)) return null;
  if (n < -1 || n > 16) return null; // sanity bounds (K=0, pre-K=-1)
  return n;
}

function parseDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Accept YYYY-MM-DD directly.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Accept MM/DD/YYYY (Squarespace + US norm).
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mo = m[1].padStart(2, '0');
    const d = m[2].padStart(2, '0');
    return `${m[3]}-${mo}-${d}`;
  }
  // Fallback: let Date.parse have a go.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function parseBool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['y', 'yes', 'true', '1', 'consent', 'granted', 'agreed'].includes(s)) return true;
  if (['n', 'no', 'false', '0', 'declined', 'denied'].includes(s)) return false;
  return null;
}
