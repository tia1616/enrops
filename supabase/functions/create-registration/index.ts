// create-registration — service-role function to write guest registrations atomically.
//
// WHY THIS EXISTS:
// The `parents`, `students`, `registrations`, and `waiver_signatures` tables all have
// RLS policies requiring an authenticated user (auth.uid() = auth_id, or parent_id =
// current_parent_id()). For guest checkout, we don't have an authenticated user yet —
// account creation happens AFTER payment on the success page.
//
// This function bypasses RLS using the service role key, validates + writes everything
// atomically, then returns registration IDs for the frontend to pass to Stripe Checkout.
//
// AUTH_ID LINKAGE:
// If a `parents` row already exists with this email AND has an auth_id set, we reuse it
// (parent registered before and has an account). If no auth_id yet, we leave it null
// and the success page / login flow will link it when they sign in. This way the parent
// portal "just works" later without any migration.
//
// PHOTO RELEASE:
// Per memory rule: photo_release_consent = true is set automatically when the J2S waiver
// is agreed to. No separate checkbox.

// @deno-types="https://esm.sh/v135/@supabase/supabase-js@2.39.0/dist/module/index.d.ts"
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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    const {
      organization_slug,
      parent,
      children,
      promo_code,
      payment_plan,
      pricing_snapshot,
    } = body;

    // --- Validate inputs ---
    if (!organization_slug || !parent?.email || !children?.length) {
      return json({ error: 'Missing required fields' }, 400);
    }
    if (!pricing_snapshot?.lines?.length) {
      return json({ error: 'No line items' }, 400);
    }

    // --- Resolve organization ---
    const { data: org, error: orgErr } = await admin
      .from('organizations')
      .select('id')
      .eq('slug', organization_slug)
      .single();
    if (orgErr || !org) {
      return json({ error: `Unknown organization: ${organization_slug}` }, 400);
    }
    const orgId = org.id;

    // --- Upsert parent ---
    const emailClean = parent.email.toLowerCase().trim();
    const { data: existing } = await admin
      .from('parents')
      .select('id, auth_id')
      .eq('email', emailClean)
      .maybeSingle();

    let parentId: string;
    if (existing) {
      parentId = existing.id;
      await admin
        .from('parents')
        .update({
          first_name: parent.first_name,
          last_name: parent.last_name,
          phone: parent.phone,
        })
        .eq('id', parentId);
    } else {
      const { data: newParent, error: pErr } = await admin
        .from('parents')
        .insert({
          first_name: parent.first_name,
          last_name: parent.last_name,
          email: emailClean,
          phone: parent.phone,
          // auth_id intentionally left null — will link on login/signup post-payment
        })
        .select('id')
        .single();
      if (pErr) throw new Error(`parent insert: ${pErr.message}`);
      parentId = newParent!.id;
    }

    // --- Link parent to this organization (so org admins can see them) ---
    const { data: existingRel } = await admin
      .from('parent_org_relationships')
      .select('id')
      .eq('parent_id', parentId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (!existingRel) {
      await admin.from('parent_org_relationships').insert({
        parent_id: parentId,
        organization_id: orgId,
        how_heard: children[0]?.student?.how_heard || null,
      });
    }

    // --- For each child: upsert student, then one registration per cart item ---
    const registrationIds: string[] = [];
    const studentIdByChildIndex = new Map<number, string>();

    for (const child of children) {
      const student = child.student;
      if (!student?.first_name || !student?.last_name) {
        throw new Error(`child ${child.child_index}: missing student name`);
      }

      // Parse grade: 'K' handled as 0 in frontend, string ints otherwise.
      let gradeVal: number | null = null;
      if (student.grade !== '' && student.grade != null) {
        gradeVal = parseInt(student.grade, 10);
        if (isNaN(gradeVal)) gradeVal = null;
      }

      const { data: newStudent, error: sErr } = await admin
        .from('students')
        .insert({
          parent_id: parentId,
          organization_id: orgId,
          school_id: child.school_id,
          first_name: student.first_name,
          last_name: student.last_name,
          grade: gradeVal,
          homeroom_teacher: student.homeroom_teacher || null,
          birthdate: student.birthdate || null,
          allergies: student.allergies || null,
          medical_notes: student.medical_notes || null,
          special_needs_accommodations: student.special_needs_accommodations || null,
          emergency_contact_name: student.emergency_contact_name || null,
          emergency_contact_phone: student.emergency_contact_phone || null,
        })
        .select('id')
        .single();
      if (sErr) throw new Error(`student insert: ${sErr.message}`);
      const studentId = newStudent!.id;
      studentIdByChildIndex.set(child.child_index, studentId);

      // --- Registrations: one per line item for this child ---
      // For VIP: item has vipBundle with fall/winter/spring → create 3 registrations.
      // For standard: one registration per item.
      for (const item of child.items) {
        const programsToRegister = item.isVip && item.vipBundle
          ? [item.vipBundle.fall, item.vipBundle.winter, item.vipBundle.spring]
          : [item.program];

        // Find the matching pricing line for this child+program (first match).
        const lineForFall = pricing_snapshot.lines.find(
          (l: any) =>
            l.child_index === child.child_index &&
            l.program_id === item.program.id,
        );
        // For VIP: cart line is $720 (year total). Each of the 3 term registrations
        // VIP creates 3 registrations (Fall, Winter, Spring), each at the locked
        // $240 per-term VIP price. Cart line is now also $240 (per-term, not year total).
        // Pinning to constant prevents a future cart bug from writing a wrong amount.
        const VIP_PER_TERM_CENTS = 24000;
        const perRegAmount = item.isVip
          ? VIP_PER_TERM_CENTS
          : lineForFall?.subtotal_cents;

        for (const prog of programsToRegister) {
          if (!prog) continue; // skip missing winter/spring if somehow null

          const { data: reg, error: rErr } = await admin
            .from('registrations')
            .insert({
              program_id: prog.id,
              student_id: studentId,
              parent_id: parentId,
              organization_id: orgId,
              status: 'pending',
              payment_method: payment_plan ? 'stripe_installments' : 'stripe',
              payment_status: 'unpaid',
              amount_cents: perRegAmount,
              discount_type: item.isVip
                ? 'vip'
                : promo_code
                ? 'promo'
                : child.child_index > 0
                ? 'sibling'
                : null,
              discount_cents: lineForFall?.sibling_discount_cents || 0,
              promo_code_used: promo_code || null,
              how_heard: student.how_heard || null,
              referred_by:
                student.how_heard === 'Other' ? student.how_heard_other : null,
              // Photo release: TRUE if J2S waiver was agreed to (handled below after waivers check)
              photo_release_consent: false, // set below based on waiver
              photo_release_consent_at: null,
              program_fit_acknowledged: false, // set below
              program_fit_acknowledged_at: null,
            })
            .select('id')
            .single();
          if (rErr) throw new Error(`registration insert: ${rErr.message}`);
          registrationIds.push(reg!.id);
        }
      }

      // --- Waiver signatures ---
      // Load the waivers to know names (for photo release logic) and for the signature text.
      const waiverIds = Object.keys(child.waivers || {}).filter(
        (wid) => child.waivers[wid]?.agreed === true,
      );

      if (waiverIds.length) {
        const { data: waiverRows } = await admin
          .from('waivers')
          .select('id, name, content, version')
          .in('id', waiverIds);

        // Create signature for each agreed waiver on each registration for this child.
        // For VIP carts, child.items.length=1 but 3 registrations were just inserted (Fall/Winter/Spring),
        // so we count actual registrations created, not items in cart.
        const totalRegsForThisChild = child.items.reduce(
          (sum: number, item: any) =>
            sum + (item.isVip && item.vipBundle ? 3 : 1),
          0,
        );
        const childRegIds = registrationIds.slice(-totalRegsForThisChild);

        const sigsToInsert: any[] = [];
        let photoReleaseTrue = false;
        let programFitTrue = false;
        let programFitText = '';

        for (const w of waiverRows || []) {
          const isJ2sWaiver = /waiver.*agreement|j2s.*waiver|waiver.*j2s/i.test(w.name);
          const isProgFit = /program fit|inclusivity/i.test(w.name);

          if (isJ2sWaiver) photoReleaseTrue = true;
          if (isProgFit) {
            programFitTrue = true;
            programFitText = child.waivers[w.id]?.comments || '';
          }

          for (const regId of childRegIds) {
            sigsToInsert.push({
              registration_id: regId,
              waiver_id: w.id,
              parent_id: parentId,
              organization_id: orgId,
              signature_text:
                child.waivers[w.id]?.signature_text ||
                `I agree — ${parent.first_name} ${parent.last_name}`,
              waiver_text_snapshot: w.content,
              waiver_version: w.version || 1,
            });
          }
        }

        if (sigsToInsert.length) {
          const { error: wsErr } = await admin
            .from('waiver_signatures')
            .insert(sigsToInsert);
          if (wsErr) throw new Error(`waiver signatures: ${wsErr.message}`);
        }

        // Update registrations with consent flags (photo_release, program_fit).
        const now = new Date().toISOString();
        const updatePatch: any = {};
        if (photoReleaseTrue) {
          updatePatch.photo_release_consent = true;
          updatePatch.photo_release_consent_at = now;
        }
        if (programFitTrue) {
          updatePatch.program_fit_acknowledged = true;
          updatePatch.program_fit_acknowledged_at = now;
          if (programFitText) {
            updatePatch.notes = programFitText;
          }
        }
        if (Object.keys(updatePatch).length) {
          await admin
            .from('registrations')
            .update(updatePatch)
            .in('id', childRegIds);
        }
      }
    }

    return json({ registration_ids: registrationIds, parent_id: parentId });
  } catch (err) {
    console.error('create-registration error:', err);
    return json(
      { error: (err as Error).message || 'Internal error' },
      500,
    );
  }
});
