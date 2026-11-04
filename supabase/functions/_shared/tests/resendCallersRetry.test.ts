// Resend's 10 req/s limit is per ACCOUNT, so any function that mails can be 429ed
// by another one running in the same second. 2026-11-04: a campaign lost a batch
// of 100 that way. The SCHEDULED senders are the ones that collide - prod's
// pg_cron fires lifecycle + the marketing sender together at 15:00 UTC every day
// (plus the Monday/MWF digests), and delivery-alert + offer-reminders +
// process-installments together at 16:00 - so every scheduled function's direct
// Resend call must go through fetchWithRateLimitRetry, or be named here with the
// reason it does not.
//
// SCHEDULED is the set of functions invoked by prod's cron.job on 2026-11-04
// (select ... from cron.job where command ilike '%functions/v1/%'). A new
// scheduled sender must be added to it. Request-scoped functions (a parent or an
// admin is waiting on them) are deliberately NOT in this list: a 429 there is
// shown to the person, who can retry.

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const ROOT = "supabase/functions";

const SCHEDULED = [
  "delivery-alert-cron",
  "lifecycle-automations-cron",
  "marketing-touchpoint-cron",
  "offer-reminders-cron",
  "partner-digest-cron",
  "platform-intelligence-digest",
  "process-installments",
  "record-expiry-cron",
  "replay-digest",
  "session-confirmation-cron",
  "sub-offer-nudges-cron",
];

// scheduled function -> why a bare fetch is acceptable there
const EXEMPT: Record<string, string> = {
  "lifecycle-automations-cron":
    "sendResendEmail() already retries 429/5xx in-run (IN_RUN_MAX_TRIES); the other call is an interactive test send whose error is shown to the operator",
  "process-installments":
    "prod's copy is DELIBERATELY composed and differs from staging (money path); editing the staging copy and deploying it would overwrite that. Needs its own change made against prod's tree",
};

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

Deno.test("every scheduled function's direct Resend call retries a 429 or is exempt", () => {
  const offenders: string[] = [];
  let wrapped = 0;
  for (const name of SCHEDULED) {
    const path = `${ROOT}/${name}/index.ts`;
    const src = strip(Deno.readTextFileSync(path));
    const calls = [...src.matchAll(/fetch\(\s*["'`]https:\/\/api\.resend\.com\/[^"'`]*["'`]/g)];
    if (EXEMPT[name]) continue;
    for (const m of calls) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 80), m.index);
      if (/fetchWithRateLimitRetry\(\s*\(\)\s*=>\s*$/.test(before)) wrapped++;
      else offenders.push(`${path} (${m[0]})`);
    }
  }
  assert(wrapped >= 8, `expected to find the wrapped cron calls, found ${wrapped} - did the scan break?`);
  assert(offenders.length === 0, `scheduled Resend call without the 429 retry: ${offenders.join(", ")}`);
});

Deno.test("an exemption must still be true", () => {
  const lifecycle = strip(Deno.readTextFileSync(`${ROOT}/lifecycle-automations-cron/index.ts`));
  assert(/resp\.status === 429/.test(lifecycle), "lifecycle is exempt but no longer handles 429");
  // process-installments stays exempt only while it really has no wrapper to lose.
  const pi = strip(Deno.readTextFileSync(`${ROOT}/process-installments/index.ts`));
  assert(!/fetchWithRateLimitRetry/.test(pi), "process-installments now retries - remove its exemption");
});

Deno.test("every scheduled name still has a function directory", () => {
  for (const name of SCHEDULED) {
    assert(Deno.statSync(`${ROOT}/${name}/index.ts`).isFile, `${name} is listed as scheduled but has no index.ts`);
  }
});
