// join-waitlist — a family joins the waitlist for a FULL afterschool class.
//
// Public (verify_jwt = false), like create-registration, because a family joining a
// waitlist has no account yet. Holds the service role, so EVERYTHING client-supplied is
// re-resolved server-side and nothing is trusted.
//
// WHAT THIS IS NOT: it takes no payment and creates no checkout. A row created HERE holds
// no seat - registration_holds_seat() returns false for a waitlist row with no invite - so
// the capacity gate ignores it. (That rule changed under this comment on 2026-08-19: since
// 20260819f a waitlist row DOES hold a seat while it carries an unexpired invite. Nothing
// in this endpoint sets those columns, so every row it writes is seat-less on creation.)
// Promotion (auto-inviting the top of the list when a seat opens) is chunk 2 and lives
// elsewhere.
//
// THE LIGHT FORM (Jessica's call, 2026-08-19): child first/last/grade + parent
// first/last/email/phone. No waivers, no custom questions, no dismissal answers. Those
// are collected later, when an invited family goes through real registration - which is
// also why this endpoint must never write the fields that flow require.
//
// ORDER OF OPERATIONS IS DELIBERATE:
//   1. validate the cart-free inputs
//   2. resolve the org
//   3. call waitlist_join FIRST via a dry-run? No - see below.
// The atomic guard lives in waitlist_join(), which re-checks org/open/ours/full and
// assigns the position under a per-program advisory lock. So this function's job is to
// get a parent id and a student id, hand them over, and report the position back.
//
// PARENT/STUDENT WRITES HAPPEN BEFORE THE JOIN, and that is a deliberate trade. If
// waitlist_join then rejects (class no longer full, say), a parent+student row is left
// behind with no waitlist row. That is inert - a contactable family with no enrolment,
// which the platform already has hundreds of - whereas the alternative (join first, then
// attach a parent) cannot work because the row needs parent_id and student_id up front.
// The reverse mistake would be worse: a waitlist row pointing at nothing.

// NO @deno-types pragma here, deliberately. Pointing at the v135 pinned .d.ts gives the
// client a DIFFERENT type identity from the one _shared/orgBrand.ts imports, and passing
// it to loadOrgBrand then fails with a protected-member mismatch that reads like a
// library bug. Every _shared consumer uses this bare specifier; match it.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
import { buildWaitlistConfirmation } from '../_shared/waitlistEmail.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;

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
    const { organization_slug, program_id, parent, student } = body ?? {};

    // --- Validate shape before touching anything ---
    if (!organization_slug || typeof program_id !== 'string' || !program_id) {
      return json({ error: 'Missing required fields' }, 400);
    }
    // String(...) before trim on every field: the body is client-supplied JSON, and a
    // number/array/object passes an optional-chain null check, resolves .trim to
    // undefined and throws "is not a function" - a 500 from a malformed payload. Same
    // shape create-registration had to be corrected to.
    const parentEmail = String(parent?.email ?? '').trim().toLowerCase();
    const parentFirst = String(parent?.first_name ?? '').trim();
    const parentLast = String(parent?.last_name ?? '').trim();
    const parentPhone = String(parent?.phone ?? '').trim() || null;
    const childFirst = String(student?.first_name ?? '').trim();
    const childLast = String(student?.last_name ?? '').trim();

    // LAST NAMES ARE REQUIRED, because the database has always required them:
    // parents.last_name and students.last_name are both NOT NULL. The light form
    // originally marked them optional, so leaving either blank threw 23502 and this
    // endpoint returned a bare 500 - the family saw "we could not add you to the list,
    // please try again" and retrying could never work. Validate here so the message is
    // honest, and keep the form's required markers in step with this list.
    if (!parentEmail || !parentFirst || !childFirst) {
      return json({ error: 'We need the child\'s first name and your name and email.' }, 400);
    }
    if (!childLast || !parentLast) {
      return json({ error: 'We need a last name for you and for your child.' }, 400);
    }
    // Grade is optional on the light form. Accept 0 (Kindergarten) - `|| null` would
    // turn K into null, which is the classic falsy-zero bug and K is a real grade here.
    const gradeRaw = student?.grade;
    const grade = gradeRaw === '' || gradeRaw === null || gradeRaw === undefined
      ? null
      : Number.isFinite(Number(gradeRaw)) ? Number(gradeRaw) : null;

    // --- Resolve the org from the slug, never from the body ---
    const { data: org, error: orgErr } = await admin
      .from('organizations')
      .select('id, name')
      .eq('slug', organization_slug)
      .single();
    if (orgErr || !org) return json({ error: `Unknown organization: ${organization_slug}` }, 400);

    // --- Parent: reuse by email, else create ---
    // Matched on email alone, mirroring create-registration, because that is what the
    // global unique index on parents.email enforces. auth_id is left alone here: the
    // account invite is sent separately and the on_auth_user_created_link_parent trigger
    // links it, so this endpoint never has to manage that column.
    const { data: existingParent } = await admin
      .from('parents')
      .select('id')
      .eq('email', parentEmail)
      .maybeSingle();

    let parentId: string;
    if (existingParent) {
      parentId = existingParent.id;
      // ONLY WRITE WHAT THEY ACTUALLY TYPED.
      //
      // Last name and phone are OPTIONAL on the light join form, and the parent here
      // may already be a paying customer whose phone the provider relies on. Writing
      // the form's blanks straight through would null the contact details on file for
      // their ENROLLED child - a silent data loss the family and the operator would
      // both discover at the worst moment. create-registration writes these three
      // unconditionally, which is safe there only because its wizard requires them;
      // this form does not, so blanks are the expected case rather than the odd one.
      //
      // A blank field means "I didn't fill this in", never "delete what you have".
      const parentPatch: Record<string, string> = {};
      if (parentFirst) parentPatch.first_name = parentFirst;
      if (parentLast) parentPatch.last_name = parentLast;
      if (parentPhone) parentPatch.phone = parentPhone;
      if (Object.keys(parentPatch).length > 0) {
        await admin.from('parents').update(parentPatch).eq('id', parentId);
      }
    } else {
      const { data: newParent, error: pErr } = await admin
        .from('parents')
        .insert({
          // Not `|| null` - the column is NOT NULL, and the validation above has
          // already guaranteed this is a real value.
          first_name: parentFirst,
          last_name: parentLast,
          email: parentEmail,
          phone: parentPhone,
        })
        .select('id')
        .single();
      if (pErr) throw new Error(`parent: ${pErr.message}`);
      parentId = newParent!.id;
    }

    // --- Attach the parent to this org so its admins can see them ---
    const { data: rel } = await admin
      .from('parent_org_relationships')
      .select('id')
      .eq('parent_id', parentId)
      .eq('organization_id', org.id)
      .maybeSingle();
    if (!rel) {
      await admin
        .from('parent_org_relationships')
        .insert({ parent_id: parentId, organization_id: org.id });
    }

    // --- Student: reuse this parent's same-named child in this org, else create ---
    // REUSE MATTERS HERE. create-registration inserts a student unconditionally, which is
    // how one child ended up with nine rows and nine duplicate student records on one
    // class. A waitlist join is exactly the action a family repeats when unsure it worked,
    // so matching first: same org, same name, and already linked to this parent by an
    // existing registration.
    // Two plain queries rather than an embedded select: PostgREST types a nested
    // relation as an ARRAY even where it is many-to-one, so the embed only buys a cast
    // that lies about the shape. Two reads are cheaper to be sure about.
    const { data: siblingRegs } = await admin
      .from('registrations')
      .select('student_id')
      .eq('parent_id', parentId)
      .eq('organization_id', org.id);

    const knownStudentIds = [
      ...new Set(
        ((siblingRegs ?? []) as Array<{ student_id: string | null }>)
          .map((r) => r.student_id)
          .filter((id): id is string => typeof id === 'string' && !!id),
      ),
    ];

    let studentId: string | null = null;
    if (knownStudentIds.length) {
      const { data: kids } = await admin
        .from('students')
        .select('id, first_name, last_name')
        .eq('organization_id', org.id)
        .in('id', knownStudentIds);
      const wantF = childFirst.toLowerCase();
      const wantL = (childLast || '').toLowerCase();
      for (const s of (kids ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
        if (String(s.first_name ?? '').trim().toLowerCase() === wantF
            && String(s.last_name ?? '').trim().toLowerCase() === wantL) {
          studentId = s.id;
          break;
        }
      }
    }

    if (!studentId) {
      const { data: newStudent, error: sErr } = await admin
        .from('students')
        .insert({
          organization_id: org.id,
          // students.last_name is NOT NULL too - same reason as the parent insert above.
          first_name: childFirst,
          last_name: childLast,
          grade,
        })
        .select('id')
        .single();
      if (sErr) throw new Error(`student: ${sErr.message}`);
      studentId = newStudent!.id;
    }

    // --- The atomic bit ---
    // waitlist_join re-validates org / open / ours-to-sell / actually-full and assigns
    // the position under a per-program lock. Its errors are meaningful, so they are
    // translated rather than leaked: P0001 = the class has room (register instead),
    // 42501 = not a class we sell publicly.
    const { data: joined, error: joinErr } = await admin.rpc('waitlist_join', {
      p_program_id: program_id,
      p_parent_id: parentId,
      p_student_id: studentId,
      p_org_id: org.id,
    });

    if (joinErr) {
      const code = (joinErr as { code?: string }).code;
      if (code === 'P0001') {
        return json({
          error: 'Good news - a spot just opened in that class. Refresh the page and register.',
          has_room: true,
        }, 409);
      }
      if (code === '42501') {
        return json({ error: 'That class is not open for registration.' }, 400);
      }
      console.error('[join-waitlist] waitlist_join failed', { program_id, code, message: joinErr.message });
      throw new Error(`waitlist_join: ${joinErr.message}`);
    }

    // The RPC returns a one-row set.
    const row = Array.isArray(joined) ? joined[0] : joined;
    const position = row?.waitlist_position ?? null;

    console.log('[join-waitlist] joined', { program_id, position, org: org.id });

    // --- Confirmation email ---
    //
    // AFTER the join, and it CANNOT fail the join. The family's place is already
    // recorded; losing it because Resend was having a bad minute would be strictly
    // worse than a missing email, and they would have no way to tell that had happened.
    // So this is wrapped, logged loudly, and reported back as a flag rather than an
    // error - the caller shows "you are on the list" either way.
    //
    // The screen already told them their position, so it is not a lie if this does not
    // arrive. What WOULD be a lie is the screen's "we will email you if a place opens
    // up", and that promise is kept by chunk 2's invite, not by this message.
    let emailSent = false;
    try {
      const { data: prog } = await admin
        .from('programs')
        .select('curriculum, day_of_week, start_time, program_locations(name)')
        .eq('id', program_id)
        .maybeSingle();

      const brand = await loadOrgBrand(admin, org.id);
      const built = buildWaitlistConfirmation({
        brand,
        childFirstName: childFirst,
        programName: prog?.curriculum || 'the class',
        // PostgREST types an embedded relation as an array even when it is
        // many-to-one, so normalise rather than trusting either shape.
        siteName: (() => {
          const pl = (prog as { program_locations?: unknown } | null)?.program_locations;
          if (Array.isArray(pl)) return (pl[0] as { name?: string } | undefined)?.name ?? null;
          return (pl as { name?: string } | null)?.name ?? null;
        })(),
        whenText: [prog?.day_of_week, prog?.start_time].filter(Boolean).join(' '),
        position: Number(position),
      });

      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: formatFromAddress(brand),
          to: parentEmail,
          subject: built.subject,
          html: built.html,
          // BOTH halves. text is written as prose in waitlistEmail.ts, not stripped from
          // the HTML - a generated text half is how a family on a plain-text client gets
          // run-together fragments while the preview looks perfect.
          text: built.text,
          // A reply about coming off the list has to reach the PROVIDER, never the
          // platform. tenant_alert_email is the tenant's own inbox; reply_to is the
          // tenant-scoped fallback. Deliberately NOT brand.alert_email, which cascades
          // to Enrops and would send a parent's reply about their own child to us.
          reply_to: [brand.tenant_alert_email ?? brand.reply_to],
          tags: [{ name: 'type', value: 'waitlist_confirmation' }],
        }),
      });

      if (!resp.ok) {
        console.error('[join-waitlist] confirmation send failed', resp.status, await resp.text());
      } else {
        emailSent = true;
      }
    } catch (mailErr) {
      console.error('[join-waitlist] confirmation send threw', (mailErr as Error).message);
    }

    return json({
      waitlist_position: position,
      registration_id: row?.registration_id ?? null,
      parent_id: parentId,
      confirmation_email_sent: emailSent,
    });
  } catch (err) {
    console.error('join-waitlist error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
