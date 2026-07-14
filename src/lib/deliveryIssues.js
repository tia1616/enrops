// Shared classification for failed lifecycle email sends (automation_run_recipients
// rows with status='failed'). Single source of truth so the Automations "Didn't
// send" panel and the Overview "Important today" card agree on what counts as
// "needs you" vs "still sending".
//
// Mirrors MAX_SEND_ATTEMPTS in supabase/functions/lifecycle-automations-cron: a
// failed row at/above the cap has stopped auto-retrying and needs a human; a
// bad-address (permanent 4xx) failure is capped immediately and always needs one.

export const MAX_SEND_ATTEMPTS = 5;

// row: { error_message, attempts }
// -> { needsYou, reason, hint }
export function classifyFailure(row) {
  const err = (row?.error_message || "").toLowerCase();
  const badAddress = /422|invalid|not a valid|validation|no recipients|parse|domain/.test(err);
  if (badAddress) {
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
