// sendLedger.ts — the two automation_run_recipients operations that decide
// whether a family is emailed. Extracted from index.ts so they can be tested;
// index.ts itself calls serve() at import time and cannot be imported by a test.
//
// WHY THIS EXISTS. 2026-09-22: 93 Journey to STEAM families each received the
// same welcome email 8 times between 7:00 and 8:30 AM. Two separate defects had
// to line up, and this module is where both are now answered:
//
//   1. The pre-check asked PostgREST for all 102 context_keys in ONE request.
//      PostgREST filters travel in the URL, so that GET was ~14KB; past ~101
//      keys of this shape the request line overflows the HTTP header buffer and
//      dies BEFORE reaching the server. The audience crossed 88 -> 102 at 07:00
//      that morning, which is the exact minute the duplicates began.
//   2. The caller destructured only `data`. A failed pre-check therefore read as
//      "no prior sends exist", every family looked new, and the 15-minute sweep
//      re-mailed the whole list every 15 minutes. The ledger still looked
//      healthy afterwards because the write was an upsert: one row per family,
//      timestamp refreshed, no trace of the other seven sends.
//
// The shape of (1) had already cost marketing-draft-campaign once — see its
// `.in("id", [778 uuids])` note. This module is the one place that rule now
// lives for lifecycle email, so a third spelling of it cannot drift.

// Only the fragment of the Supabase client these two functions use. Narrow on
// purpose: it is what lets a test drive them without a network or a live
// project, while the real SupabaseClient still satisfies it structurally.
export interface LedgerClient {
  from(table: string): any;
}

/**
 * How many context_keys the pre-check may ask for in ONE request.
 *
 * Measured against prod on 2026-09-22 with the longest key shape we use
 * ("program:UUID:parent:UUID:student:UUID", ~135 bytes each):
 *   101 keys -> 13,900 byte URL -> 200 OK
 *   102 keys -> 14,036 byte URL -> "Headers Overflow Error", never reaches PostgREST
 * 50 keeps the worst case near 7KB, half the observed ceiling, so a longer key
 * shape or a proxy with a tighter buffer still has room. This is a TRANSPORT
 * limit, not a row limit: raising it buys nothing but risk.
 */
export const PRECHECK_CHUNK_SIZE = 50;

/**
 * What a claimed-but-not-yet-confirmed row says in error_message.
 *
 * Deliberately free of the "Resend <code>" shape isPermanentFailure() looks for,
 * so a row held for the second or two a send takes reads as attempts=1 /
 * transient — which src/lib/deliveryIssues.js renders as "Still sending —
 * retrying automatically" and delivery-alert-cron does not alert on. A row left
 * in this state by a run that died is telling the truth: we tried, we cannot say
 * it arrived, and the next daily run will try again.
 */
export const CLAIM_MARKER = "Send claimed by a run in progress.";

/**
 * What a claim becomes once we know the run holding it died.
 *
 * Deliberately NOT the claim marker, so a reclaimed row cannot be reclaimed a
 * second time and walked down to zero attempts. Deliberately not a "Resend
 * <code>" shape either, so isPermanentFailure() still reads it as transient.
 */
export const INTERRUPTED_MARKER = "Send was interrupted before it reached the provider; it will be retried.";

/**
 * How long a claim may be held before we treat the run holding it as dead.
 *
 * A Supabase edge function is killed at 150 seconds, so nothing can legitimately
 * still be mid-send after that. 10 minutes is four times the hard ceiling: long
 * enough that we can never reclaim a send that is actually in flight (which
 * would mail the family twice - the exact thing this file exists to stop), short
 * enough that an interrupted family is recovered on the next daily run rather
 * than waiting for someone to notice.
 */
export const STALE_CLAIM_AFTER_MS = 10 * 60 * 1000;

/** Most stale claims to repair in one run. Normally there are none. */
const RECLAIM_LIMIT = 200;

export interface PriorSend {
  status: string;
  attempts: number;
}

export interface ClaimTarget {
  automationId: string;
  organizationId: string;
  runId: string;
  parentId: string | null;
  contextKey: string;
  email: string;
}

/**
 * Give back the retries that were spent on sends which never actually happened.
 *
 * claimSend writes "attempt N+1, failed" BEFORE calling Resend, so the claim is
 * the thing that makes the send provably ours. The cost is that a run which dies
 * between claiming and sending leaves a row that is indistinguishable from a
 * real failed attempt: it has burned one of MAX_SEND_ATTEMPTS, and after five
 * such interruptions isDone() would drop the family for good while
 * classifyFailure() told the operator "We couldn't reach their inbox after
 * several tries" - about an address that was never submitted to Resend even
 * once. A false explanation on that screen is precisely the lie this table was
 * built to prevent, so the claim must be undone rather than left to accumulate.
 *
 * Called before the pre-check so a repaired row is eligible again on the same
 * run. Returns how many it repaired (normally 0).
 *
 * Scoped to the automation, NOT to today's audience, so one run with anybody in
 * it repairs every stale claim that automation holds. The one row this cannot
 * reach is a claim on an automation whose audience is empty on every subsequent
 * run - its caller returns before this point rather than pay a scan on each of
 * the ~96 daily no-op sweeps. That family's sending window has passed either
 * way, so the cost is a stale line on the delivery screen, not a missed email.
 */
export async function reclaimStaleClaims(
  supabase: LedgerClient,
  automationId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_AFTER_MS).toISOString();
  const { data: stale, error } = await supabase
    .from("automation_run_recipients")
    .select("id, attempts")
    .eq("automation_id", automationId)
    .eq("status", "failed")
    .eq("error_message", CLAIM_MARKER)
    .lt("last_attempt_at", cutoff)
    .limit(RECLAIM_LIMIT);
  if (error || !stale) {
    // Non-fatal, and deliberately NOT a throw: failing to repair a stale claim
    // only delays one family, whereas refusing to run would stop every send.
    // The pre-check is the gate that must fail closed, not this.
    console.error("[sendLedger] stale-claim scan failed:", error);
    return 0;
  }

  let repaired = 0;
  for (const row of stale as Array<{ id: string; attempts: number | null }>) {
    const attempts = row.attempts ?? 0;
    // Undo exactly what the claim added, and never below zero.
    const restored = attempts > 0 ? attempts - 1 : 0;
    // Guarded on the values we just read, like claimSend: if anything touched
    // this row since the scan, leave it alone rather than fight for it.
    const { data: won, error: updErr } = await supabase
      .from("automation_run_recipients")
      .update({ attempts: restored, error_message: INTERRUPTED_MARKER })
      .eq("id", row.id)
      .eq("status", "failed")
      .eq("error_message", CLAIM_MARKER)
      .eq("attempts", attempts)
      .select("id");
    if (updErr) {
      console.error("[sendLedger] stale-claim repair failed:", updErr);
      continue;
    }
    if ((won ?? []).length > 0) repaired += 1;
  }
  if (repaired > 0) {
    console.warn(`[sendLedger] recovered ${repaired} interrupted send(s) for automation ${automationId}`);
  }
  return repaired;
}

/**
 * Every prior ledger row for these context_keys, chunked so the request can
 * never overflow, and THROWING if any chunk fails.
 *
 * Throwing is the whole point. A pre-check we cannot trust must stop the run:
 * the failure mode of carrying on is mailing the entire audience a second time.
 * Callers are expected to let this escape — the per-automation try/catch in
 * index.ts records it and moves to the next automation, having sent nothing.
 */
export async function loadPriorSends(
  supabase: LedgerClient,
  automationId: string,
  contextKeys: string[],
): Promise<Map<string, PriorSend>> {
  const byKey = new Map<string, PriorSend>();
  for (let i = 0; i < contextKeys.length; i += PRECHECK_CHUNK_SIZE) {
    const chunk = contextKeys.slice(i, i + PRECHECK_CHUNK_SIZE);
    const { data, error } = await supabase
      .from("automation_run_recipients")
      .select("context_key, status, attempts")
      .eq("automation_id", automationId)
      .in("context_key", chunk);
    if (error || !data) {
      throw new Error(
        `send-ledger pre-check failed on ${chunk.length} of ${contextKeys.length} keys, refusing to send: ${
          error?.message ?? "no rows returned"
        }`,
      );
    }
    for (const r of data as Array<{ context_key: string; status: string; attempts: number | null }>) {
      byKey.set(r.context_key, { status: r.status, attempts: r.attempts ?? 0 });
    }
  }
  return byKey;
}

/**
 * Reserve this (automation_id, context_key) BEFORE a single byte goes to Resend.
 * Returns false when someone else holds it — the caller must then not send.
 *
 * loadPriorSends is a READ, so two runs can both pass it for a family neither
 * has mailed yet. The overlap is real on prod: the daily cron (0 15 * * *) and
 * the 15-minute welcome sweep both fire at 15:00 UTC and the run rows show them
 * landing ~30 seconds apart on 2026-09-21 and -22. It did not duplicate on the
 * 21st — the pre-check still worked at 88 keys, so both runs saw every row as
 * sent and mailed nobody. The race bites only on a genuinely new family, which
 * is precisely who this automation exists to reach.
 * Writing the row first turns UNIQUE(automation_id, context_key) into
 * the guard the table was built to be — "the cron uses the conflict to dedupe",
 * per the 20260603 migration — instead of a constraint an upsert never trips.
 *
 * Claiming with status='failed' + attempts needs NO new status and no migration:
 * 'failed' is already this table's word for "attempted, not confirmed sent", and
 * the existing retry ladder (a failed row under MAX_SEND_ATTEMPTS stays
 * eligible) is exactly the behaviour a dropped claim should have. The failure
 * mode is one email late, never the whole list twice.
 */
export async function claimSend(
  supabase: LedgerClient,
  target: ClaimTarget,
  priorAttempts: number,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const held = {
    automation_run_id: target.runId,
    status: "failed",
    error_message: CLAIM_MARKER,
    attempts: priorAttempts + 1,
    last_attempt_at: nowIso,
  };

  // Common path: no row yet. The INSERT is the claim; 23505 means someone won.
  const { error: insErr } = await supabase
    .from("automation_run_recipients")
    .insert({
      automation_id: target.automationId,
      organization_id: target.organizationId,
      parent_id: target.parentId,
      context_key: target.contextKey,
      email: target.email,
      ...held,
    });
  if (!insErr) return true;
  if ((insErr as { code?: string }).code !== "23505") {
    // Cannot record the claim => cannot prove the send is ours => do not send.
    console.error("[sendLedger] claim insert failed:", insErr);
    return false;
  }

  // A row already exists. It is either a real prior failure this run pre-checked
  // and means to retry, or a claim another run is holding right now. Advance it
  // ONLY from the exact attempts value we read: a concurrent claim has already
  // incremented past it and so matches nothing, while a genuine retry matches.
  // status='failed' also means a row that already SENT can never be re-claimed,
  // even if the pre-check were somehow wrong about it.
  const { data: won, error: updErr } = await supabase
    .from("automation_run_recipients")
    .update(held)
    .eq("automation_id", target.automationId)
    .eq("context_key", target.contextKey)
    .eq("status", "failed")
    .eq("attempts", priorAttempts)
    .select("id");
  if (updErr) {
    console.error("[sendLedger] claim update failed:", updErr);
    return false;
  }
  return (won ?? []).length > 0;
}
