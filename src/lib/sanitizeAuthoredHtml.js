// Render-time allowlist sanitizer for operator-authored HTML.
//
// WHY THIS EXISTS. org_branding.confirmation_page_html is rendered with
// dangerouslySetInnerHTML on the PUBLIC confirmation page. Until this file, the only
// sanitizing happened in the admin browser inside editableToHtml — which is not a
// guarantee at all, because the column is writable straight over the REST API:
//
//   members_write_branding is FOR ALL USING (can_admin_org(org) OR is_platform_admin())
//
// so any org admin (and a platform admin against ANY org) could PATCH raw markup and
// skip the editor entirely. public_read_branding then serves it to anon, and every
// family finishing checkout executes it. The block also renders in the signed-in
// branch, so a parent's Supabase session token in localStorage was reachable.
// Author-time escaping is a nicety; the render is the only place that can be a gate.
//
// Deliberately NOT in bodyEditorUtils: that module is shared with every authored
// email body, and target="_blank" is meaningless in email. This is a rendering
// concern for web surfaces only.
//
// parseFromString(…, 'text/html') does NOT execute scripts, so parsing hostile input
// here is safe; we then rebuild from an allowlist rather than trying to blacklist.

// Everything an operator can legitimately produce through the editor.
const ALLOWED_TAGS = new Set(["P", "BR", "STRONG", "B", "EM", "I", "UL", "OL", "LI", "A"]);

// Dropped WITH their contents. Unwrapping these would paste their source text into
// the page as visible copy, which is worse than removing them.
const DROP_WHOLE = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT",
  "SVG", "MATH", "IMG", "VIDEO", "AUDIO", "SOURCE", "LINK", "META", "BASE", "FORM",
  "INPUT", "BUTTON", "TEXTAREA", "SELECT", "OPTION",
]);

// Same scheme allowlist bodyEditorUtils' safeLinkHref uses, minus the {{token}} form:
// this page performs NO merge substitution, so a token here would render literally.
const SAFE_SCHEME = /^(?:https?:|mailto:)/i;

/**
 * Returns HTML safe to hand to dangerouslySetInnerHTML, with every anchor forced to
 * open in a new tab. Returns "" when there is no DOM (node/tests) rather than passing
 * the input through — failing closed is the whole point of this function.
 */
export function sanitizeAuthoredHtml(html) {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return "";

  const doc = new DOMParser().parseFromString(`<body><div id="sanitize-root"></div></body>`, "text/html");
  const root = doc.getElementById("sanitize-root");
  if (!root) return "";
  // Assigning to innerHTML of a DETACHED document's element: still no script
  // execution, and no resource fetches, because this document is not rendered.
  root.innerHTML = String(html);

  cleanChildren(root, doc);
  return root.innerHTML;
}

function cleanChildren(parent, doc) {
  // Snapshot: we mutate the list as we go.
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) continue;            // text — the thing we want to keep
    if (node.nodeType !== 1) { node.remove(); continue; } // comments, CDATA, PIs

    const tag = node.tagName ? node.tagName.toUpperCase() : "";

    if (DROP_WHOLE.has(tag)) { node.remove(); continue; }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep the (cleaned) children so a stray <div><strong>x</strong></div>
      // still yields bold text rather than losing it.
      cleanChildren(node, doc);
      node.replaceWith(...Array.from(node.childNodes));
      continue;
    }

    // Read href BEFORE stripping attributes.
    const rawHref = tag === "A" ? node.getAttribute("href") : null;

    // Strip EVERYTHING — that is what kills onerror/onclick/style/srcset and any
    // attribute we have not thought of — then put back only what we allow.
    for (const attr of Array.from(node.attributes)) node.removeAttribute(attr.name);

    if (tag === "A") {
      const href = (rawHref || "").trim();
      if (SAFE_SCHEME.test(href)) {
        node.setAttribute("href", href);
        // The CTA button already does this; note links did not, so a family clicking
        // one left the confirmation page in the same tab, carrying their confirmation
        // number, the calendar download and the sign-in instructions away with them.
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      } else {
        // Not a scheme we vouch for: keep the words, drop the link.
        cleanChildren(node, doc);
        node.replaceWith(...Array.from(node.childNodes));
        continue;
      }
    }

    cleanChildren(node, doc);
  }
}
