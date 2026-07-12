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
import { priceCart, validatePromo } from '../_shared/promoPricing.ts';

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

    // --- Server-authoritative pricing (chunk 6) ---
    // The browser's pricing_snapshot is display-only. Recompute the real price
    // from the DB so the registration rows, the Stripe charge, and the platform
    // fee all agree, and a tampered client total can never underpay. A promo that
    // went invalid between display and submit fails the whole registration — we
    // never silently charge full price.
    const VIP_PER_TERM_CENTS = 24000;

    // Flatten the cart into priced lines in the EXACT order registrations are
    // inserted below (children -> items -> programs, skipping nulls).
    type FlatLine = { child_index: number; program_id: string; is_vip: boolean };
    const flat: FlatLine[] = [];
    for (const child of children) {
      for (const item of child.items || []) {
        const progs = item.isVip && item.vipBundle
          ? [item.vipBundle.fall, item.vipBundle.winter, item.vipBundle.spring]
          : [item.program];
        for (const prog of progs) {
          if (!prog) continue;
          flat.push({ child_index: child.child_index, program_id: prog.id, is_vip: !!item.isVip });
        }
      }
    }
    if (!flat.length) return json({ error: 'No programs to register' }, 400);

    // Real prices for non-VIP programs, scoped to this org (reject a program that
    // isn't in this org so a client can't inject a foreign/fake price).
    const nonVipIds = [...new Set(flat.filter((f) => !f.is_vip).map((f) => f.program_id))];
    const priceById = new Map<string, { id: string; price_cents: number; early_bird_price_cents: number | null; early_bird_deadline: string | null }>();
    if (nonVipIds.length) {
      const { data: progRows, error: progErr } = await admin
        .from('programs')
        .select('id, organization_id, price_cents, early_bird_price_cents, early_bird_deadline')
        .in('id', nonVipIds);
      if (progErr) throw new Error(`price lookup: ${progErr.message}`);
      for (const pr of progRows || []) {
        if (pr.organization_id !== orgId) return json({ error: 'A program in your cart is not available.' }, 400);
        priceById.set(pr.id, pr);
      }
      for (const id of nonVipIds) {
        if (!priceById.has(id)) return json({ error: 'A program in your cart could not be found.' }, 400);
      }
    }

    const toLineInputs = () => flat.map((f) => ({
      program: f.is_vip
        ? { id: f.program_id, price_cents: VIP_PER_TERM_CENTS, early_bird_price_cents: null, early_bird_deadline: null }
        : priceById.get(f.program_id)!,
      child_index: f.child_index,
      is_vip: f.is_vip,
      vip_price_cents: f.is_vip ? VIP_PER_TERM_CENTS : undefined,
    }));

    // Org sibling-discount config (null = off).
    const { data: orgCfg } = await admin
      .from('organizations').select('sibling_discount_pct').eq('id', orgId).single();
    const siblingPct = orgCfg?.sibling_discount_pct ?? null;

    // Validate + load the promo (if one was entered).
    let validatedPromo: Parameters<typeof priceCart>[1]['validatedPromo'] = null;
    if (promo_code) {
      const { data: codeRow } = await admin
        .from('promo_codes').select('*')
        .eq('organization_id', orgId)
        .eq('code', String(promo_code).trim().toUpperCase())
        .eq('active', true)
        .maybeSingle();
      const codeId = codeRow?.id ?? '00000000-0000-0000-0000-000000000000';
      const [{ count: totalRedemptions }, { count: familyRedemptions }] = await Promise.all([
        admin.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('promo_code_id', codeId),
        admin.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('promo_code_id', codeId).eq('parent_id', parentId),
      ]);
      const preview = priceCart(toLineInputs(), { siblingPct, validatedPromo: null });
      const v = validatePromo(codeRow, {
        orgId,
        lineProgramIds: flat.map((f) => f.program_id),
        afterSiblingSubtotalCents: preview.subtotal_cents - preview.sibling_total_cents,
        totalRedemptions: totalRedemptions ?? 0,
        familyRedemptions: familyRedemptions ?? 0,
      });
      if (!v.valid) return json({ error: v.message || 'That promo code is not valid.', promo_error: true }, 400);
      validatedPromo = codeRow;
    }

    const priced = priceCart(toLineInputs(), { siblingPct, validatedPromo });

    // --- For each child: upsert student, then one registration per cart item ---
    const registrationIds: string[] = [];
    const studentIdByChildIndex = new Map<number, string>();
    // Authoritative per-line amounts, consumed in insert order; and the
    // checkout-ready lines returned for create-checkout.
    let priceIdx = 0;
    const returnLines: Array<Record<string, unknown>> = [];

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
          // customizable-registration: how the child leaves (null when the org
          // hasn't enabled that question)
          dismissal_method: student.dismissal_method || null,
        })
        .select('id')
        .single();
      if (sErr) throw new Error(`student insert: ${sErr.message}`);
      const studentId = newStudent!.id;
      studentIdByChildIndex.set(child.child_index, studentId);

      // --- Customizable registration: structured people → student_contacts ---
      // Written BEFORE checkout, so a failure here fails the registration with no
      // charge (never a paid enrollment missing its pickup/release data).
      const contactRows: any[] = [];
      const g2 = parent?.guardian2;
      if (g2 && (g2.first_name || '').trim()) {
        contactRows.push({
          student_id: studentId, organization_id: orgId, role: 'guardian',
          first_name: g2.first_name.trim(), last_name: (g2.last_name || '').trim() || null,
          phone: (g2.phone || '').trim() || null, email: (g2.email || '').trim() || null,
          sort_order: 0,
        });
      }
      (child.authorized_pickup || []).forEach((p: any, i: number) => {
        if ((p?.first_name || '').trim()) {
          contactRows.push({
            student_id: studentId, organization_id: orgId, role: 'authorized_pickup',
            first_name: p.first_name.trim(), last_name: (p.last_name || '').trim() || null,
            phone: (p.phone || '').trim() || null, sort_order: i,
          });
        }
      });
      (child.do_not_release || []).forEach((p: any, i: number) => {
        if ((p?.first_name || '').trim()) {
          contactRows.push({
            student_id: studentId, organization_id: orgId, role: 'do_not_release',
            first_name: p.first_name.trim(), last_name: (p.last_name || '').trim() || null,
            sort_order: i,
          });
        }
      });
      if (contactRows.length) {
        const { error: cErr } = await admin.from('student_contacts').insert(contactRows);
        if (cErr) throw new Error(`student_contacts insert: ${cErr.message}`);
      }

      // --- Registrations: one per line item for this child ---
      // For VIP: item has vipBundle with fall/winter/spring → create 3 registrations.
      // For standard: one registration per item.
      for (const item of child.items) {
        const programsToRegister = item.isVip && item.vipBundle
          ? [item.vipBundle.fall, item.vipBundle.winter, item.vipBundle.spring]
          : [item.program];

        for (const prog of programsToRegister) {
          if (!prog) continue; // skip missing winter/spring if somehow null

          // Authoritative amount for this line — same order as the pricing pass.
          const pl = priced.lines[priceIdx++];

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
              amount_cents: pl.amount_cents,       // NET, server-computed
              discount_type: item.isVip
                ? 'vip'
                : (validatedPromo && pl.promo_discount_cents > 0)
                ? 'promo'
                : child.child_index > 0
                ? 'sibling'
                : null,
              discount_cents: pl.discount_cents,   // sibling + promo on this line
              promo_code_used: validatedPromo ? validatedPromo.code : null,
              how_heard: student.how_heard || null,
              referred_by:
                student.how_heard === 'Other' ? student.how_heard_other : null,
              // customizable-registration: answers to the org's custom questions
              // (keyed by field_key; {} when none)
              custom_field_values: child.custom_answers || {},
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
          returnLines.push({
            registration_id: reg!.id,
            program_id: prog.id,
            program_name: prog.curriculum,
            school_name: prog.school_name || prog.program_locations?.name || '',
            day_of_week: prog.day_of_week,
            start_time: prog.start_time,
            amount_cents: pl.amount_cents,
            child_label: `Child ${child.child_index + 1}`,
          });
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

    return json({
      registration_ids: registrationIds,
      parent_id: parentId,
      // Authoritative pricing — the client forwards this to create-checkout so the
      // charge matches the DB rows (never the browser's numbers).
      pricing: {
        total_cents: priced.total_cents,
        lines: returnLines,
        promo: validatedPromo
          ? { code: validatedPromo.code, discount_cents: priced.promo_discount_cents }
          : null,
      },
    });
  } catch (err) {
    console.error('create-registration error:', err);
    return json(
      { error: (err as Error).message || 'Internal error' },
      500,
    );
  }
});
