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
