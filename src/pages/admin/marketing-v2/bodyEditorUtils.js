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

// --- HTML entity escaping for operator-typed TEXT ------------------------
// The editor round-trip stores operator text as HTML (body_html / body_override
// / email_signature). Operator-typed characters that are STRUCTURAL in HTML —
// `&`, `<`, `>` — must be entity-escaped when we build that HTML, or:
//   • a literal `<…>` is emitted raw into outgoing email + the admin preview
//     (rendered via dangerouslySetInnerHTML — self-XSS in the admin session),
//   • htmlToEditable's catch-all tag-stripper deletes any `<…>` run on reload,
//     silently dropping the operator's text, and
//   • the dirty-check misbehaves because the round-trip isn't stable.
//
// We escape ONLY these three characters — deliberately NOT `"` or `'`. Reason:
// existing stored bodies contain entities we did NOT author (&quot;, &#39;,
// &rsquo;, &mdash; from Ennie-generated HTML). unescapeText only reverses the
// three we produce, so every other entity round-trips byte-for-byte exactly as
// it did before this change. Widening the set would start decoding those on
// load and re-encoding them differently on save — a needless backward-compat
// hazard. Token values are escaped separately at send time (htmlEscapeSafe in
// the send functions); this layer escapes the body TEXT the operator types.
export function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;") // must run FIRST so we don't double-encode below
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inverse of escapeText. `&amp;` is reversed LAST so a literal "&lt;" the
// operator typed (stored as "&amp;lt;") comes back as "&lt;", not "<".
export function unescapeText(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Tokens whose resolved value is a pre-rendered HTML <div> block (built by the
// cron/send function, not escaped). They must sit BETWEEN paragraphs, never
// inside a <p> — a block-level <div> nested in <p> is invalid HTML that email
// clients render with broken spacing. Keep in sync with PRE_RENDERED_HTML_TOKENS
// in lifecycle-automations-cron and AutomationEditor.
export const BLOCK_TOKENS = new Set([
  "final_showcase_block",
  "mid_term_skills_block",
  "final_recap_skills_block",
  "arrival_dismissal_block",
  "session_dates_block",
  "registration_summary_block",
  "next_term_link_block",
]);

const isBlockTokenLine = (line) => {
  const m = line.trim().match(/^\{\{(\w+)\}\}$/);
  return m ? BLOCK_TOKENS.has(m[1]) : false;
};

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
//   <br>/<br/>              → single newline (one Enter = a line break inside a
//                             paragraph, e.g. a stacked sign-off; a BLANK line
//                             is what starts a new paragraph)
//   <a href="X">Y</a>       → [Y](X) so the visible text can be edited without
//                             breaking the URL
//   <strong>X</strong>/<b>  → **X**
//   <em>X</em>/<i>          → _X_
//   {{token}}               → passed through untouched
//
// Catch-all: any tag we don't explicitly translate is stripped at the end so
// an operator NEVER sees a raw tag in the textarea. "No one should see HTML"
// (Jessica, 2026-06-03) — a literal <br/> in the editor was the trigger.
export function htmlToEditable(html) {
  if (!html) return "";
  let text = html;
  text = text.replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `[${inner.trim()}](${href})`);
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `**${inner}**`);
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `_${inner}_`);
  text = text.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p[^>]*>/gi, "");
  text = text.replace(/<\/p>/gi, "");
  // Safety net: drop any remaining HTML tag (keep its inner text) so unhandled
  // markup can't leak into the editor as literal characters.
  text = text.replace(/<\/?[a-z][^>]*>/gi, "");
  // Force every pre-rendered block token onto its own line. In a saved override
  // these sit bare between <p> blocks with no whitespace, so after tag-stripping
  // they'd be glued to adjacent text — which would re-wrap them in <p> on the
  // next save. Isolating them keeps the round-trip stable and shows them as
  // their own line in the editor.
  text = text.replace(/[ \t]*\{\{(\w+)\}\}[ \t]*/g, (m, name) =>
    BLOCK_TOKENS.has(name) ? `\n\n{{${name}}}\n\n` : m,
  );
  text = text.replace(/\n{3,}/g, "\n\n");
  // Decode the structural entities we escape on the way out, so the operator
  // sees `<`, `>`, `&` as literals in the textarea. Runs AFTER the catch-all
  // tag-stripper above so a stored `&lt;script&gt;` becomes the literal text
  // `<script>` (shown, not executed) instead of being stripped as a real tag.
  // Other entities (&quot;, &#39;, &rsquo;, …) are intentionally left as-is —
  // same as before this change — so they keep round-tripping unchanged.
  text = unescapeText(text);
  return text.trim();
}

// Reverse: convert markdown back to HTML, then wrap each blank-line-separated
// block in <p>...</p>. Links FIRST so a paragraph that's just a link still
// wraps in <p>. Then **bold** and _italic_. The underscore pattern requires
// non-space content so identifiers like `_internal_method` don't match unless
// they sit next to spaces / line boundaries on both sides.
export function editableToHtml(text) {
  if (!text) return "";
  // Escape structural HTML chars in the operator's TEXT before we inject any
  // real tags below. The markdown delimiters we match on (* _ [ ] ( )) aren't
  // escaped, so the transforms still fire; everything the operator typed as
  // literal content is now safe. Generated tags (<a>, <strong>, <em>, <p>,
  // <br>) are added AFTER this and stay real. htmlToEditable reverses it.
  let html = escapeText(text);
  // Links FIRST so a paragraph that's just a link still wraps in <p>. The
  // destination now tolerates one level of balanced parens so a URL like
  // https://maps.google.com/?q=(1,2) isn't truncated at the first ")". (Deeper
  // nesting than one level is not supported — vanishingly rare in real URLs.)
  html = html.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => `<strong>${inner}</strong>`);
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, (_m, pre, inner) => `${pre}<em>${inner}</em>`);
  // Build blocks line by line. A line that's ONLY a pre-rendered block token is
  // emitted bare (it's its own <div> at render time); runs of normal lines are
  // grouped into <p>. Blank lines also break paragraphs. This keeps block tokens
  // out of <p> even when an operator (or a stale override) put them on adjacent
  // lines inside what looks like one paragraph.
  const out = [];
  let buffer = [];
  const flush = () => {
    // Join with <br> so adjacent lines (one Enter) become line breaks inside
    // the paragraph — a literal "\n" here would collapse to a space in HTML,
    // which is why a stacked sign-off rendered side-by-side. A BLANK line
    // breaks the buffer into a new <p> via the loop below.
    const para = buffer.join("<br>").trim();
    if (para) out.push(`<p>${para}</p>`);
    buffer = [];
  };
  for (const line of html.split("\n")) {
    if (isBlockTokenLine(line)) {
      flush();
      out.push(line.trim());
    } else if (line.trim() === "") {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out.join("");
}

// Produce the plain-text alternative (body_text) from body_html: drop tags,
// collapse whitespace, and decode entities so the text/plain email part shows
// a real `<`, `>`, `&` — not `&lt;`. Without the unescape, now that bodies are
// entity-escaped, the plain-text part would leak literal `&lt;` to recipients.
export function stripHtml(html) {
  if (!html) return "";
  return unescapeText(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
}
