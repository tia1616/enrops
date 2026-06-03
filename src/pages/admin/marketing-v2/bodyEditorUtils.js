// bodyEditorUtils — shared HTML ↔ editable-text helpers used by every Family
// Comms body editor (campaign touchpoints, lifecycle automations).
//
// Why this exists: operators must NEVER see raw HTML. The toggle pattern is:
//   default view — render value (HTML) with dangerouslySetInnerHTML + token
//                  highlighting so {{first_name}} shows as a pill
//   edit mode    — show a textarea with `htmlToEditable(value)` — paragraphs
//                  separated by blank lines, **bold**, _italic_, [link](url).
//                  On every keystroke pipe back through `editableToHtml(text)`
//                  so the parent's HTML state stays canonical.
//
// Token highlight regex CRITICAL: the negative lookahead `(?![^<]*>)` skips
// tokens inside HTML attribute values so `<a href="{{register_url}}">…</a>`
// doesn't get its href smashed by an injected <span>. Bug surfaced 2026-06-02,
// documented in docs/specs/family-comms-build-guardrails.md section 6B.

const PURPLE = "#1C004F";

// Wraps merge tokens like {{first_name}} in a styled span so operators can
// see at a glance which bits get personalized at send time.
//
// CRITICAL: only highlights tokens in TEXT content, not inside HTML attribute
// values. Wrapping a token in <span> inside <a href="..."> would produce
// `<a href="<span...>...">` — invalid HTML that the browser parses
// unpredictably, swallowing the anchor tag. The negative lookahead
// `(?![^<]*>)` matches a token only when there's an unclosed `<` before the
// next `>`, i.e. the token sits in text content not inside an attribute.
export function highlightTokens(html) {
  if (!html) return "";
  return html.replace(/\{\{(\w+)\}\}(?![^<]*>)/g, (_, name) =>
    `<span style="display:inline-block;padding:0 6px;border-radius:4px;background:#f0e3e8;color:${PURPLE};font-size:0.9em;font-weight:600;font-family:ui-monospace,monospace;">{{${name}}}</span>`,
  );
}

// Convert stored HTML (what the engine renders, what's saved as
// body_override) into the plain-text form an operator edits.
//
//   <p>...</p> blocks       → blank-line-separated blocks
//   <a href="X">Y</a>       → [Y](X) so the visible text can be edited without
//                             breaking the URL
//   <strong>X</strong>/<b>  → **X**
//   <em>X</em>/<i>          → _X_
//   {{token}}               → passed through untouched
export function htmlToEditable(html) {
  if (!html) return "";
  let text = html;
  text = text.replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `[${inner.trim()}](${href})`);
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `**${inner}**`);
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `_${inner}_`);
  text = text.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");
  text = text.replace(/<\/p>/gi, "");
  return text.trim();
}

// Reverse: convert markdown back to HTML, then wrap each blank-line-separated
// block in <p>...</p>. Links FIRST so a paragraph that's just a link still
// wraps in <p>. Then **bold** and _italic_. The underscore pattern requires
// non-space content so identifiers like `_internal_method` don't match unless
// they sit next to spaces / line boundaries on both sides.
export function editableToHtml(text) {
  if (!text) return "";
  let html = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => `<strong>${inner}</strong>`);
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, (_m, pre, inner) => `${pre}<em>${inner}</em>`);
  const paragraphs = html.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => `<p>${p}</p>`).join("");
}

export function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
