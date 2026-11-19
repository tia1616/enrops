// Pure parsing for the provider guides in src/content/guides/*.md.
//
// The guides are the ONE source for the Help page, the "?" bubble's "Read the
// full guide" link and (later) Ennie's chat answers. This file only turns a
// guide's raw text into { stage, title, goal, body, sections } - no Vite, no
// React - so the node test can run it against the real files.
//
// Format (see src/content/guides/README.md):
//   - optional front matter between --- lines; only flat `key: value` lines are
//     read (stage, title, goal). Nested lists such as `checklist:` are ignored
//     here; the Getting started card reads those later.
//   - one `# Title` line, dropped from the body because the page renders the
//     title from front matter.
//   - every `##` / `###` heading ends in an id: `## Sign up {#sign-up}`.
//   - HTML comments are authoring notes and never reach the page.

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;
const HEADING_ID = /^(.*?)\s*\{#([a-z0-9-]+)\}\s*$/;

export function parseGuide(raw, file = "") {
  const text = String(raw).replace(/\r\n/g, "\n");
  const meta = {};
  let body = text;
  const fm = FRONT_MATTER.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
      if (kv && kv[2].trim() !== "") meta[kv[1]] = kv[2].trim();
    }
  }
  body = body.replace(/<!--[\s\S]*?-->\n?/g, "");
  body = body.replace(/^\s*# [^\n]*\n/, "").replace(/^\n+/, "");

  const sections = [];
  for (const m of body.matchAll(/^(#{2,3}) (.+)$/gm)) {
    const { text: title, id } = splitHeadingId(m[2]);
    sections.push({ level: m[1].length, title, id });
  }

  const stage = meta.stage != null && /^\d+$/.test(meta.stage) ? Number(meta.stage) : null;
  const slug = String(file).replace(/\.md$/, "");
  return { file, slug, stage, title: meta.title || "", goal: meta.goal || "", body, sections };
}

// "Sign up {#sign-up}" -> { text: "Sign up", id: "sign-up" }. A heading with no
// id keeps its text and gets id null.
export function splitHeadingId(text) {
  const m = HEADING_ID.exec(String(text));
  return m ? { text: m[1], id: m[2] } : { text: String(text), id: null };
}

// Stages in order, then anything without a stage (the FAQ) last.
export function sortGuides(guides) {
  return [...guides].sort((a, b) => {
    if (a.stage == null && b.stage == null) return a.file.localeCompare(b.file);
    if (a.stage == null) return 1;
    if (b.stage == null) return -1;
    return a.stage - b.stage;
  });
}
