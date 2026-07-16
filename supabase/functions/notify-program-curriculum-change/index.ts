// notify-program-curriculum-change — atomic curriculum swap + notification
// fan-out for EditProgramCurriculumModal.
//
// Owns three things together so they can't drift:
//   1. UPDATE programs SET curriculum_id, curriculum
//   2. Resend send to every non-cancelled registered family (if opted in)
//   3. Resend send to the program's confirmed instructor (if opted in and
//      the instructor was already informed about this program — i.e.
//      program_assignments.email_sent_at IS NOT NULL)
//   4. INSERT program_curriculum_changes audit row capturing who/when/
//      from/to/which-channels-fired/per-recipient-results.
//
// Why one function: the DB write must commit BEFORE the emails go out
// (so the program record is accurate by the time families read the note),
// but the audit row needs the email results, so the whole thing is one
// transaction-ish handoff. If emails partially fail the DB write still
// stands and the audit row records the failure for retry visibility.
//
// Input:
// {
//   program_id: uuid,
//   organization_id: uuid,
//   to_curriculum_id: uuid,
//   to_curriculum_name: string,        // snapshot for both programs.curriculum AND audit
//   from_curriculum_id?: uuid|null,    // IGNORED — read from the program row
//   from_curriculum_name?: string|null,// IGNORED — read from the program row
//   family: {
//     send: boolean,
//     subject: string,                 // supports {parent_first_name}, {student_first_name}, {from_curriculum}, {to_curriculum}, {program_summary}, {org_name}
//     body_text: string,               // same placeholder set
//   },
//   instructor: {
//     send: boolean,
//     subject: string,                 // supports {instructor_first_name}, {from_curriculum}, {to_curriculum}, {program_summary}, {org_name}
//     body_text: string,               // same placeholder set
//   }
// }
//
// Auth: caller JWT must belong to org_members with role owner|admin for
// the program's organization. Tenant safety: program must belong to that
// org too.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

const DAY_LABELS: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

function fmtTime(t: string | null | undefined): string {
  if (!t) return '';
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, '');
  const [hh, mm] = t.split(':').map(Number);
  if (Number.isNaN(hh)) return t;
  const h12 = ((hh + 11) % 12) + 1;
  const ampm = hh >= 12 ? 'pm' : 'am';
  return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
}

function describeProgram(p: any): string {
  const parts: string[] = [];
  if (p.program_locations?.name) parts.push(p.program_locations.name);
  if (p.day_of_week) parts.push(DAY_LABELS[p.day_of_week.toLowerCase()] ?? p.day_of_week);
  if (p.start_time) parts.push(fmtTime(p.start_time));
  return parts.join(' · ');
}

// Replace {key} occurrences with values. Keys missing from `vars` are
// left as-is (admin's template wins — we don't silently strip unknown
// placeholders, so typos like {Parent_First_Name} are visible to the
// recipient and easy to spot in the audit log).
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

interface RequestBody {
  program_id?: string;
  organization_id?: string;
  to_curriculum_id?: string;
  to_curriculum_name?: string;
  from_curriculum_id?: string | null;
  from_curriculum_name?: string | null;
  family?: { send?: boolean; subject?: string; body_text?: string };
  instructor?: { send?: boolean; subject?: string; body_text?: string };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const programId = body.program_id?.trim();
    const orgId = body.organization_id?.trim();
    const toCurriculumId = body.to_curriculum_id?.trim();
    const toCurriculumName = body.to_curriculum_name?.trim();
    // NOTE: body.from_curriculum_id / from_curriculum_name are accepted for
    // backwards compatibility but deliberately IGNORED — the from-state is
    // read off the program row below, which is the only trustworthy source.
    const family = {
      send: !!body.family?.send,
      subject: body.family?.subject?.trim() ?? '',
      body_text: body.family?.body_text?.trim() ?? '',
    };
    const instructor = {
      send: !!body.instructor?.send,
      subject: body.instructor?.subject?.trim() ?? '',
      body_text: body.instructor?.body_text?.trim() ?? '',
    };

    if (!programId) return json({ error: 'program_id_required' }, 400);
    if (!orgId) return json({ error: 'organization_id_required' }, 400);
    if (!toCurriculumId) return json({ error: 'to_curriculum_id_required' }, 400);
    if (!toCurriculumName) return json({ error: 'to_curriculum_name_required' }, 400);
    if (family.send && (!family.subject || !family.body_text)) {
      return json({ error: 'family_subject_and_body_required_when_sending' }, 400);
    }
    if (instructor.send && (!instructor.subject || !instructor.body_text)) {
      return json({ error: 'instructor_subject_and_body_required_when_sending' }, 400);
    }

    // ── Authorize caller as admin/owner in the org. ──────────────────────
    const { data: orgMember, error: omErr } = await supabase
      .from('org_members')
      .select('organization_id')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .maybeSingle();
    if (omErr) {
      console.error('org_members lookup failed:', omErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!orgMember) return FORBIDDEN;

    // ── Load program + verify org match. ─────────────────────────────────
    const { data: program, error: progErr } = await supabase
      .from('programs')
      .select(`
        id, organization_id, curriculum, curriculum_id,
        day_of_week, start_time, end_time,
        program_locations (id, name)
      `)
      .eq('id', programId)
      .maybeSingle();
    if (progErr) {
      console.error('program lookup failed:', progErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!program) return json({ error: 'program_not_found' }, 404);
    if (program.organization_id !== orgId) return FORBIDDEN;

    // Verify the target curriculum is real and belongs to the same org.
    const { data: targetCurriculum, error: curErr } = await supabase
      .from('curricula')
      .select('id, name, organization_id')
      .eq('id', toCurriculumId)
      .maybeSingle();
    if (curErr || !targetCurriculum) return json({ error: 'curriculum_not_found' }, 404);
    if (targetCurriculum.organization_id !== orgId) return FORBIDDEN;

    // ── First-time match can never notify. ───────────────────────────────
    // If the program has no curriculum yet, nothing is changing for anyone:
    // the notes are all worded as a change ("changing from X to Y") and the
    // family note offers a refund. Sending that for a class that never
    // changed would be false and would invite needless refund requests.
    // Guard on the DB's curriculum_id, NOT the caller's from_curriculum_id —
    // a stale tab could claim a previous class that isn't there.
    const isFirstMatch = !program.curriculum_id;
    if (isFirstMatch) {
      family.send = false;
      instructor.send = false;
    }

    // The single source of truth for "what was this before" — used for both
    // the email templates and the audit row.
    const fromCurriculumId: string | null = program.curriculum_id ?? null;
    const fromCurriculumName: string | null = program.curriculum ?? null;

    // ── Load brand context for sender identity. ──────────────────────────
    const brand = await loadOrgBrand(supabase, orgId);
    const fromAddress = formatFromAddress(brand);
    const programSummary = describeProgram(program) || 'your child\'s class';
    const programDay = program.day_of_week
      ? (DAY_LABELS[program.day_of_week.toLowerCase()] ?? program.day_of_week)
      : 'weekly';
    const programLocation = (program as any).program_locations?.name ?? 'your school';

    // ── Load registrations + parents (for family fan-out). ───────────────
    // Per the prompt: every non-cancelled registration on this program.
    // We send one email per parent (deduped by parent_id — a family with
    // two students on the same program gets one note, not two).
    let familyRecipients: Array<{
      parent_id: string;
      name: string;
      email: string;
      student_first_name: string;
    }> = [];
    if (family.send) {
      // Explicit organization_id filter even though we already verified
      // the program belongs to orgId — service-role client bypasses RLS,
      // so a defense-in-depth filter catches any future schema drift
      // where a registration could be linked to a program in another org.
      const { data: regs, error: regErr } = await supabase
        .from('registrations')
        .select(`
          id, status,
          student:students ( id, first_name ),
          parent:parents ( id, first_name, last_name, email )
        `)
        .eq('program_id', programId)
        .eq('organization_id', orgId)
        .neq('status', 'cancelled');
      if (regErr) {
        console.error('registrations lookup failed:', regErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      const seenParents = new Set<string>();
      for (const r of regs ?? []) {
        const p: any = (r as any).parent;
        const s: any = (r as any).student;
        if (!p?.id || !p.email) continue;
        if (seenParents.has(p.id)) continue;
        seenParents.add(p.id);
        familyRecipients.push({
          parent_id: p.id,
          name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '(no name)',
          email: String(p.email).trim().toLowerCase(),
          student_first_name: s?.first_name ?? 'your child',
        });
      }
    }

    // ── Load instructor (for instructor send). ───────────────────────────
    // Per the prompt: program_assignments with status in confirmed|published
    // AND email_sent_at IS NOT NULL — i.e. instructor was already told
    // about this program, so they need to hear about the change too.
    // Multi-lead case (rare): we notify the first match and log the others;
    // the audit row's instructor_recipient is singleton by schema choice.
    let instructorRecipient: { instructor_id: string; first_name: string; name: string; email: string } | null = null;
    let extraInstructorCount = 0;
    if (instructor.send) {
      const { data: asgs, error: asgErr } = await supabase
        .from('program_assignments')
        .select(`
          id, status, email_sent_at,
          instructor:instructors ( id, first_name, last_name, preferred_name, email )
        `)
        .eq('program_id', programId)
        .eq('organization_id', orgId)
        .in('status', ['confirmed', 'published'])
        .not('email_sent_at', 'is', null);
      if (asgErr) {
        console.error('program_assignments lookup failed:', asgErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      const matches = (asgs ?? []).filter((a: any) => a.instructor?.email);
      if (matches.length > 1) {
        extraInstructorCount = matches.length - 1;
        console.warn(`program ${programId} has ${matches.length} eligible instructors; notifying only the first.`);
      }
      const first: any = matches[0];
      if (first) {
        const i = first.instructor;
        instructorRecipient = {
          instructor_id: i.id,
          first_name: i.preferred_name || i.first_name || 'there',
          name: `${i.first_name ?? ''} ${i.last_name ?? ''}`.trim() || '(no name)',
          email: String(i.email).trim().toLowerCase(),
        };
      }
    }

    // ── Resolve per-channel notify choice for the audit row. ─────────────
    // On a first match we short-circuited the sends, so the recipient lists
    // were never loaded — an empty list here does NOT mean there was nobody
    // to tell. Record 'skipped' (we chose not to send) rather than
    // 'no_recipients', which would be a false claim about enrollment.
    const familyChoice: 'sent' | 'skipped' | 'no_recipients' =
      isFirstMatch
        ? 'skipped'
        : !family.send
          ? (familyRecipients.length === 0 ? 'no_recipients' : 'skipped')
          : (familyRecipients.length === 0 ? 'no_recipients' : 'sent');
    const instructorChoice: 'sent' | 'skipped' | 'no_recipient' =
      isFirstMatch
        ? 'skipped'
        : !instructor.send
          ? (instructorRecipient ? 'skipped' : 'no_recipient')
          : (instructorRecipient ? 'sent' : 'no_recipient');

    // ── Commit the DB write FIRST. Emails go out only against a real
    //    updated record so families/instructors reading at the same time
    //    see consistent state in their portals.
    const { error: upErr } = await supabase
      .from('programs')
      .update({
        curriculum_id: toCurriculumId,
        curriculum: toCurriculumName,
      })
      .eq('id', programId)
      .eq('organization_id', orgId);
    if (upErr) {
      console.error('programs update failed:', upErr);
      return json({ error: 'curriculum_save_failed', detail: upErr.message }, 500);
    }

    // ── Send family emails (one per recipient — no cross-disclosure). ────
    const familyResults: Array<{
      parent_id: string;
      name: string;
      email: string;
      resend_message_id: string | null;
      status: 'sent' | 'failed';
      failure_reason: string | null;
    }> = [];

    if (familyChoice === 'sent') {
      for (const r of familyRecipients) {
        const vars: Record<string, string> = {
          parent_first_name: r.name.split(' ')[0] || 'there',
          student_first_name: r.student_first_name || 'your child',
          program_day: programDay,
          program_location: programLocation,
          program_summary: programSummary,
          from_curriculum: fromCurriculumName ?? 'the current class',
          to_curriculum: toCurriculumName,
          org_name: brand.org_name,
          reply_to_email: brand.reply_to,
        };
        const subject = substitute(family.subject, vars);
        const text = substitute(family.body_text, vars);
        try {
          const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: fromAddress,
              to: r.email,
              reply_to: brand.reply_to ? [brand.reply_to] : undefined,
              subject,
              text,
              tags: [
                { name: 'type', value: 'program_curriculum_change_family' },
                { name: 'program_id', value: programId },
              ],
            }),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            familyResults.push({
              parent_id: r.parent_id,
              name: r.name,
              email: r.email,
              resend_message_id: null,
              status: 'failed',
              failure_reason: `resend ${resp.status}: ${errText.slice(0, 200)}`,
            });
            continue;
          }
          const data = await resp.json().catch(() => ({}));
          familyResults.push({
            parent_id: r.parent_id,
            name: r.name,
            email: r.email,
            resend_message_id: data?.id ?? null,
            status: 'sent',
            failure_reason: null,
          });
        } catch (err) {
          familyResults.push({
            parent_id: r.parent_id,
            name: r.name,
            email: r.email,
            resend_message_id: null,
            status: 'failed',
            failure_reason: (err as Error).message,
          });
        }
      }
    }

    // ── Send instructor email. ───────────────────────────────────────────
    let instructorResult: {
      instructor_id: string;
      name: string;
      email: string;
      resend_message_id: string | null;
      status: 'sent' | 'failed';
      failure_reason: string | null;
    } | null = null;

    if (instructorChoice === 'sent' && instructorRecipient) {
      const vars: Record<string, string> = {
        instructor_first_name: instructorRecipient.first_name,
        program_day: programDay,
        program_location: programLocation,
        program_summary: programSummary,
        from_curriculum: fromCurriculumName ?? 'the current class',
        to_curriculum: toCurriculumName,
        org_name: brand.org_name,
        reply_to_email: brand.reply_to,
      };
      const subject = substitute(instructor.subject, vars);
      const text = substitute(instructor.body_text, vars);
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: fromAddress,
            to: instructorRecipient.email,
            reply_to: brand.reply_to ? [brand.reply_to] : undefined,
            subject,
            text,
            tags: [
              { name: 'type', value: 'program_curriculum_change_instructor' },
              { name: 'program_id', value: programId },
            ],
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          instructorResult = {
            instructor_id: instructorRecipient.instructor_id,
            name: instructorRecipient.name,
            email: instructorRecipient.email,
            resend_message_id: null,
            status: 'failed',
            failure_reason: `resend ${resp.status}: ${errText.slice(0, 200)}`,
          };
        } else {
          const data = await resp.json().catch(() => ({}));
          instructorResult = {
            instructor_id: instructorRecipient.instructor_id,
            name: instructorRecipient.name,
            email: instructorRecipient.email,
            resend_message_id: data?.id ?? null,
            status: 'sent',
            failure_reason: null,
          };
        }
      } catch (err) {
        instructorResult = {
          instructor_id: instructorRecipient.instructor_id,
          name: instructorRecipient.name,
          email: instructorRecipient.email,
          resend_message_id: null,
          status: 'failed',
          failure_reason: (err as Error).message,
        };
      }
    }

    // ── Insert audit row. Failures here are logged but don't fail the
    //    user-facing request — losing the audit row is worse than telling
    //    the admin "send failed" when their emails actually went out.
    const familySentCount = familyResults.filter((r) => r.status === 'sent').length;
    const familyFailedCount = familyResults.filter((r) => r.status === 'failed').length;

    const { error: auditErr } = await supabase
      .from('program_curriculum_changes')
      .insert({
        organization_id: orgId,
        program_id: programId,
        changed_by_user_id: callerAuthId,
        from_curriculum_id: fromCurriculumId,
        from_curriculum_name: fromCurriculumName,
        to_curriculum_id: toCurriculumId,
        to_curriculum_name: toCurriculumName,
        family_notify_choice: familyChoice,
        instructor_notify_choice: instructorChoice,
        family_recipients: familyResults,
        family_sent_count: familySentCount,
        family_failed_count: familyFailedCount,
        instructor_recipient: instructorResult,
      });
    if (auditErr) {
      console.error('audit insert failed:', auditErr);
      // Continue — don't fail the request for an audit row.
    }

    return json({
      curriculum_saved: true,
      family: {
        choice: familyChoice,
        sent_count: familySentCount,
        failed_count: familyFailedCount,
        failures: familyResults.filter((r) => r.status === 'failed'),
      },
      instructor: {
        choice: instructorChoice,
        sent: instructorResult?.status === 'sent',
        failure_reason: instructorResult?.failure_reason ?? null,
        extra_eligible_not_notified: extraInstructorCount,
      },
    });
  } catch (err) {
    console.error('notify-program-curriculum-change fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});
