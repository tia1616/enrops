// The guides feed the Help page and the "?" bubble's "Read the full guide"
// link. These checks run against the REAL files, so a guide edit that breaks a
// link or ships an authoring note fails here instead of on the page.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGuide, splitHeadingId, sortGuides } from "./guideParse.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = join(here, "..", "content", "guides");

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// --- parser unit cases ------------------------------------------------------
{
  const g = parseGuide("---\r\nstage: 2\r\ntitle: Make it yours\r\nchecklist:\r\n  - id: x\r\n---\r\n\r\n# Make it yours\r\n\r\nIntro.\r\n<!-- note -->\r\n## A thing {#a-thing}\r\n### Sub {#sub}\r\n", "x.md");
  ok(g.stage === 2 && g.title === "Make it yours", "front matter: stage and title read, CRLF tolerated");
  ok(!g.body.includes("# Make it yours"), "the # title line is dropped from the body");
  ok(!g.body.includes("<!--"), "HTML comments never reach the body");
  ok(g.sections.length === 2 && g.sections[0].id === "a-thing" && g.sections[1].level === 3, "sections carry level and id");
  ok(splitHeadingId("Sign up {#sign-up}").text === "Sign up", "heading id is stripped from the text");
  ok(splitHeadingId("No id here").id === null, "a heading without an id keeps its text");
  const sorted = sortGuides([{ stage: null, file: "faq.md" }, { stage: 3, file: "c" }, { stage: 1, file: "a" }]);
  ok(sorted.map((s) => s.file).join() === "a,c,faq.md", "stages in order, FAQ last");
}

// --- the real guide files ---------------------------------------------------
const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
const guides = files.map((f) => ({ raw: readFileSync(join(dir, f), "utf8"), g: parseGuide(readFileSync(join(dir, f), "utf8"), f) }));

ok(files.length >= 7, "six stage guides plus the FAQ are present", `found ${files.join(", ")}`);
const stages = guides.map(({ g }) => g.stage).filter((s) => s != null).sort();
ok(stages.join() === "1,2,3,4,5,6", "stages 1 to 6, once each", `got ${stages.join()}`);

const ids = new Map();
for (const { raw, g } of guides) {
  ok(g.title !== "", `${g.file}: has a title`);
  ok(!/VERIFY/.test(raw), `${g.file}: no unresolved VERIFY note`);
  for (const s of g.sections) {
    // The FAQ's group headings ("## Getting started") are dividers, not
    // answers, so they are the one place a heading may go without an id.
    const isFaqGroup = g.stage == null && s.level === 2;
    if (!isFaqGroup) ok(s.id !== null, `${g.file}: heading "${s.title}" has an {#id}`);
    if (s.id) {
      ok(!ids.has(s.id), `${g.file}: id ${s.id} is unique`, ids.has(s.id) ? `also in ${ids.get(s.id)}` : "");
      ids.set(s.id, g.file);
    }
  }
}

// --- every guide="..." link in the app points at a real heading -------------
function walk(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    const full = join(d, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.jsx?$/.test(name)) out.push(full);
  }
  return out;
}
let links = 0;
for (const file of walk(join(here, ".."))) {
  const src = readFileSync(file, "utf8");
  // Only a literal guide="..." can be checked, so anything else is refused.
  ok(!/<EnnieTip\b[^>]*\bguide=\{/.test(src), `${file.split(/[\\/]src[\\/]/).pop()}: EnnieTip guide is a literal string`);
  for (const m of src.matchAll(/<EnnieTip\b[^>]*\bguide="([^"]+)"/g)) {
    links++;
    ok(ids.has(m[1]), `${file.split(/[\\/]src[\\/]/).pop()}: guide="${m[1]}" exists in the guides`);
  }
}
ok(links > 0, "at least one \"?\" bubble links to a guide");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
