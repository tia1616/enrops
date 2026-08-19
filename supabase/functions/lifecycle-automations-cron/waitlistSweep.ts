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
import { buildWaitlistInvite } from '../_shared/waitlistEmail.ts';
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
    errors: [],
  };

  // ── 1. Expire ────────────────────────────────────────────────────────────
  // Runs at ANY hour. It sends nothing, and a seat sitting held by a lapsed offer
  // helps nobody.
  const { data: lapsed, error: expErr } = await supabase.rpc('waitlist_expire_invites');
  if (expErr) {
    out.errors.push({ error: `expire: ${expErr.message}` });
  } else {
    const rows = (lapsed ?? []) as Array<{ program_id: string; parent_email: string }>;
    out.expired = rows.length;
    if (rows.length) {
      console.log('[waitlist-sweep] expired holds', rows.map((r) => r.parent_email));
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

  // Org timezone + brand, fetched once per org rather than once per program.
  const orgCache = new Map<string, { slug: string; timezone: string | null } | null>();

  for (const [programId, orgId] of byProgram) {
    try {
      if (!orgCache.has(orgId)) {
        const { data: o } = await supabase
          .from('organizations').select('slug, timezone').eq('id', orgId).maybeSingle();
        orgCache.set(orgId, (o as { slug: string; timezone: string | null } | null) ?? null);
      }
      const org = orgCache.get(orgId);
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
      // Wrapped: a send failure must NOT unwind the hold. The seat is theirs either
      // way, and the next tick will not re-offer (already_invited), so the worst case
      // is a held seat whose family was not told - which the expiry sweep releases in
      // 24 hours. Losing the hold instead would resell a seat we just promised.
      try {
        const { data: prog } = await supabase
          .from('programs')
          .select('curriculum, day_of_week, start_time, program_locations(name)')
          .eq('id', programId).maybeSingle();

        const brand = await loadOrgBrand(supabase, orgId);
        const pl = (prog as { program_locations?: unknown } | null)?.program_locations;
        const siteName = Array.isArray(pl)
          ? ((pl[0] as { name?: string } | undefined)?.name ?? null)
          : ((pl as { name?: string } | null)?.name ?? null);

        const built = buildWaitlistInvite({
          brand,
          childFirstName: row.child_first_name,
          programName: prog?.curriculum || 'the class',
          siteName,
          whenText: [prog?.day_of_week, prog?.start_time].filter(Boolean).join(' '),
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
          out.emailed += 1;
          console.log('[waitlist-sweep] invited', { program_id: programId, to: row.parent_email });
        }
      } catch (mailErr) {
        console.error('[waitlist-sweep] invite send threw', (mailErr as Error).message);
        out.errors.push({ program_id: programId, error: `send: ${(mailErr as Error).message}` });
      }
    } catch (e) {
      out.errors.push({ program_id: programId, error: (e as Error).message });
    }
  }

  return out;
}
