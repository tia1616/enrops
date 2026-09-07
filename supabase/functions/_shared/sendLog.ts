// One writer for TRANSACTIONAL email send records.
//
// Lifecycle email has been logged to automation_run_recipients since June, by
// lifecycle-automations-cron. Family transactional email -- the registration
// confirmation, the thank-you, the refund receipt, the waitlist invite and lapse
// note, the parent invite -- sends through Resend and has been logged NOWHERE, so
// "was this family told, and when?" could not be answered for most of what the
// platform sends. This is the writer that closes that.
//
// It writes to the SAME table rather than a new one because SEVEN surfaces
// already read that table -- counted, because an earlier draft of this comment
// said five and undercounting is how a reader gets missed: the operator contact
// timeline, the delivery-issues panel, the Overview "didn't get an email" card,
// the parent dashboard feed, marketing-resend-webhook's delivery write-back,
// delivery-alert-cron, and delivery-issue-action. The webhook matches a Resend
// event on resend_message_id ALONE, so every row written here picks up
// delivered / bounced / complained for free.
//
// See migration 20260907a for why the cron's UNIQUE (automation_id, context_key)
// is deliberately untouched and why this path gets its own non-partial index.

// Pinned to 2.39.0 to match every calling function and the other _shared
// modules. An unpinned @2 resolves to a different build whose SupabaseClient is
// a structurally different type, so every caller fails to type-check.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// The transactional send types, and the operator-facing name for each. ONE place,
// so a send type cannot be logged under two different names by two callers.
// Adding a type here is the whole of "make this email visible".
export const SEND_SOURCES = {
  registration_confirmation: "Registration confirmed",
  registration_thank_you: "Thank you",
  refund_receipt: "Refund receipt",
  waitlist_joined: "Added to the waiting list",
  waitlist_invite: "A place opened up",
  waitlist_lapsed: "Waiting-list offer expired",
  parent_invite: "Portal invitation",
} as const;

export type SendSource = keyof typeof SEND_SOURCES;

export type SendOutcome =
  | { ok: true; id: string | null }
  | { ok: false; status?: number; error: string };

/**
 * Format a Resend failure the way deliveryIssues.isPermanentFailure expects.
 *
 * That classifier reads the HTTP status out of the recorded message with
 * /resend (\d{3})/i and treats a non-429 4xx as PERMANENT -- which is what makes
 * delivery-alert-cron say "the email address on file looks invalid" and raise it
 * to the operator as needs-you. A message written in any other shape parses to
 * null and is silently treated as transient, so a genuinely undeliverable refund
 * receipt would never be surfaced to anybody. Same class as bug #30: a string
 * contract between a writer and a reader with no compiler behind it, so it is
 * enforced here in the one place rather than trusted to each caller.
 */
export function formatSendError(status: number | undefined, detail: unknown): string {
  const body = String(detail ?? "").slice(0, 500);
  return typeof status === "number" ? `Resend ${status}: ${body}` : `Resend error: ${body}`;
}

/**
 * Record one transactional send. NEVER THROWS and never returns a failure that a
 * caller has to handle: these callers are the Stripe webhook, the refund path and
 * checkout. A logging problem must not roll back a payment or block a receipt --
 * the same posture lifecycle-automations-cron takes on its own upsert
 * (index.ts:735), for the same reason.
 */
export async function logTransactionalSend(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    source: SendSource;
    contextKey: string;
    email: string;
    parentId?: string | null;
    send: SendOutcome;
    /** Overrides SEND_SOURCES[source]; only for a send whose name varies. */
    label?: string;
  },
): Promise<void> {
  try {
    if (!args.organizationId || !args.contextKey || !args.email) {
      console.error("[sendLog] refusing to log an incomplete row", {
        source: args.source,
        hasOrg: !!args.organizationId,
        hasKey: !!args.contextKey,
        hasEmail: !!args.email,
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const ok = args.send.ok;

    const row: Record<string, unknown> = {
      // Both left null on purpose: this is not an automation send. The origin
      // CHECK added in 20260907a requires exactly that pairing with a non-null
      // source, so a row that drifts out of this shape is refused by the database
      // rather than rendering as a nameless "Automated email" on the timeline.
      automation_id: null,
      automation_run_id: null,
      organization_id: args.organizationId,
      parent_id: args.parentId ?? null,
      source: args.source,
      label: args.label ?? SEND_SOURCES[args.source],
      context_key: args.contextKey,
      email: args.email,
      resend_message_id: ok ? args.send.id : null,
      status: ok ? "sent" : "failed",
      error_message: ok ? null : args.send.error,
      attempts: 1,
      last_attempt_at: nowIso,
      // Delivery verdict describes ONE message id, and this is an upsert, so a
      // re-send replacing resend_message_id must not inherit the previous
      // message's verdict -- a row could otherwise read "bounced" while its
      // current message delivered fine. Mirrors the cron's reset for the same
      // reason.
      delivery_status: null,
      delivered_at: null,
      bounced_at: null,
      complained_at: null,
      bounce_detail: null,
    };
    // sent_at is NOT NULL and defaults to now(). Stamp it only on success so it
    // means "when it actually sent"; last_attempt_at carries the honest last
    // touch for a failed row. Same rule as the cron.
    if (ok) row.sent_at = nowIso;

    const { error } = await supabase
      .from("automation_run_recipients")
      .upsert(row, { onConflict: "organization_id,source,context_key" });

    if (error) {
      console.error("[sendLog] upsert failed:", args.source, error.message);
    }
  } catch (e) {
    console.error("[sendLog] threw:", (e as Error)?.message);
  }
}
