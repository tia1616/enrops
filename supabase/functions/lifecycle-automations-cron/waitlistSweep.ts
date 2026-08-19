// waitlistSweep.ts — keep every waiting list moving, on every cron tick.
//
// Two steps, in this order and for a reason:
//
//   1. EXPIRE  lapsed holds. The family comes off the list (Jessica 2026-08-19) and the
//              seat they were holding is released.
//   2. OFFER   the next family, wherever a seat is genuinely free.
//
// Expiring first means a lapsed offer rolls straight to the next family in the SAME tick,
// rather than waiting a whole extra cycle for the seat to be noticed.
//
// WHY A SWEEP AND NOT A TRIGGER ON CANCELLATION.
// A seat opens in more ways than anyone remembers to enumerate: a refund, an operator
// deleting a roster row, an admin editing a status by hand, a capacity increase, a
// registration expiring under the 24h pending rule, and an invite lapsing right here.
// Hanging this off "cancellation" would mean finding and instrumenting every one of those
// paths, and silently missing the next one somebody adds. Asking "does this class have a
// free seat and a waiting list?" is the same question for all of them, is self-healing
// after any outage, and needs no cancellation code to know the waitlist exists.
// The cost is latency - a seat opened one minute after a tick waits for the next one.
//
// NOTHING HERE IS ORG-CONFIGURABLE, deliberately: this is not an automation an operator
// can switch off. Turning it off would leave families holding places that never move.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
import { buildWaitlistInvite, buildWaitlistLapsed } from '../_shared/waitlistEmail.ts';
import { orgHour, withinSendingHours } from './welcomeWindow.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;

/** How long an offered place is held. Matches the pending-registration window. */
export const INVITE_HOLD_HOURS = 24;

export interface WaitlistSweepResult {
  expired: number;
  offered: number;
  emailed: number;
  skipped_no_seat: number;
  skipped_quiet_hours: number;
  skipped_already_invited: number;
  /** Offers withdrawn because the email did not go out. The next tick retries them. */
  unsent_rolled_back: number;
  /** "Your hold ran out and the place has gone" notes actually delivered to Resend. */
  lapse_notices_sent: number;
  errors: Array<{ program_id?: string; error: string }>;
}

/**
 * The site families are sent to. Falls back to the platform domain rather than
 * guessing a tenant vanity host - a wrong host in an invite link is a dead place.
 */
function inviteUrlFor(baseUrl: string, orgSlug: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${orgSlug}/waitlist/${token}`;
}

export async function runWaitlistSweep(
  supabase: SupabaseClient,
  opts: { baseUrl: string; now?: Date },
): Promise<WaitlistSweepResult> {
  const now = opts.now ?? new Date();
  const out: WaitlistSweepResult = {
    expired: 0, offered: 0, emailed: 0,
    skipped_no_seat: 0, skipped_quiet_hours: 0, skipped_already_invited: 0,
    unsent_rolled_back: 0, lapse_notices_sent: 0,
    errors: [],
  };

  // Org rows, fetched once each and shared by both steps below.
  const orgCache = new Map<string, { slug: string; timezone: string | null } | null>();
  async function getOrg(orgId: string) {
    if (!orgCache.has(orgId)) {
      const { data: o } = await supabase
        .from('organizations').select('slug, timezone').eq('id', orgId).maybeSingle();
      orgCache.set(orgId, (o as { slug: string; timezone: string | null } | null) ?? null);
    }
    return orgCache.get(orgId) ?? null;
  }

  // Program display fields, for whichever email is being built.
  async function getProgram(programId: string) {
    const { data } = await supabase
      .from('programs')
      .select('curriculum, day_of_week, start_time, program_locations(name)')
      .eq('id', programId).maybeSingle();
    const pl = (data as { program_locations?: unknown } | null)?.program_locations;
    return {
      name: (data as { curriculum?: string } | null)?.curriculum || 'the class',
      // PostgREST types an embedded relation as an array even when it is many-to-one.
      siteName: Array.isArray(pl)
        ? ((pl[0] as { name?: string } | undefined)?.name ?? null)
        : ((pl as { name?: string } | null)?.name ?? null),
      whenText: [
        (data as { day_of_week?: string } | null)?.day_of_week,
        (data as { start_time?: string } | null)?.start_time,
      ].filter(Boolean).join(' '),
    };
  }

  // ── 1. Expire ────────────────────────────────────────────────────────────
  // The DATA change runs at ANY hour: a seat held by a lapsed offer helps nobody, and
  // freeing it sends nothing.
  const { data: lapsed, error: expErr } = await supabase.rpc('waitlist_expire_invites');
  const lapsedRows = expErr
    ? []
    : ((lapsed ?? []) as Array<{
        registration_id: string; program_id: string; organization_id: string;
        parent_email: string; child_first_name: string;
      }>);
  if (expErr) {
    out.errors.push({ error: `expire: ${expErr.message}` });
  } else {
    out.expired = lapsedRows.length;
    if (lapsedRows.length) {
      console.log('[waitlist-sweep] expired holds', lapsedRows.map((r) => r.parent_email));
    }
  }

  // ── 1b. Tell the families whose hold ran out ─────────────────────────────
  //
  // Every comparable platform sends this, and without it a family whose invite went to
  // spam loses their place and never finds out. Jessica's call, 2026-08-19.
  //
  // NOT gated on quiet hours, and it does not need to be: offers only go out inside
  // sending hours, so a hold placed at 7am-9pm also lapses at 7am-9pm a day later. The
  // 3am case can only arise from a hold written by hand, and that family still deserves
  // the message more than they need it to wait.
  //
  // A failure here is logged and nothing more. Unlike the invite, there is nothing to
  // roll back: the place is already gone, and re-running the sweep will not find these
  // rows again (they are no longer status=waitlist). A missed lapse note is the
  // smallest harm in this file.
  for (const r of lapsedRows) {
    try {
      const org = await getOrg(r.organization_id);
      if (!org?.slug) continue;
      const prog = await getProgram(r.program_id);
      const brand = await loadOrgBrand(supabase, r.organization_id);

      // IS ANYONE ACTUALLY BEHIND THEM? Asked AFTER the expiry has committed, so this
      // counts the queue as it now stands, not including the row that just lapsed.
      // The email says something materially different in each case and must not guess:
      // "it has gone to the next family" is a lie when the list is empty and the seat
      // is sitting there available.
      //
      // head:true so this is a COUNT, not a read of other families' rows.
      const { count: behind, error: behindErr } = await supabase
        .from('registrations')
        .select('id', { count: 'exact', head: true })
        .eq('program_id', r.program_id)
        .eq('status', 'waitlist')
        .is('cancelled_at', null);
      if (behindErr) {
        // Cannot prove either sentence is true, so send neither. A missing note beats
        // telling a family their place was given away when it was not.
        console.error('[waitlist-sweep] could not count the queue, skipping lapse note', behindErr.message);
        out.errors.push({ program_id: r.program_id, error: `queue count: ${behindErr.message}` });
        continue;
      }

      const built = buildWaitlistLapsed({
        brand,
        childFirstName: r.child_first_name,
        programName: prog.name,
        siteName: prog.siteName,
        catalogUrl: `${opts.baseUrl.replace(/\/+$/, '')}/${org.slug}`,
        nextInLine: (behind ?? 0) > 0,
      });
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: formatFromAddress(brand),
          to: r.parent_email,
          subject: built.subject,
          html: built.html,
          text: built.text,
          // To the PROVIDER, never the platform - this is the message most likely to
          // get a "but I never saw the first email" reply, and that has to reach the
          // people who can do something about it.
          reply_to: [brand.tenant_alert_email ?? brand.reply_to],
          tags: [{ name: 'type', value: 'waitlist_lapsed' }],
        }),
      });
      if (!resp.ok) {
        console.error('[waitlist-sweep] lapse note failed', resp.status, await resp.text());
        out.errors.push({ program_id: r.program_id, error: `lapse note ${resp.status}` });
      } else {
        out.lapse_notices_sent += 1;
      }
    } catch (e) {
      console.error('[waitlist-sweep] lapse note threw', (e as Error).message);
      out.errors.push({ program_id: r.program_id, error: `lapse note: ${(e as Error).message}` });
    }
  }

  // ── 2. Offer ─────────────────────────────────────────────────────────────
  // Every program with at least one live waiting family is a candidate. The RPC does
  // the deciding: it refuses when there is no free seat, and returns the STANDING
  // invite (already_invited) rather than minting a second one.
  const { data: waiting, error: wErr } = await supabase
    .from('registrations')
    .select('program_id, organization_id')
    .eq('status', 'waitlist')
    .is('cancelled_at', null);
  if (wErr) {
    out.errors.push({ error: `candidates: ${wErr.message}` });
    return out;
  }

  const byProgram = new Map<string, string>();
  for (const r of (waiting ?? []) as Array<{ program_id: string; organization_id: string }>) {
    if (r.program_id && r.organization_id) byProgram.set(r.program_id, r.organization_id);
  }

  for (const [programId, orgId] of byProgram) {
    try {
      const org = await getOrg(orgId);
      if (!org?.slug) { out.errors.push({ program_id: programId, error: 'org not resolvable' }); continue; }

      // QUIET HOURS GATE THE OFFER, NOT JUST THE SEND.
      //
      // Stamping the hold at 3am and mailing at 7am would start a family's 24 hours
      // while they slept, so the deadline in the email would already be four hours
      // spent. Holding the whole step keeps the email's promise exact: the countdown
      // begins when the message goes out.
      //
      // The trade is that between the seat opening and the next in-hours tick, the
      // class is genuinely open and a passing visitor could take it. Accepted: at 3am
      // that is close to nobody, and the alternative lies to the family about how long
      // they have.
      if (!withinSendingHours(orgHour(org.timezone, now))) {
        out.skipped_quiet_hours += 1;
        continue;
      }

      const { data: offer, error: offErr } = await supabase.rpc('waitlist_offer_next', {
        p_program_id: programId,
        p_org_id: orgId,
        p_hold: `${INVITE_HOLD_HOURS} hours`,
      });

      if (offErr) {
        // P0001 = no free seat. That is the COMMON case on a healthy full class and
        // is not an error worth recording as one.
        if ((offErr as { code?: string }).code === 'P0001') { out.skipped_no_seat += 1; continue; }
        out.errors.push({ program_id: programId, error: offErr.message });
        continue;
      }

      const row = Array.isArray(offer) ? offer[0] : offer;
      if (!row) continue; // nobody waiting any more

      if (row.already_invited) {
        // Someone is mid-decision. Re-sending would reset nothing and read as nagging.
        out.skipped_already_invited += 1;
        continue;
      }

      out.offered += 1;

      // ── The invite email ───────────────────────────────────────────────
      // A SEND FAILURE UNDOES THE OFFER, and that is the opposite of what this first
      // did. The original reasoning was "the seat is theirs either way" - which is
      // wrong once you follow it through:
      //
      //   send fails -> the hold stands -> next tick sees already_invited and skips,
      //   so the email is never retried -> 24 hours later the expiry sweep lapses it
      //   -> and per Jessica's decision the family COMES OFF THE LIST.
      //
      // A single bad minute at Resend would cost a family their place without one word
      // ever reaching them. So on failure the invite columns are cleared, which puts
      // the seat back and lets the very next tick offer it to the same family again.
      //
      // The trade: if the send actually got through and only the RESPONSE failed, they
      // hold a link that now reads "no longer valid" and get a fresh one minutes later.
      // Two emails and one dead link is a far smaller harm than a lost place.
      let sent = false;
      try {
        const prog = await getProgram(programId);
        const brand = await loadOrgBrand(supabase, orgId);

        const built = buildWaitlistInvite({
          brand,
          childFirstName: row.child_first_name,
          programName: prog.name,
          siteName: prog.siteName,
          whenText: prog.whenText,
          inviteUrl: inviteUrlFor(opts.baseUrl, org.slug, row.invite_token),
          expiresAtIso: row.expires_at,
          timezone: org.timezone || 'UTC',
        });

        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: formatFromAddress(brand),
            to: row.parent_email,
            subject: built.subject,
            html: built.html,
            text: built.text,
            // A reply about the place has to reach the PROVIDER, never the platform.
            // Same rule as the join confirmation: tenant_alert_email first, and never
            // brand.alert_email, which cascades to Enrops.
            reply_to: [brand.tenant_alert_email ?? brand.reply_to],
            tags: [{ name: 'type', value: 'waitlist_invite' }],
          }),
        });
        if (!resp.ok) {
          console.error('[waitlist-sweep] invite send failed', resp.status, await resp.text());
          out.errors.push({ program_id: programId, error: `send ${resp.status}` });
        } else {
          sent = true;
          out.emailed += 1;
          console.log('[waitlist-sweep] invited', { program_id: programId, to: row.parent_email });
        }
      } catch (mailErr) {
        console.error('[waitlist-sweep] invite send threw', (mailErr as Error).message);
        out.errors.push({ program_id: programId, error: `send: ${(mailErr as Error).message}` });
      }

      if (!sent) {
        // Put the seat back. Targeted at the TOKEN this call just minted, not at the
        // registration id: if anything else has touched the row since (an operator
        // removing them, a consume racing in), the token no longer matches and this
        // correctly does nothing rather than clearing someone else's live invite.
        const { error: undoErr } = await supabase
          .from('registrations')
          .update({
            waitlist_invited_at: null,
            waitlist_invite_expires_at: null,
            waitlist_invite_token: null,
          })
          .eq('waitlist_invite_token', row.invite_token);
        if (undoErr) {
          // Now the seat really is stuck until the hold lapses. Loud, because this is
          // the path that ends with a family silently losing their place.
          console.error('[waitlist-sweep] COULD NOT UNDO unsent invite', {
            program_id: programId, registration_id: row.registration_id, error: undoErr.message,
          });
          out.errors.push({ program_id: programId, error: `undo failed: ${undoErr.message}` });
        } else {
          out.offered -= 1; // it did not really happen
          out.unsent_rolled_back += 1;
          console.warn('[waitlist-sweep] rolled back an unsent invite; next tick will retry', {
            program_id: programId,
          });
        }
      }
    } catch (e) {
      out.errors.push({ program_id: programId, error: (e as Error).message });
    }
  }

  return out;
}
