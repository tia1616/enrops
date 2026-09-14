// Shared classification for failed lifecycle email sends (automation_run_recipients
// rows with status='failed'). Single source of truth so the Automations "Didn't
// send" panel and the Overview "Important today" card agree on what counts as
// "needs you" vs "still sending".
//
// Mirrors MAX_SEND_ATTEMPTS in supabase/functions/lifecycle-automations-cron: a
// failed row at/above the cap has stopped auto-retrying and needs a human; a
// bad-address (permanent 4xx) failure is capped immediately and always needs one.

export const MAX_SEND_ATTEMPTS = 5;

// A permanent failure = the same signal lifecycle-automations-cron uses to STOP
// retrying: a non-429 4xx from Resend (e.g. 422 invalid address). We read the
// status code out of the recorded "Resend <code>: ..." message rather than
// keyword-matching the body, so a transient 5xx whose text happens to contain
// "invalid"/"validation" is NOT mis-shown as a bad address. 429 and 5xx stay
// transient (the cron keeps retrying them).
export function isPermanentFailure(errorMessage) {
  const m = /resend (\d{3})/i.exec(errorMessage || "");
  const code = m ? Number(m[1]) : null;
  return code !== null && code >= 400 && code < 500 && code !== 429;
}

// row: { error_message, attempts }
// -> { needsYou, reason, hint }
export function classifyFailure(row) {
  if (isPermanentFailure(row?.error_message)) {
    return {
      needsYou: true,
      reason: "The email address on file looks invalid.",
      hint: "Check this family's email address.",
    };
  }
  if ((row?.attempts ?? 0) >= MAX_SEND_ATTEMPTS) {
    return {
      needsYou: true,
      reason: "We couldn't reach their inbox after several tries.",
      hint: "Resend, or reach them another way.",
    };
  }
  return { needsYou: false, reason: "Still sending — retrying automatically.", hint: null };
}

// ---------------------------------------------------------------------------
// What happened to ONE automation send, in operator words.
//
// This lives here, beside classifyFailure, because this file already owns what a
// row of automation_run_recipients MEANS. A second module spelling the same
// statuses would be the divergence this codebase keeps paying for.
//
// THE VOCABULARY IS NOT THE ONE marketing_sends USES, and that is the whole
// reason this function exists. Measured on prod:
//   automation_run_recipients.status          -> sent | skipped_throttle | failed
//   automation_run_recipients.delivery_status -> delivered | bounced | NULL
//   marketing_sends.status                    -> delivered | opened | clicked |
//                                                bounced | sent | failed
// marketing_sends folds delivery INTO status; this table keeps them apart. So
// CampaignDetail's aggregate(), which asks status === 'delivered', matches
// NOTHING here and would render every automation as 100% sent / 0% delivered,
// silently. That is bug class #30 and it has already happened once on the
// contact timeline, where the sibling spelled the same idea `delivery`.
//
// FIVE OUTCOMES, NOT TWO. "We called Resend" and "it arrived" are different
// facts, and conflating them is the exact lie this screen exists to kill:
//   delivered   - Resend's webhook confirmed the inbox accepted it.
//   bounced     - the webhook confirmed it did not arrive.
//   unconfirmed - we sent it and no webhook has come back. NOT a synonym for
//                 delivered. On prod this is most of the history: delivery
//                 confirmation was 0% in June, 4% in July, 71% in August and
//                 100% from September, because the webhook only started landing
//                 reliably in late August. An unconfirmed row from July is
//                 almost certainly fine; we simply cannot say so.
//   failed      - never left the building. classifyFailure says whether a human
//                 is needed or the cron is still retrying.
//   skipped     - deliberately not sent (throttle), so it is not a problem.
export const DELIVERY_OUTCOMES = ["delivered", "bounced", "unconfirmed", "failed", "skipped"];

// row: { status, delivery_status, error_message, attempts }
// -> { key, label, tone, detail }
export function classifyDelivery(row) {
  const status = row?.status ?? null;
  const delivery = row?.delivery_status ?? null;

  if (status === "failed") {
    const f = classifyFailure(row);
    return {
      key: "failed",
      label: "Didn't send",
      tone: f.needsYou ? "bad" : "warn",
      detail: f.reason,
    };
  }
  if (status === "skipped_throttle") {
    return {
      key: "skipped",
      label: "Skipped",
      tone: "muted",
      detail: "Held back so this family was not emailed twice in quick succession.",
    };
  }
  // Delivery is only ever known from the webhook, and it is read from its OWN
  // column. Checked before the sent/unconfirmed split so a bounce is never
  // reported as merely unconfirmed.
  if (delivery === "delivered") {
    return { key: "delivered", label: "Delivered", tone: "ok", detail: "Their mail server accepted it." };
  }
  if (delivery === "bounced") {
    return {
      key: "bounced",
      label: "Bounced",
      tone: "bad",
      detail: row?.bounce_detail || "Their mail server rejected it.",
    };
  }
  return {
    key: "unconfirmed",
    label: "Sent, not confirmed",
    tone: "muted",
    detail: "We sent it and have had no delivery confirmation back. Older sends often look like this.",
  };
}

// rows -> { delivered, bounced, unconfirmed, failed, skipped, total }
// Counts every row exactly once, so the buckets always add up to total and the
// screen can never imply more delivered than were sent.
export function summariseDelivery(rows) {
  const out = { delivered: 0, bounced: 0, unconfirmed: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows ?? []) {
    out[classifyDelivery(r).key] += 1;
    out.total += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// How much of the history is on screen, said out loud.
//
// The send list is capped (PostgREST would cap it anyway) and the summary above
// it counts ONLY the rows that were loaded. On prod, J2S's "Welcome - camp" has
// 393 recipient rows, so a 200-row page would show pills adding to 200 with
// nothing saying so, and an operator would read "12 bounced" as the whole story.
// That is the same confident-wrong-number this screen was built to kill, so the
// sentence lives here next to the counting and is pinned by tests.
//
// total === null means the count itself failed. We then claim nothing about
// truncation rather than guessing, because "we could not count" and "that is
// all of them" are different statements.
//
// listed: rows on screen, total: true row count or null, pageSize: the list cap
// -> { truncated, text }
export function describeSendScope(listed, total, pageSize) {
  const n = Number.isFinite(listed) && listed > 0 ? Math.floor(listed) : 0;
  const t = Number.isFinite(total) ? Math.floor(total) : null;
  const cap = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : null;
  if (t !== null && t > n) {
    return {
      truncated: true,
      text: `Showing the most recent ${n} of ${t} sends. The counts above describe these ${n}, not all ${t}.`,
    };
  }
  // The count failed AND the list came back exactly full, so the page cap is the
  // most likely reason it stopped. Saying "200 sends" here would be a completeness
  // claim we cannot back, so we say what we know and no more.
  if (t === null && cap !== null && n >= cap) {
    return {
      truncated: true,
      text: `Showing the most recent ${n} sends. There may be more; we could not get a total.`,
    };
  }
  return { truncated: false, text: `${n} ${n === 1 ? "send" : "sends"}` };
}
