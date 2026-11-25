// Ennie's test set: asks every question in ennie-eval-questions.json through the
// DEPLOYED ennie-help function and checks each answer cites an expected guide
// section, or offers a person when the guides don't cover it.
//
// STAGING ONLY. Each run costs real model calls (about 20 questions, cents) and
// logs rows in ennie_questions with page_path "eval" (filter them out of any
// question report).
//
//   ENNIE_EVAL_TOKEN=<staging access token of an org member> \
//   ENNIE_EVAL_ORG=<that org's id> ENNIE_EVAL_ANON=<staging anon key> \
//   node scripts/ennie-eval.mjs
import { readFileSync } from "node:fs";

const STAGING = "https://mumfymlapolsfdnpewci.supabase.co/functions/v1/ennie-help";
const { TOKEN, ORG, ANON } = {
  TOKEN: process.env.ENNIE_EVAL_TOKEN,
  ORG: process.env.ENNIE_EVAL_ORG,
  ANON: process.env.ENNIE_EVAL_ANON,
};
if (!TOKEN || !ORG || !ANON) {
  console.error("Set ENNIE_EVAL_TOKEN, ENNIE_EVAL_ORG and ENNIE_EVAL_ANON (staging).");
  process.exit(2);
}
const { questions } = JSON.parse(readFileSync(new URL("./ennie-eval-questions.json", import.meta.url), "utf8"));

let pass = 0;
const failures = [];
for (const { q, expect } of questions) {
  // A fresh conversation per question: each is judged on its own.
  const res = await fetch(STAGING, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ organization_id: ORG, conversation_id: crypto.randomUUID(), question: q, page_path: "eval" }),
  });
  const body = await res.json().catch(() => ({}));
  const cited = (body.sources ?? []).map((s) => s.id);
  const ok = res.status === 200 && (expect === "none"
    ? body.answered === false
    : body.answered === true && cited.some((id) => expect.includes(id)));
  if (ok) pass++;
  else failures.push({ q, expect, status: res.status, answered: body.answered, cited, answer: String(body.answer ?? body.error ?? "").slice(0, 200) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${q}  ->  ${body.answered ? cited.join(", ") : "offer a person"}`);
}
console.log(`\n${pass} of ${questions.length} passed`);
for (const f of failures) console.log("\n", JSON.stringify(f, null, 2));
process.exit(failures.length ? 1 : 0);
