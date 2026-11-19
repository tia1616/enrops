// Help: every provider guide, in the order a provider needs them.
//
// The content is src/content/guides/*.md and nothing else (one source: this
// page, the "?" bubble's "Read the full guide" link, and later Ennie's chat).
// To change what this page says, edit the guide, never this file.
//
// Linking: every guide heading carries an id ({#connect-stripe}), and
// /admin/help#connect-stripe scrolls straight to it.
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { GUIDES } from "../../lib/guides.js";
import { splitHeadingId } from "../../lib/guideParse.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const HELP_EMAIL = "hello@enrops.com";

// Headings are plain text ending in {#id}. react-markdown hands us the text as
// children, so the id is read off the last string child and stripped.
function headingParts(children) {
  const list = Array.isArray(children) ? children : [children];
  const last = list[list.length - 1];
  if (typeof last !== "string") return { id: null, children };
  const { text, id } = splitHeadingId(last);
  return { id, children: [...list.slice(0, -1), text] };
}

function Heading({ level, children }) {
  const { id, children: kids } = headingParts(children);
  const Tag = level === 2 ? "h3" : "h4";
  return (
    <Tag
      id={id || undefined}
      style={{
        fontSize: level === 2 ? 18 : 15.5,
        fontWeight: 700,
        color: PURPLE,
        margin: level === 2 ? "28px 0 8px" : "20px 0 6px",
        // On a phone the admin bar is sticky at the top; AdminLayout publishes
        // its height as --admin-bar-h. Without it a linked heading lands under
        // the bar.
        scrollMarginTop: "calc(var(--admin-bar-h, 0px) + 16px)",
      }}
    >
      {kids}
    </Tag>
  );
}

// Every handler destructures `node` out: react-markdown v10 passes it, and a
// bare spread would put node="[object Object]" on a DOM element.
const MD = {
  h1: ({ node, children }) => <Heading level={2}>{children}</Heading>,
  h2: ({ node, children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ node, children }) => <Heading level={3}>{children}</Heading>,
  p: ({ node, ...p }) => <p style={{ margin: "8px 0", lineHeight: 1.6 }} {...p} />,
  ul: ({ node, ...p }) => <ul style={{ margin: "6px 0", paddingLeft: 22, lineHeight: 1.6 }} {...p} />,
  ol: ({ node, ...p }) => <ol style={{ margin: "6px 0", paddingLeft: 22, lineHeight: 1.6 }} {...p} />,
  li: ({ node, ...p }) => <li style={{ margin: "3px 0" }} {...p} />,
  strong: ({ node, ...p }) => <strong style={{ fontWeight: 700, color: INK }} {...p} />,
  code: ({ node, ...p }) => (
    <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.92em", background: "#f3f1ea", borderRadius: 4, padding: "1px 5px" }} {...p} />
  ),
  a: ({ node, ...p }) => <a style={{ color: BRIGHT }} target="_blank" rel="noopener noreferrer" {...p} />,
};

function guideLabel(g) {
  return g.stage != null ? `Step ${g.stage}` : "Questions";
}

export default function HelpPage() {
  const { hash } = useLocation();

  // Scroll to the linked heading. The page renders synchronously from bundled
  // text, so the element exists on the first effect.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) el.scrollIntoView({ block: "start" });
  }, [hash]);

  return (
    <div style={{ maxWidth: 760, color: INK }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: PURPLE, margin: 0 }}>Help</h1>
      <p style={{ color: MUTED, margin: "6px 0 20px", lineHeight: 1.55 }}>
        Guides in the order you&apos;ll need them. Stuck? Email{" "}
        <a href={`mailto:${HELP_EMAIL}`} style={{ color: BRIGHT }}>{HELP_EMAIL}</a>.
      </p>

      <nav aria-label="Guides" style={{ border: `1px solid ${RULE}`, borderRadius: 10, background: "#fff", padding: "14px 18px", marginBottom: 12 }}>
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {GUIDES.map((g) => (
            <li key={g.file} style={{ lineHeight: 1.45 }}>
              <a href={`#guide-${g.slug}`} style={{ color: BRIGHT, fontWeight: 600, textDecoration: "none" }}>
                <span style={{ color: MUTED, fontWeight: 400 }}>{guideLabel(g)} · </span>
                {g.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {GUIDES.map((g) => (
        <section
          key={g.file}
          id={`guide-${g.slug}`}
          aria-labelledby={`guide-title-${g.slug}`}
          style={{ borderTop: `1px solid ${RULE}`, marginTop: 28, paddingTop: 20, scrollMarginTop: "calc(var(--admin-bar-h, 0px) + 16px)" }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: MUTED }}>
            {guideLabel(g)}
          </div>
          <h2 id={`guide-title-${g.slug}`} style={{ fontSize: 22, fontWeight: 700, color: PURPLE, margin: "2px 0 4px" }}>
            {g.title}
          </h2>
          {g.goal && <p style={{ color: MUTED, margin: "0 0 4px", lineHeight: 1.55 }}>{g.goal}</p>}
          <ReactMarkdown components={MD}>{g.body}</ReactMarkdown>
        </section>
      ))}
    </div>
  );
}
