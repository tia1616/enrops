// update-instructor-profile — instructor self-edit endpoint for the
// portal v1 My Profile screen.
//
// Body (all fields optional; omit what isn't being edited):
//   {
//     preferred_name?: string,       // empty string clears, omitted = no change
//     phone?: string,                // empty-after-trim ignored (never overwrite a real number with '')
//     avatar_key?: string,           // must be one of the 8 bottts-* keys
//     shirt_size?: string,           // must be in the enum (or empty string to clear)
//     first_aid_cpr_url?: string,    // if present, expiry is required too
//     first_aid_cpr_expires_at?: string, // YYYY-MM-DD
//     emergency_contacts?: Array<{ contact_name, relationship, phone }>
//   }
//
// Empty body returns { success: true, noop: true }.
//
// Two-step write:
//   1) Update instructors row (service role — bypasses absent instructor UPDATE RLS)
//   2) If emergency_contacts present, call replace_emergency_contacts RPC
//      (Chunk A). RPC is atomic delete+insert; locked to service_role.
// Partial-success path: if (1) succeeds and (2) fails, the RPC error is
// returned. Phone/avatar persist; instructor retries contacts. Frontend
// handles this by keeping the form dirty.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

// IMPORTANT: this list is the second source-of-truth for valid avatar keys.
// The canonical definition lives at src/lib/avatars.js (Chunk D). Deno can't
// import from src/, so the keys are duplicated here. If you change one,
// change the other. Drift risk is low (8 short strings) but flagged.
const VALID_AVATAR_KEYS = new Set([
  'bottts-1', 'bottts-2', 'bottts-3', 'bottts-4',
  'bottts-5', 'bottts-6', 'bottts-7', 'bottts-8',
]);

const VALID_SHIRT_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']);

interface EmergencyContactInput {
  contact_name?: string;
  relationship?: string;
  phone?: string;
}

interface RequestBody {
  preferred_name?: string;
  phone?: string;
  avatar_key?: string;
  shirt_size?: string;
  first_aid_cpr_url?: string;
  first_aid_cpr_expires_at?: string;
  emergency_contacts?: EmergencyContactInput[];
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const hasPreferredName = typeof body.preferred_name === 'string';
    const hasPhone = typeof body.phone === 'string';
    const hasAvatar = typeof body.avatar_key === 'string';
    const hasShirt = typeof body.shirt_size === 'string';
    const hasCprUrl = typeof body.first_aid_cpr_url === 'string';
    const hasCprExpiry = typeof body.first_aid_cpr_expires_at === 'string';
    const hasContacts = Array.isArray(body.emergency_contacts);

    if (!hasPreferredName && !hasPhone && !hasAvatar && !hasShirt && !hasCprUrl && !hasCprExpiry && !hasContacts) {
      return json({ success: true, noop: true });
    }

    // Build the instructors UPDATE payload.
    const updates: Record<string, unknown> = {};

    if (hasPreferredName) {
      const trimmed = sanitizeString(body.preferred_name);
      // Explicit empty string clears the column; otherwise set to trimmed value.
      updates.preferred_name = trimmed; // null if blank
    }

    if (hasPhone) {
      const trimmed = sanitizeString(body.phone);
      // Empty after trim → ignore (don't overwrite a real number with '').
      if (trimmed !== null) {
        updates.phone = trimmed;
      }
    }

    if (hasAvatar) {
      const raw = (body.avatar_key as string).trim();
      if (!VALID_AVATAR_KEYS.has(raw)) {
        return json({ error: 'invalid_avatar' }, 400);
      }
      updates.photo_url = raw;
    }

    if (hasShirt) {
      const raw = (body.shirt_size as string).trim().toUpperCase();
      if (raw === '') {
        updates.shirt_size = null; // explicit clear
      } else if (!VALID_SHIRT_SIZES.has(raw)) {
        return json({ error: 'invalid_shirt_size' }, 400);
      } else {
        updates.shirt_size = raw;
      }
    }

    // CPR cert: url + expiry travel as a pair. If url is present, expiry must
    // be too. If only expiry is sent (no url), accept it on its own — admin
    // might be correcting just the expiry date.
    if (hasCprUrl) {
      const url = sanitizeString(body.first_aid_cpr_url);
      if (url && !hasCprExpiry) {
        return json({ error: 'cpr_expiry_required' }, 400);
      }
      updates.first_aid_cpr_url = url;
    }
    if (hasCprExpiry) {
      const expiry = sanitizeDate(body.first_aid_cpr_expires_at);
      if (body.first_aid_cpr_expires_at && !expiry) {
        return json({ error: 'invalid_cpr_expiry_format' }, 400);
      }
      updates.first_aid_cpr_expires_at = expiry; // null if blank
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const supabase = adminClient();
      const { error: updErr } = await supabase
        .from('instructors')
        .update(updates)
        .eq('id', me.id);
      if (updErr) {
        console.error('instructor update failed:', updErr);
        return json({ error: 'update_failed' }, 500);
      }
    }

    // Emergency contacts via RPC (atomic delete+insert, see Chunk A).
    if (hasContacts) {
      const raw = body.emergency_contacts ?? [];
      if (raw.length === 0) {
        return json({ error: 'emergency_contacts_required' }, 400);
      }

      const cleaned: Array<{ contact_name: string; relationship: string; phone: string }> = [];
      for (const c of raw) {
        const name = sanitizeString(c?.contact_name);
        const rel = sanitizeString(c?.relationship);
        const phone = sanitizeString(c?.phone);
        if (!name || !rel || !phone) {
          return json({ error: 'contact_fields_required', detail: 'name, relationship, phone' }, 400);
        }
        cleaned.push({ contact_name: name, relationship: rel, phone });
      }

      const supabase = adminClient();
      const { error: rpcErr } = await supabase.rpc('replace_emergency_contacts', {
        p_instructor_id: me.id,
        p_organization_id: me.organization_id,
        p_contacts: cleaned,
      });
      if (rpcErr) {
        console.error('replace_emergency_contacts RPC failed:', rpcErr);
        // Partial-success path: instructors update already committed.
        return json({ error: 'contacts_save_failed' }, 500);
      }
    }

    return json({ success: true });
  } catch (err) {
    console.error('update-instructor-profile fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

function sanitizeString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > 1000 ? t.slice(0, 1000) : t;
}

function sanitizeDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}
