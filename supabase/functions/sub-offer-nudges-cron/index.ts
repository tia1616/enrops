// sub-offer-nudges-cron: runs daily. Chases a sub class-day nobody has answered.
//
// WHY IT EXISTS. Jessica sent 10 real offers across 2 class-days and asked how
// she would know if nobody replied. Nothing chased. The day sat in the calm
// "offers out" state until it arrived, and silence looked exactly like progress.
//
// THE LADDER (defined once, in _shared/subNudgeStages.ts, which has the tests):
//   T-8  instructors   still looking
//   T-7  provider      nobody has answered yet
//   T-4  instructors   second ask
//   T-3  provider      still nobody - a decision now, not a reminder
//
// Instructors are always chased a day BEFORE the provider hears anything, so
// the people who can actually solve it get a head start. Everything stops the
// moment somebody accepts, because the day then has a settled row and drops out
// of the query entirely.
//
// GATED, AND OFF BY DEFAULT. organizations.sub_nudges_enabled is FALSE for every
// tenant until somebody flips it. This function cannot email anybody in an org
// that has not been switched on.
//
// IDEMPOTENT BY THE DATABASE, not by this code. A row in sub_offer_nudges is
// CLAIMED before any email goes, under a unique index on
// (class-day, stage) - so two runs in the same minute, or a retry after a
// timeout, cannot both send. The claim is updated with what actually went.
//
// Input: { dry_run?: boolean, organization_id?: string }
//   dry_run  - returns exactly what WOULD be sent, writes nothing, emails nobody
//   organization_id - confine a manual run to one tenant
// Trigger: pg_cron daily. verify_jwt stays TRUE, matching offer-reminders-cron,
// and the cron posts the anon key.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
import { stageForDaysOut, daysBetween, allNudgeDaysOut } from '../_shared/subNudgeStages.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function esc(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d: string) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Slot {
  organization_id: string;
  parent_assignment_id: string;
  parent_assignment_type: string;
  date: string;
  stage: string;
  audience: 'instructors' | 'provider';
  people: Array<{ id: string; email: string; name: string }>;
  /** How many are still deciding, counted BEFORE addresses are resolved. */
  expected: number;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    let dryRun = false;
    let scopeOrg: string | null = null;
    if (req.method === 'POST') {
      try {
        const b = await req.json();
        dryRun = b?.dry_run === true;
        scopeOrg = (b?.organization_id || '').toString().trim() || null;
      } catch { /* empty body is the nightly cron */ }
    }

    // Typed as SupabaseClient, not left to inference: a bare createClient with
    // no schema generic resolves to a client that knows no tables, and every
    // .from() below then fails to type. Same shape adminClient() returns.
    const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const today = todayIso();
    const targetDates = allNudgeDaysOut().map((n) => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    });

    // ── orgs that have been switched on ──
    let orgQ = supabase.from('organizations')
      .select('id, name, slug, alert_email, sub_nudges_enabled')
      .eq('sub_nudges_enabled', true);
    if (scopeOrg) orgQ = orgQ.eq('id', scopeOrg);
    const { data: orgs, error: orgErr } = await orgQ;
    if (orgErr) {
      console.error('[sub-offer-nudges-cron] org lookup failed:', orgErr);
      return json({ error: 'org_lookup_failed', detail: orgErr.message }, 500);
    }
    if (!orgs || orgs.length === 0) {
      return json({ ok: true, dry_run: dryRun, today, orgs_enabled: 0, slots: [], sent: 0 });
    }
    const orgIds = orgs.map((o) => o.id);

    // ── every live offer on a threshold date ──
    // Only rows whose email ACTUALLY left: a row written before a failed send
    // belongs to somebody who has never heard of the class, and chasing them
    // about it would be the first they knew.
    const { data: rows, error: rowErr } = await supabase
      .from('assignment_substitutions')
      .select('id, organization_id, parent_assignment_id, parent_assignment_type, date, status, sub_instructor_id, email_sent_at')
      .in('organization_id', orgIds)
      .in('date', targetDates);
    if (rowErr) {
      console.error('[sub-offer-nudges-cron] offer lookup failed:', rowErr);
      return json({ error: 'offer_lookup_failed', detail: rowErr.message }, 500);
    }

    // ── group into class-days, and drop any that are settled ──
    const key = (r: { parent_assignment_id: string; parent_assignment_type: string; date: string }) =>
      `${r.parent_assignment_id}|${r.parent_assignment_type}|${r.date}`;
    const settled = new Set<string>();
    const pendingBySlot = new Map<string, typeof rows>();
    for (const r of rows ?? []) {
      if (r.status === 'confirmed' || r.status === 'taught') { settled.add(key(r)); continue; }
      if (r.status !== 'pending' || !r.email_sent_at) continue;
      const k = key(r);
      const list = pendingBySlot.get(k) ?? [];
      list.push(r);
      pendingBySlot.set(k, list);
    }

    // ── who, and at which stage ──
    const instructorIds = new Set<string>();
    const slots: Slot[] = [];
    for (const [k, list] of pendingBySlot) {
      if (settled.has(k)) continue;           // somebody accepted: nothing to chase
      const first = list[0];
      const spec = stageForDaysOut(daysBetween(today, first.date));
      if (!spec) continue;
      slots.push({
        organization_id: first.organization_id,
        parent_assignment_id: first.parent_assignment_id,
        parent_assignment_type: first.parent_assignment_type,
        date: first.date,
        stage: spec.stage,
        audience: spec.audience,
        people: [],
        expected: 0,
      });
      for (const r of list) if (r.sub_instructor_id) instructorIds.add(r.sub_instructor_id);
    }
    if (slots.length === 0) {
      return json({ ok: true, dry_run: dryRun, today, orgs_enabled: orgs.length, slots: [], sent: 0 });
    }

    // ── names and addresses for everyone still deciding ──
    // The error is CHECKED, not discarded. If this lookup fails, every slot
    // resolves to zero people, every instructor stage claims its row and sends
    // nothing, and - because a claimed stage is never revisited - those people
    // are never chased at all. A silent failure here is indistinguishable from
    // "nobody to tell", so it must stop the run instead of proceeding.
    const { data: people, error: peopleErr } = await supabase
      .from('instructors')
      .select('id, first_name, last_name, preferred_name, email')
      .in('id', Array.from(instructorIds));
    if (peopleErr) {
      console.error('[sub-offer-nudges-cron] instructor lookup failed:', peopleErr);
      return json({ error: 'instructor_lookup_failed', detail: peopleErr.message }, 500);
    }
    const byInstructor = new Map((people ?? []).map((p) => [p.id, p]));
    for (const s of slots) {
      const list = pendingBySlot.get(`${s.parent_assignment_id}|${s.parent_assignment_type}|${s.date}`) ?? [];
      for (const r of list) {
        // Counted whether or not we can reach them, so that "5 were asked and
        // we could only mail 3" is recorded as a failure rather than rounding
        // itself away into a tidy-looking two-person nudge.
        if (r.sub_instructor_id) s.expected++;
        const p = r.sub_instructor_id ? byInstructor.get(r.sub_instructor_id) : null;
        if (p?.email) {
          s.people.push({
            id: p.id,
            email: p.email,
            name: p.preferred_name || p.first_name || 'there',
          });
        }
      }
    }

    // ── already chased at this stage? ──
    // Checked for the same reason: a swallowed error here empties `chased`, so
    // every already-done stage re-qualifies. The unique index would refuse the
    // duplicate claim and nothing would double-send, but the run would then be
    // reporting work it did not do.
    // `recipients` is selected because two different questions are asked of
    // this log below, and only one of them is about the row existing.
    const { data: already, error: alreadyErr } = await supabase
      .from('sub_offer_nudges')
      .select('parent_assignment_id, parent_assignment_type, date, stage, recipients')
      .in('organization_id', orgIds)
      .in('date', targetDates);
    // Logged, NOT fatal. This lookup is not what prevents a double send - the
    // unique index is, and a duplicate claim is refused by the database no
    // matter what this returns. Aborting the run over it would cost every
    // tenant their rung for the day, and on an exact-day ladder a missed rung
    // is not retried tomorrow: tomorrow is a different rung. Degrading costs
    // some refused inserts and a reminder sentence left out, both harmless.
    if (alreadyErr) {
      console.error('[sub-offer-nudges-cron] nudge-log lookup failed, continuing:', alreadyErr);
    }
    const chased = new Set((already ?? []).map((n) =>
      `${n.parent_assignment_id}|${n.parent_assignment_type}|${n.date}|${n.stage}`));
    // DELIVERED, not merely attempted. A stage is claimed BEFORE its emails go,
    // so a row exists even when every one of those sends failed - which is the
    // exact state the failure-recording above is built to capture. Telling a
    // provider "we sent them a reminder yesterday" on the strength of a row
    // that reached nobody would be the false sentence this was meant to avoid.
    const reachedSomeone = new Set((already ?? [])
      .filter((n) => ((n as { recipients?: number }).recipients ?? 0) > 0)
      .map((n) => `${n.parent_assignment_id}|${n.parent_assignment_type}|${n.date}|${n.stage}`));
    const due = slots.filter((s) =>
      !chased.has(`${s.parent_assignment_id}|${s.parent_assignment_type}|${s.date}|${s.stage}`));

    if (dryRun) {
      // COUNTS, NEVER ADDRESSES. verify_jwt is satisfied by the anon key, which
      // ships in every browser bundle, and this function has no caller-identity
      // check of its own - so anything returned here is readable by anybody who
      // can guess an organisation id. Returning instructor emails and the
      // provider's alert address would hand over a tenant's roster to a
      // stranger. The sibling offer-reminders-cron answers with ids and reasons
      // for the same reason; counts are enough to verify a run.
      return json({
        ok: true, dry_run: true, today, orgs_enabled: orgs.length,
        would_send: due.map((s) => ({
          date: s.date, stage: s.stage, audience: s.audience,
          recipient_count: s.audience === 'provider'
            ? (orgs.find((o) => o.id === s.organization_id)?.alert_email ? 1 : 0)
            : s.people.length,
          still_deciding: s.expected,
        })),
        sent: 0,
      });
    }

    // ── send ──
    let sent = 0;
    const results: Array<Record<string, unknown>> = [];
    for (const s of due) {
      const org = orgs.find((o) => o.id === s.organization_id);
      if (!org) continue;

      // CLAIM FIRST. The unique index makes this the lock: if another run beat
      // us to this stage the insert fails and we skip, rather than both sending.
      const { data: claim, error: claimErr } = await supabase
        .from('sub_offer_nudges')
        .insert({
          organization_id: s.organization_id,
          parent_assignment_id: s.parent_assignment_id,
          parent_assignment_type: s.parent_assignment_type,
          date: s.date, stage: s.stage,
        })
        .select('id')
        .single();
      if (claimErr || !claim) {
        // 23505 = somebody else claimed it. Anything else is worth seeing.
        if ((claimErr as { code?: string } | null)?.code !== '23505') {
          console.error('[sub-offer-nudges-cron] claim failed:', claimErr, s);
        }
        continue;
      }

      let recipients = 0;
      let attempted = 0;
      let errText: string | null = null;

      // EVERYTHING between the claim and the completion is inside this try.
      // These lookups are network calls: a DNS failure or a timeout THROWS
      // rather than returning an error object, and before this the throw
      // escaped to the outer catch - abandoning the loop, so every LATER
      // class-day in the run went unchased, in silence, while this one kept a
      // claimed row that could never be retried.
      try {
        const ctx = await classContext(supabase, s.parent_assignment_type, s.parent_assignment_id);
        const brand = await loadOrgBrand(supabase, s.organization_id);
        const from = formatFromAddress(brand);
        const when = fmtDate(s.date);
        const what = ctx.curriculum || 'a class';
        const where = ctx.location ? ` at ${ctx.location}` : '';
        const portal = org.slug ? `${PUBLIC_SITE_URL}/${org.slug}/instructor` : PUBLIC_SITE_URL;
        const board = `${PUBLIC_SITE_URL}/admin/schedule`;

        if (s.audience === 'instructors') {
          const second = s.stage === 'instructor_2';
          for (const p of s.people) {
            const lines = second
              ? [`We still haven't found cover for ${what}${where} on ${when}, and it's getting close.`,
                 `If you can take it, open your portal and accept. If you can't, decline so we stop asking.`]
              : [`Just a nudge: we're still looking for cover for ${what}${where} on ${when}.`,
                 `If you can do it, open your portal and accept. If not, decline and we'll ask elsewhere.`];
            // Per-person, so one unreachable address cannot cost the people
            // after it in the list their only nudge. The stage is claimed
            // already; whoever is skipped here is skipped for good.
            attempted++;
            try {
              const ok = await send(from, p.email, brand.tenant_reply_to ?? undefined,
                second ? `Still need cover: ${when.replace(/^[A-Za-z]+, /, '')}`
                       : `Still looking for cover: ${when.replace(/^[A-Za-z]+, /, '')}`,
                shell(p.name, lines, portal, 'Open your portal', org.name));
              if (ok) recipients++;
            } catch (e) {
              console.error('[sub-offer-nudges-cron] send threw for one instructor:', e, s.date);
            }
          }
        } else {
          const to = org.alert_email;
          if (!to) { errText = 'org has no alert_email'; }
          else {
            const second = s.stage === 'provider_2';
            const n = s.people.length;
            const who = n === 1 ? '1 person has' : `${n} people have`;
            // Only claim the reminder went if the log says it did. The ladder
            // puts an instructor nudge the day before each provider email, but
            // nothing GUARANTEES it ran: offers sent seven days out skip the
            // T-8 rung entirely, and a tenant switched on mid-ladder has no
            // earlier rung either. Asserting it anyway would put a sentence she
            // can see is false into the first email she reads.
            const reminded = reachedSomeone.has(
              `${s.parent_assignment_id}|${s.parent_assignment_type}|${s.date}|` +
              `${second ? 'instructor_2' : 'instructor_1'}`);
            const nudgedLine = reminded ? ' We sent them a reminder yesterday.' : '';
            const lines = second
              ? [`${what}${where} on ${when} still has nobody covering it, and it's 3 days away.`,
                 `${who} been asked and nobody has answered.${nudgedLine} At this range it's worth deciding: chase them directly, ask somebody else, or cover it yourself.`]
              : [`Nobody has answered yet for ${what}${where} on ${when}.`,
                 `${who} been asked.${nudgedLine} Nothing needs doing yet - this is so it doesn't go quiet on you.`];
            // Counted BEFORE the call and wrapped, exactly as the instructor
            // path is. send() can throw now that it has a timeout, and counting
            // afterwards would drop this attempt from the tally entirely.
            attempted++;
            try {
              const ok = await send(from, to, brand.tenant_reply_to ?? undefined,
                second ? `Still no sub for ${when.replace(/^[A-Za-z]+, /, '')}`
                       : `No reply yet on ${when.replace(/^[A-Za-z]+, /, '')}`,
                shell('there', lines, board, 'Open the schedule', org.name));
              if (ok) recipients++;
            } catch (e) {
              console.error('[sub-offer-nudges-cron] provider send threw:', e, s.date);
            }
          }
        }
      } catch (e) {
        errText = (e as Error).message;
        console.error('[sub-offer-nudges-cron] send threw:', e, s);
      }

      // A send that FAILED must not read like a send that found nobody to make.
      // Resend rejecting an address leaves recipients short of attempted, and a
      // row saying `recipients: 0, error: null` would be the log quietly
      // claiming the nudge went out.
      // Every way this stage can have fallen short of the people it was for,
      // recorded together rather than first-one-wins. These are not mutually
      // exclusive - a stage can both fail to reach some addresses and have
      // others rejected - and whichever got skipped would have been the half
      // nobody found out about.
      const problems: string[] = [];
      if (errText) problems.push(errText);
      if (recipients < attempted) {
        problems.push(`${attempted - recipients} of ${attempted} messages were not delivered`);
      }
      // Counted against WHO WAS SUPPOSED TO BE CHASED, not against who we
      // managed to look up. The previous shape of this check only fired when
      // nobody at all resolved, so the commoner case - one stale address out of
      // five - wrote a tidy row claiming four successes and no problem, while a
      // real person waited to be asked and never was.
      if (s.audience === 'instructors' && s.expected > s.people.length) {
        problems.push(
          `${s.expected - s.people.length} of ${s.expected} still deciding had no usable email address`);
      }
      errText = problems.length ? problems.join('; ') : null;
      const { error: doneErr } = await supabase.from('sub_offer_nudges')
        .update({ recipients, error_text: errText, completed_at: new Date().toISOString() })
        .eq('id', (claim as { id: string }).id);
      // Checked, because the alternative is a row frozen in the claim's own
      // shape - no completed_at, no error - which reads as "still in flight"
      // forever even though the emails really went. It cannot be retried (the
      // claim holds the unique index), so the log must at least say so.
      if (doneErr) {
        console.error('[sub-offer-nudges-cron] completion update failed; emails DID go:',
          doneErr, { date: s.date, stage: s.stage, recipients });
      }

      sent += recipients;
      results.push({ date: s.date, stage: s.stage, audience: s.audience, recipients, error: errText });
    }

    return json({ ok: true, dry_run: false, today, orgs_enabled: orgs.length, sent, results });
  } catch (err) {
    console.error('[sub-offer-nudges-cron] fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

async function send(from: string, to: string, replyTo: string | undefined,
                    subject: string, html: string): Promise<boolean> {
  // Bounded. Without a timeout one hung connection holds the whole run open
  // until the platform kills the invocation, and every class-day after it in
  // the queue is dropped for the day - which, on an exact-day ladder, means
  // dropped for good.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from, to, reply_to: replyTo, subject, html }),
      signal: abort.signal,
    });
    if (!r.ok) {
      console.error('[sub-offer-nudges-cron] resend failed:', r.status, (await r.text()).slice(0, 300));
      return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function shell(greeting: string, lines: string[], url: string, cta: string, orgName: string | null) {
  return `<!doctype html>
<html><body style="margin:0;background:#FBFBFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Hi ${esc(greeting)},</p>
    ${lines.map((l) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;">${esc(l)}</p>`).join('\n    ')}
    <p style="margin:18px 0 22px;"><a href="${esc(url)}" style="background:#1C004F;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block;">${esc(cta)}</a></p>
    <p style="font-size:14px;line-height:1.55;margin:0;">- ${esc(orgName ?? 'the team')}</p>
  </div>
</body></html>`;
}

async function classContext(
  supabase: SupabaseClient, parentType: string, parentId: string,
): Promise<{ curriculum: string; location: string | null }> {
  if (parentType === 'camp') {
    const { data: ca } = await supabase.from('camp_assignments')
      .select('camp_session_id').eq('id', parentId).maybeSingle();
    if (!ca?.camp_session_id) return { curriculum: '', location: null };
    const { data: cs } = await supabase.from('camp_sessions')
      .select('curriculum_name, location_name').eq('id', ca.camp_session_id).maybeSingle();
    return { curriculum: cs?.curriculum_name ?? '', location: cs?.location_name ?? null };
  }
  const { data: pa } = await supabase.from('program_assignments')
    .select('program_id').eq('id', parentId).maybeSingle();
  if (!pa?.program_id) return { curriculum: '', location: null };
  const { data: pr } = await supabase.from('programs')
    .select('curriculum, program_location_id').eq('id', pa.program_id).maybeSingle();
  let location: string | null = null;
  if (pr?.program_location_id) {
    const { data: loc } = await supabase.from('program_locations')
      .select('name').eq('id', pr.program_location_id).maybeSingle();
    location = loc?.name ?? null;
  }
  return { curriculum: pr?.curriculum ?? '', location };
}
