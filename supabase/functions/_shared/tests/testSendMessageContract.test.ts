// The "save your changes first" message is a string contract across two files.
//
// marketing-touchpoint-send refuses an unsaved touchpoint with the message
// "touchpoint payload missing subject or body_html". AICampaignBuilder matches
// that text to decide whether to show the operator a plain "Save your changes
// first" instead of the raw error.
//
// Nothing compiles those together. Reword the function's error and the match
// silently stops firing: the send still fails, the alert still appears, and the
// operator is back to reading "HTTP 400: touchpoint payload missing subject or
// body_html" with no idea what they did wrong. That is precisely the state Jeff
// was in on 2026-09-07, and it would come back with no test going red.
//
// BOTH SIDES ARE READ FROM SOURCE here; neither string is retyped.

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const FN = "supabase/functions/marketing-touchpoint-send/index.ts";
const UI = "src/pages/admin/marketing-v2/AICampaignBuilder.jsx";

/** The literal the function returns when the saved touchpoint has no content. */
async function functionRefusalMessage(): Promise<string> {
  const src = await Deno.readTextFile(FN);
  const m = /json\(\{\s*error:\s*"([^"]*payload missing[^"]*)"/.exec(src);
  assert(
    m,
    `could not find the unsaved-touchpoint refusal in ${FN}. If it was reworded, ` +
      `update the matcher in ${UI} in the SAME commit and fix this test's regex.`,
  );
  return m![1];
}

/** The pattern the UI uses to recognise that refusal. */
async function uiMatcher(): Promise<RegExp> {
  const src = await Deno.readTextFile(UI);
  const m = /const isUnsavedEdit = \/([^/]+)\/i\.test\(msg\)/.exec(src);
  assert(m, `could not find the isUnsavedEdit matcher in ${UI}`);
  return new RegExp(m![1], "i");
}

Deno.test("the UI recognises the function's unsaved-touchpoint refusal", async () => {
  const message = await functionRefusalMessage();
  const matcher = await uiMatcher();
  assert(
    matcher.test(message),
    `the UI matcher ${matcher} does not match the function's message ` +
      `"${message}" — an operator who presses Send test mid-edit would be shown ` +
      `the raw error again instead of "Save your changes first".`,
  );
});

Deno.test("the matcher does not swallow the OTHER 400s from that function", async () => {
  // Same function returns several unrelated refusals with the same status.
  // Telling someone to save when the real problem is their plan or a bad
  // touchpoint type sends them round a loop that cannot work.
  const matcher = await uiMatcher();
  for (
    const other of [
      "touchpoint/campaign organization_id mismatch",
      "touchpoint type 'sms' not supported (email only)",
      "Campaigns are not included in this plan.",
      "touchpoint not found for this campaign: no rows",
    ]
  ) {
    assert(
      !matcher.test(other),
      `the matcher also matches "${other}", so that error would be shown as ` +
        `"Save your changes first" — advice that cannot fix it.`,
    );
  }
});
