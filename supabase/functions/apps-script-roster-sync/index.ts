// apps-script-roster-sync — receives roster rows from a tenant-owned Google
// Apps Script that watches their Squarespace-export Drive folder.
//
// Auth: tenant's opaque secret (organizations.apps_script_sync_secret),
// presented in the body. The secret is also the tenant identifier — we
// look up the org by it. No JWT. No CORS preflight needed (Apps Script
// posts with its own user-agent, not a browser).
//
// Body:
//   {
//     secret: "<hex>",
//     camp_filename: "7/13-7/17 Morning - Happy Valley Summer Camp: Next Level Robotics",
//     rows: [
//       { ...row keyed by Squarespace column header... },
//       ...
//     ]
//   }
//
// Per row Squarespace columns we care about:
//   "Amount Refunded", "Total"               -> skip if refund == total
//   "Email"                                  -> parent email (alt: "Checkout Form: Parent or Guardian Email")
//   "Billing Name"                           -> parent name (alt: "Checkout Form: Parent or Guardians name")
//   "Checkout Form: Parent or Guardian Phone number"
//   "Checkout Form: Emergency Contact Name"
//   "Checkout Form: Emergency Contact Phone Number"
//   "Product Form: Participant Name"         -> single string; we split on first space
//   "Product Form: Participants Date of Birth"  -> "M/D/YYYY"
//   "Product Form: Does the participant have any medical conditions we should be aware of?"
//
// camp_filename parsing:
//   "M/D-M/D <session_type> - <venue_keyword> Summer Camp: <curriculum>"
//   - Extract starts_on month/day (current year)
//   - Extract session_type: Morning / Afternoon / Full-Day -> morning / afternoon / full_day
//   - Extract venue keyword (everything between session_type and "Summer Camp:")
//   - Curriculum text used as tiebreaker if multiple camps match
//
// Returns:
//   { camp_session_id, camp_name, imported, updated, cancelled, skipped, errors[] }
//
// Multi-tenant: org_id resolved from secret. All DB operations scoped to
// that org. A leaked secret only exposes its own tenant.

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

interface SyncBody {
  secret?: string;
  camp_filename?: string;
  rows?: Record<string, unknown>[];
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    let body: SyncBody;
    try {
      body = (await req.json()) as SyncBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const secret = String(body.secret ?? '').trim();
    const filename = String(body.camp_filename ?? '').trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!secret) return json({ error: 'secret_required' }, 401);
    if (!filename) return json({ error: 'camp_filename_required' }, 400);

    const supabase = adminClient();

    // 1. Resolve org by secret. Anti-enumeration: invalid secret returns 401
    //    with no detail.
    const { data: org } = await supabase
      .from('organizations')
      .select('id, slug')
      .eq('apps_script_sync_secret', secret)
      .maybeSingle();
    if (!org) return json({ error: 'invalid_secret' }, 401);

    // 2. Match the filename to a camp_session in this org.
    const match = parseFilename(filename);
    if (!match) {
      return json({ error: 'unparseable_filename', filename }, 400);
    }

    const { data: candidates, error: candErr } = await supabase
      .from('camp_sessions')
      .select('id, starts_on, ends_on, session_type, location_name, curriculum_name')
      .eq('organization_id', org.id)
      .eq('session_type', match.sessionType)
      .gte('starts_on', match.startDateBoundLo)
      .lte('starts_on', match.startDateBoundHi);
    if (candErr) {
      console.error('camp_sessions lookup failed:', candErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Venue match: Drive filename uses marketing city ("Portland Summer
    // Camp") but DB location_name is the specific venue building ("The
    // Historic Overlook House"). CITY_ALIASES bridges that. If the
    // filename keyword is in the alias map, accept candidates whose
    // location_name contains ANY alias for that city. Otherwise fall
    // back to direct substring match (works for cases where the city
    // name IS in the venue name, like "Beaverton").
    const venueKey = match.venueKeyword.toLowerCase().trim();
    const aliases = CITY_ALIASES[venueKey] ?? [venueKey];
    const filtered = (candidates ?? []).filter((c) => {
      const loc = (c.location_name ?? '').toLowerCase();
      return aliases.some((a) => loc.includes(a));
    });

    let campSession: typeof filtered[number] | null = null;
    if (filtered.length === 1) {
      campSession = filtered[0];
    } else if (filtered.length > 1) {
      // Disambiguate by curriculum keyword.
      const curriculumLower = (match.curriculumHint ?? '').toLowerCase();
      const scored = filtered
        .map((c) => ({
          c,
          score: scoreCurriculumMatch(curriculumLower, (c.curriculum_name ?? '').toLowerCase()),
        }))
        .sort((a, b) => b.score - a.score);
      if (scored.length > 0 && scored[0].score > 0) {
        campSession = scored[0].c;
      }
    }

    if (!campSession) {
      return json({
        error: 'no_camp_match',
        filename,
        parsed: match,
        candidates_count: filtered.length,
      }, 404);
    }

    // 3. Process rows.
    const results = {
      camp_session_id: campSession.id,
      camp_name: `${campSession.curriculum_name} (${campSession.location_name})`,
      imported: 0,
      updated: 0,
      cancelled: 0,
      skipped: 0,
      errors: [] as Array<{ row_index: number; error: string }>,
    };

    // Track which student_ids we touched so we can cancel ones that no
    // longer appear (refunds/withdrawn).
    const touchedStudentIds = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as Record<string, unknown>;
      try {
        // Refund detection: rows where Amount Refunded >= Total are
        // effectively cancelled. Don't import; if a matching registration
        // exists for this kid, soft-cancel it.
        const refunded = Number(r['Amount Refunded'] ?? 0);
        const total = Number(r['Total'] ?? 0);
        const fullyRefunded = refunded > 0 && refunded >= total;

        const camperName = String(r['Product Form: Participant Name'] ?? '').trim();
        if (!camperName) {
          results.skipped++;
          results.errors.push({ row_index: i, error: 'missing_participant_name' });
          continue;
        }
        const [studentFirst, ...rest] = camperName.split(/\s+/);
        const studentLast = rest.join(' ').trim();

        const parentEmail = String(
          r['Checkout Form: Parent or Guardian Email']
            ?? r['Email']
            ?? ''
        ).trim().toLowerCase();
        const parentNameRaw = String(
          r['Checkout Form: Parent or Guardians name']
            ?? r['Billing Name']
            ?? ''
        ).trim();
        const [parentFirst, ...parentRest] = parentNameRaw.split(/\s+/);
        const parentLast = parentRest.join(' ').trim() || parentFirst || 'Unknown';
        const parentPhone = String(r['Checkout Form: Parent or Guardian Phone number'] ?? '').trim();
        const emergencyName = String(r['Checkout Form: Emergency Contact Name'] ?? '').trim();
        const emergencyPhone = String(r['Checkout Form: Emergency Contact Phone Number'] ?? '').trim();
        const dob = parseDob(String(r['Product Form: Participants Date of Birth'] ?? ''));
        const medical = String(
          r['Product Form: Does the participant have any medical conditions we should be aware of?']
            ?? ''
        ).trim();

        // PARENT: match by email else create.
        let parentId: string | null = null;
        if (parentEmail) {
          const { data: ex } = await supabase
            .from('parents')
            .select('id')
            .ilike('email', parentEmail)
            .limit(1)
            .maybeSingle();
          if (ex) parentId = ex.id;
        }
        if (!parentId) {
          const fallbackEmail = parentEmail
            || `${studentFirst.toLowerCase()}.${studentLast.toLowerCase() || 'unknown'}.${Date.now()}.${i}@import.local`;
          const { data: np, error: pErr } = await supabase
            .from('parents')
            .insert({
              first_name: parentFirst || studentFirst,
              last_name: parentLast,
              email: fallbackEmail,
              phone: parentPhone || null,
              emergency_contact_name: emergencyName || null,
              emergency_contact_phone: emergencyPhone || null,
            })
            .select('id')
            .single();
          if (pErr) throw new Error(`parent_create_failed: ${pErr.message}`);
          parentId = np.id;
        }

        // STUDENT: match by (parent_id, first_name, last_name) else create.
        let studentId: string | null = null;
        {
          const { data: ex } = await supabase
            .from('students')
            .select('id')
            .eq('parent_id', parentId)
            .ilike('first_name', studentFirst)
            .ilike('last_name', studentLast || '')
            .limit(1)
            .maybeSingle();
          if (ex) studentId = ex.id;
        }

        const studentFields: Record<string, unknown> = {
          parent_id: parentId,
          organization_id: org.id,
          first_name: studentFirst,
          last_name: studentLast || null,
          birthdate: dob,
          medical_notes: medical && medical.toLowerCase() !== 'no' && medical.toLowerCase() !== 'none' ? medical : null,
          emergency_contact_name: emergencyName || null,
          emergency_contact_phone: emergencyPhone || null,
        };

        if (studentId) {
          // Update only non-null incoming fields — never blow away admin
          // edits to allergies / authorized pickup with empty Squarespace
          // values.
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
          const { data: ns, error: sErr } = await supabase
            .from('students')
            .insert(studentFields)
            .select('id')
            .single();
          if (sErr) throw new Error(`student_create_failed: ${sErr.message}`);
          studentId = ns.id;
        }

        touchedStudentIds.add(studentId!);

        // REGISTRATION: upsert by (camp_session_id, student_id).
        const { data: existingReg } = await supabase
          .from('registrations')
          .select('id, status')
          .eq('camp_session_id', campSession.id)
          .eq('student_id', studentId)
          .maybeSingle();

        const desiredStatus = fullyRefunded ? 'cancelled' : 'confirmed';
        const regFields: Record<string, unknown> = {
          status: desiredStatus,
          notes: null,
        };
        // Confirmed requires photo_release_consent=true (per check constraint)
        if (desiredStatus === 'confirmed') {
          regFields.photo_release_consent = true;
          regFields.photo_release_consent_at = new Date().toISOString();
        }

        if (existingReg) {
          if (existingReg.status !== desiredStatus) {
            const { error: uErr } = await supabase
              .from('registrations')
              .update(regFields)
              .eq('id', existingReg.id);
            if (uErr) throw new Error(`registration_update_failed: ${uErr.message}`);
            if (desiredStatus === 'cancelled') results.cancelled++;
            else results.updated++;
          } else {
            // No-op
          }
        } else {
          if (fullyRefunded) {
            // Refunded row + no existing registration: skip; nothing to
            // cancel. (Could insert with status=cancelled but that adds
            // noise to the roster for no benefit.)
            results.skipped++;
            continue;
          }
          const { error: iErr } = await supabase
            .from('registrations')
            .insert({
              camp_session_id: campSession.id,
              student_id: studentId,
              parent_id: parentId,
              organization_id: org.id,
              registered_at: new Date().toISOString(),
              ...regFields,
            });
          if (iErr) throw new Error(`registration_insert_failed: ${iErr.message}`);
          results.imported++;
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.error(`row ${i} failed:`, msg);
        results.errors.push({ row_index: i, error: msg });
        results.skipped++;
      }
    }

    // 4. Detect implicit cancellations: registrations in our DB for this
    //    camp_session whose student wasn't seen in the incoming rows at
    //    all. Mark cancelled. Only soft (status update), never delete.
    if (touchedStudentIds.size > 0) {
      const touched = [...touchedStudentIds];
      const { data: existingRegs } = await supabase
        .from('registrations')
        .select('id, student_id')
        .eq('camp_session_id', campSession.id)
        .eq('status', 'confirmed');
      const orphaned = (existingRegs ?? []).filter((r) => !touched.includes(r.student_id));
      if (orphaned.length > 0) {
        const { error: cErr } = await supabase
          .from('registrations')
          .update({ status: 'cancelled' })
          .in('id', orphaned.map((r) => r.id));
        if (!cErr) results.cancelled += orphaned.length;
      }
    }

    return json(results);
  } catch (err) {
    console.error('apps-script-roster-sync fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

interface ParsedFilename {
  startDateBoundLo: string; // YYYY-MM-DD; first day of the month/day from filename
  startDateBoundHi: string;
  sessionType: string;       // morning / afternoon / full_day
  venueKeyword: string;
  curriculumHint: string;
}

// Marketing city in Drive filename → list of substrings to look for in
// camp_sessions.location_name. For cities where the city name IS the
// venue keyword (Beaverton, Happy Valley, Hillsboro, Forest Grove,
// West Linn), no aliasing needed — they'd fall through to a direct
// substring match. Listed here only for clarity.
//
// J2S-specific. Future tenants would need their own alias map, OR we
// move this to a per-org JSON column on organizations.
const CITY_ALIASES: Record<string, string[]> = {
  'portland': ['historic overlook', 'st. paul', 'st paul', 'community of faith', 'catlin gabel'],
  'vancouver': ['firstenburg'],
  'oregon city': ['first congregational'],
  'camas': ['camas', 'lacamas'],
  'beaverton': ['beaverton'],
  'happy valley': ['happy valley'],
  'hillsboro': ['hillsboro'],
  'forest grove': ['forest grove'],
  'west linn': ['west linn'],
  'corbett': ['corbett'],
};

function parseFilename(name: string): ParsedFilename | null {
  // "M/D-M/D <session_type> - <venue> Summer Camp: <curriculum>"
  // Tolerate extra spaces, leading/trailing whitespace.
  const trimmed = name.replace(/\s+/g, ' ').trim();
  // Capture start M/D, session_type (text up to " - "), then rest after " - ".
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\s*[-–]\s*\d{1,2}\/\d{1,2}\s+(Morning|Afternoon|Full-Day|Full Day)\s*-\s*(.*?)\s+Summer Camp:\s*(.*)$/i);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const sessionRaw = m[3].toLowerCase().replace(/[\s-]+/g, '');
  let sessionType = '';
  if (sessionRaw === 'morning') sessionType = 'morning';
  else if (sessionRaw === 'afternoon') sessionType = 'afternoon';
  else if (sessionRaw === 'fullday') sessionType = 'full_day';
  else return null;
  const venueKeyword = m[4].trim();
  const curriculumHint = m[5].trim();

  // Use current year for the bound. If anyone runs this in Jan for a
  // sheet from last summer, they'd need to manually fix.
  const year = new Date().getFullYear();
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const target = `${year}-${mm}-${dd}`;
  // Same-day bound (we match starts_on exactly via gte/lte).
  return {
    startDateBoundLo: target,
    startDateBoundHi: target,
    sessionType,
    venueKeyword,
    curriculumHint,
  };
}

function scoreCurriculumMatch(filenameCurriculum: string, dbCurriculum: string): number {
  if (!filenameCurriculum || !dbCurriculum) return 0;
  // Word-overlap, ignoring punctuation/stopwords. Borrowed pattern from
  // CurriculumReview.jsx matchScore.
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'with', 'of', 'for', 'camp', '&']);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !stop.has(w));
  const aw = new Set(norm(filenameCurriculum));
  const bw = new Set(norm(dbCurriculum));
  if (aw.size === 0 || bw.size === 0) return 0;
  let overlap = 0;
  for (const w of aw) if (bw.has(w)) overlap++;
  return overlap / Math.max(aw.size, bw.size);
}

function parseDob(v: string): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mo = m[1].padStart(2, '0');
    const d = m[2].padStart(2, '0');
    return `${m[3]}-${mo}-${d}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}
