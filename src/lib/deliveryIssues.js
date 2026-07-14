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
