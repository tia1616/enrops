// notify-program-families - email the families of ONE class, on purpose.
//
// The gap Jessica named: "there is no way to email just the families in one
// class - and it cost a real send today" (found 27 Aug, when the Art Rutkin FA26
// class moved a week and nine confirmed families needed one sentence).
//
// This is the general version of what notify-program-curriculum-change already
// did for one trigger. Everything reusable is shared, not re-spelled:
//   program_message_recipients   WHO (paid+enrolled, both parents, waitlist
//                                opt-in, placeholder addresses flagged)
//   _shared/familyNotify.ts      grouping to one email per (address, family),
//                                the send loop, the tally
//   _shared/orgBrand.ts          who it is from
//
// TWO MODES, and preview is the important one. Jessica's standing rule is to
// count and inspect recipients before ANY send, so the UI asks for `preview`
// first and shows exactly who would receive it - including the families it
// CANNOT reach, which is the half a send would otherwise hide.
//
// NO MONEY, NO STATUS CHANGES. This function only reads and sends. Cancelling a
// class is a separate, deliberate action that will link here rather than send
// anything itself.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
import {
  groupRecipientsByAddress,
  sendFamilyEmails,
  tallyFamilySends,
  type MessageRecipientRow,
} from '../_shared/familyNotify.ts';

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

// Same wording as the curriculum notice, so a family who gets both reads the
// class described the same way twice.
function fmtTime(t: string | null | undefined): string {
  if (!t) return '';
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, '');
  const [hh, mm] = t.split(':').map(Number);
  if (Number.isNaN(hh)) return t;
  const h12 = ((hh + 11) % 12) + 1;
  const ampm = hh >= 12 ? 'pm' : 'am';
  return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
}

function describeProgram(p: Record<string, any>): string {
  const parts: string[] = [];
  if (p?.program_locations?.name) parts.push(p.program_locations.name);
  if (p?.day_of_week) parts.push(DAY_LABELS[String(p.day_of_week).toLowerCase()] ?? p.day_of_week);
  if (p?.start_time) parts.push(fmtTime(p.start_time));
  return parts.join(' · ');
}

interface RequestBody {
  program_id?: string;
  organization_id?: string;
  include_waitlist?: boolean;
  include_cancelled?: boolean;
  subject?: string;
  body_text?: string;
  mode?: 'preview' | 'send';
  /** Set only after the operator has been told an identical send just went out. */
  confirm_duplicate?: boolean;
}

// How recently an identical send counts as an accidental repeat.
//
// A SEND IS SLOW ENOUGH TO INVITE A SECOND CLICK: it is one sequential POST per
// family, so a class of 14 takes several seconds with nothing obviously
// happening. A double click, an impatient refresh or a network retry would email
// every family in the class twice, and unlike a failed send there is no undo -
// the families already have it.
//
// Five minutes, keyed on (class + exact subject): long enough to cover a retry
// or a re-click, short enough that a genuinely intended second message later in
// the day is not blocked. Deliberately NOT a hard block - `confirm_duplicate`
// lets an operator who really does mean it through, once they have been told.
const DUPLICATE_WINDOW_MINUTES = 5;

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
    const includeWaitlist = !!body.include_waitlist;
    const includeCancelled = !!body.include_cancelled;
    const mode = body.mode === 'send' ? 'send' : 'preview';
    const subject = body.subject?.trim() ?? '';
    const bodyText = body.body_text?.trim() ?? '';

    if (!programId) return json({ error: 'program_id_required' }, 400);
    if (!orgId) return json({ error: 'organization_id_required' }, 400);
    // Only a SEND needs copy. A preview is how the operator decides whether to
    // write any, so it must work on an empty form.
    if (mode === 'send' && (!subject || !bodyText)) {
      return json({ error: 'subject_and_body_required_when_sending' }, 400);
    }

    // AUTHORISE THE CALLER MYSELF, because everything below runs on the service
    // key and the service key makes program_message_recipients skip its own
    // check. Authorising here is not belt-and-braces, it IS the gate.
    //
    // owner/admin/STAFF, deliberately wider than the curriculum notice's
    // owner/admin: staff run rosters, schedules and sends (perm.canSend), and
    // can_edit_org - the rule the recipient function itself uses - includes them.
    // Gating this at owner/admin would let staff see a class's families on the
    // roster and be unable to tell them their class moved.
    const { data: orgMember, error: omErr } = await supabase
      .from('org_members')
      .select('organization_id, role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin', 'staff'])
      .maybeSingle();
    if (omErr) {
      console.error('[notify-program-families] org_members lookup failed:', omErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!orgMember) return FORBIDDEN;

    // The class, and PROOF it belongs to that org - not an assertion. A program
    // id from another tenant must not resolve just because the caller is an
    // admin somewhere.
    const { data: program, error: pErr } = await supabase
      .from('programs')
      .select('id, curriculum, day_of_week, start_time, term, organization_id, program_locations (id, name)')
      .eq('id', programId)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (pErr) {
      console.error('[notify-program-families] program lookup failed:', pErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!program) return json({ error: 'program_not_found_in_org' }, 404);

    // WHO. Called with the service key, so the function's own authz is skipped -
    // which is why the caller was authorised above.
    const { data: rows, error: rErr } = await supabase.rpc('program_message_recipients', {
      p_program_id: programId,
      p_org_id: orgId,
      p_include_waitlist: includeWaitlist,
      p_include_cancelled: includeCancelled,
    });
    if (rErr) {
      console.error('[notify-program-families] recipients failed:', rErr);
      return json({ error: 'recipients_failed', detail: rErr.message }, 500);
    }

    const grouped = groupRecipientsByAddress((rows ?? []) as MessageRecipientRow[]);
    const programName = (program as any).curriculum ?? 'your class';
    const programSummary = describeProgram(program as any);

    if (mode === 'preview') {
      return json({
        mode: 'preview',
        program: { id: programId, name: programName, summary: programSummary },
        include_waitlist: includeWaitlist,
        include_cancelled: includeCancelled,
        // Names and addresses so the operator can COUNT and INSPECT before
        // sending, and can see which children sit behind an address.
        recipients: grouped.sendable.map((g) => ({
          email: g.email, name: g.name, children: g.student_first_name,
          child_count: g.child_count, audiences: g.audiences, kinds: g.kinds,
        })),
        // The half a send would hide. Named, not just counted, so the operator
        // can chase the school that runs its own registration for real addresses.
        unreachable: grouped.unreachable.map((g) => ({
          email: g.email, name: g.name, children: g.student_first_name,
          reason: g.unreachable_reason,
        })),
        recipient_count: grouped.sendable.length,
        unreachable_count: grouped.unreachable.length,
      });
    }

    // ── SEND ────────────────────────────────────────────────────────────────

    // DID THIS EXACT MESSAGE JUST GO OUT? Checked BEFORE anything is sent, and
    // only for sends that actually reached families ('sent' or 'partial') - a
    // previous 'no_recipients' or 'failed' attempt must not block a real retry,
    // which is the whole reason an operator would press it again.
    if (!body.confirm_duplicate) {
      const since = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60_000).toISOString();
      const { data: recent, error: dupErr } = await supabase
        .from('program_family_messages')
        // The AUDIENCE of the previous send is selected too, because the operator
        // needs it to judge. Deliberately NOT part of the match key: the groups
        // are ADDITIVE, so a second send with the waiting or refunded box newly
        // ticked still re-emails every enrolled family. Keying on the flags would
        // let that through silently; keying on subject alone catches it and lets
        // them decide with "Send it again anyway".
        .select('id, sent_at, sent_count, status, include_waitlist, include_cancelled')
        .eq('program_id', programId)
        .eq('subject', subject)
        .in('status', ['sent', 'partial'])
        .gte('sent_at', since)
        .order('sent_at', { ascending: false })
        .limit(1);
      // A FAILED LOOKUP MUST NOT BLOCK A SEND. Failing closed here would mean a
      // database hiccup silently stops a class being told their class moved,
      // which is worse than the duplicate this guard exists to prevent.
      if (dupErr) {
        console.error('[notify-program-families] duplicate check failed, allowing send:', dupErr);
      } else if (recent && recent.length > 0) {
        return json({
          error: 'duplicate_send',
          message:
            `The same message went to ${recent[0].sent_count} ` +
            `${recent[0].sent_count === 1 ? 'family' : 'families'} on this class less than ` +
            `${DUPLICATE_WINDOW_MINUTES} minutes ago` +
            // Names the audience that already received it, so an operator who
            // has just ticked a new group can tell whether the people they are
            // trying to reach were covered or not.
            `${recent[0].include_cancelled ? ', including families who had left or been refunded' : ''}` +
            `${recent[0].include_waitlist ? ', including the waiting list' : ''}` +
            '. Sending again will email everyone on the list above a second time.',
          previous: recent[0],
        }, 409);
      }
    }

    const brand = await loadOrgBrand(supabase, orgId);
    const fromAddress = formatFromAddress(brand);

    // NOBODY REACHABLE IS NOT A SEND. Recorded with its own status rather than
    // as a successful send of zero emails, because "sent" against 0 recipients
    // is the shape that lets a class go un-notified while the log looks fine.
    if (grouped.sendable.length === 0) {
      await supabase.from('program_family_messages').insert({
        organization_id: orgId,
        program_id: programId,
        sent_by_user_id: callerAuthId,
        subject,
        body_text: bodyText,
        include_waitlist: includeWaitlist,
        include_cancelled: includeCancelled,
        recipient_count: 0,
        sent_count: 0,
        failed_count: 0,
        status: 'no_recipients',
        // Same shape as the sent path: every element states its own status.
        recipients: grouped.unreachable.map((g) => ({
          parent_id: g.parent_id,
          name: g.name,
          email: g.email,
          resend_message_id: null,
          status: 'not_attempted',
          failure_reason: g.unreachable_reason,
        })),
      });
      return json({
        mode: 'send', status: 'no_recipients',
        sent: 0, failed: 0,
        unreachable_count: grouped.unreachable.length,
      });
    }

    const results = await sendFamilyEmails({
      recipients: grouped.sendable.map((g) => ({
        parent_id: g.parent_id,
        name: g.name,
        email: g.email,
        student_first_name: g.student_first_name,
      })),
      subject,
      bodyText,
      vars: {
        program_name: programName,
        program_summary: programSummary,
        program_day: (program as any).day_of_week
          ? (DAY_LABELS[String((program as any).day_of_week).toLowerCase()] ?? (program as any).day_of_week)
          : '',
        program_location: (program as any).program_locations?.name ?? '',
        org_name: brand.org_name,
      },
      from: fromAddress,
      replyTo: brand.reply_to,
      apiKey: RESEND_API_KEY,
      // `type` names the SENDER so a bounce can be traced back to this surface
      // rather than to the curriculum notice, which uses the same loop.
      tags: [
        { name: 'type', value: 'program_family_message' },
        { name: 'program_id', value: programId },
      ],
    });

    const tally = tallyFamilySends(results);
    const status = tally.failed === 0 ? 'sent' : tally.sent === 0 ? 'failed' : 'partial';

    // The audit row carries the PER-RECIPIENT outcome, plus the families that
    // were never attempted. A row-level status only says whether ANYONE got it.
    const { error: auditErr } = await supabase.from('program_family_messages').insert({
      organization_id: orgId,
      program_id: programId,
      sent_by_user_id: callerAuthId,
      subject,
      body_text: bodyText,
      include_waitlist: includeWaitlist,
      include_cancelled: includeCancelled,
      recipient_count: tally.total,
      sent_count: tally.sent,
      failed_count: tally.failed,
      status,
      // EVERY element carries a `status`, including the families that were never
      // attempted. Mixed shapes in one jsonb column is how a reader concludes a
      // row with no status "probably sent" - so an unreachable family is
      // explicitly not_attempted rather than merely lacking the field.
      recipients: [
        ...results,
        ...grouped.unreachable.map((g) => ({
          parent_id: g.parent_id,
          name: g.name,
          email: g.email,
          resend_message_id: null,
          status: 'not_attempted',
          failure_reason: g.unreachable_reason,
        })),
      ],
    });
    // The emails have ALREADY gone. A failed audit write must not be reported as
    // a failed send - it is logged loudly and the true outcome is returned, or
    // an operator would send the whole class a second copy.
    if (auditErr) console.error('[notify-program-families] audit insert failed:', auditErr);

    return json({
      mode: 'send',
      status,
      sent: tally.sent,
      failed: tally.failed,
      unreachable_count: grouped.unreachable.length,
      audit_recorded: !auditErr,
      results,
    });
  } catch (err) {
    console.error('[notify-program-families] unhandled:', err);
    return json({ error: 'unexpected', detail: (err as Error)?.message ?? String(err) }, 500);
  }
});
