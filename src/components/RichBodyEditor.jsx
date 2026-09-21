// RichBodyEditor — ONE editor for every place an operator authors a block of
// formatted words (email bodies, public page copy).
//
// Why this file exists: the same job was being done four different ways. The
// automations editor had Bold/Italic/Link but showed merge fields as raw
// {{chips}} that only copied to the clipboard; the Campaigns editor had a proper
// click-to-insert field palette but NO formatting buttons, so it still told
// operators to type "[link text](url)" — the exact developer notation Jessica
// rejected ("no one will know what those words mean - think how other CRMs make
// it easy"). Templates and the campaign body field had neither. Every fix landed
// on one of them and drifted from the rest.
//
// WHAT YOU TYPE IS WHAT THE FAMILY GETS. Until 2026-09-21 this was a TEXTAREA
// holding a markdown form: press Bold and you saw `**hows **it going`; add a
// link and you saw `[going](https://journeytosteam.com)`. Jessica, looking at
// exactly that: "take out computer stuff - it just needs to be bold, not have
// asterisks. same with the link. just should be blue/underlined as parents will
// see it." That is the same rule bodyEditorUtils already stated for HTML in June
// ("No one should see HTML"), only half-applied: a literal <br/> was removed and
// `**` was put in its place. A marker is a marker. So the surface is now
// contenteditable — bold looks bold, a link is blue and underlined, and a merge
// field is a chip reading "Parent's first name" rather than {{parent_first_name}}.
//
// The stored value is UNCHANGED: HTML with {{key}} tokens, exactly as before, so
// nothing downstream (the send functions, the preview, the plain-text half)
// needed to know about this. `htmlToEditable` / `editableToHtml` stay in
// bodyEditorUtils for the surfaces still on textareas.
//
// Mailchimp, HubSpot and MailerSend all work this way — select your words, press
// a button, a small box asks for the web address.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  chipsToTokens,
  editableToHtml,
  highlightTokens,
  sanitizeRichHtml,
  stripHtml,
  tokensToChips,
} from "../pages/admin/marketing-v2/bodyEditorUtils.js";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const linkInputStyle = {
  width: "100%", boxSizing: "border-box", marginTop: 4, padding: "8px 10px",
  fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit",
};

// Scoped to this editor's own class names. Inline styles cannot reach INTO
// contenteditable content (a link the operator just made is not a React
// element), so the one thing an operator must see - that a link looks like a
// link - has to be a stylesheet rule.
const EDITOR_CSS = `
.enr-rbe[contenteditable] { outline: none; }
.enr-rbe a { color: #1a55c4; text-decoration: underline; }
.enr-rbe p { margin: 0 0 10px; }
.enr-rbe p:last-child { margin-bottom: 0; }
.enr-rbe ul, .enr-rbe ol { margin: 0 0 10px; padding-left: 22px; }
.enr-rbe .enr-chip {
  display: inline-block; padding: 1px 8px; margin: 0 1px; border-radius: 999px;
  background: #EDE8F5; color: ${PURPLE}; font-size: 0.92em; font-weight: 600;
  white-space: nowrap; user-select: all;
}
.enr-rbe[data-empty="true"]::before {
  content: attr(data-placeholder);
  color: #9a9a9a; pointer-events: none;
}
`;

function FormatButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      // onMouseDown, NOT onClick, and preventDefault: a click would blur the
      // editable first, collapsing the operator's selection, and the command
      // would then apply to nothing. This is why the bold button appears to do
      // nothing in every naive contenteditable toolbar.
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        minWidth: 30, height: 26, padding: "0 7px", background: "#fff",
        border: `1px solid ${RULE}`, borderRadius: 5, color: INK,
        fontSize: 13, fontFamily: "inherit", cursor: "pointer", lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

/**
 * @param value       stored HTML (the canonical form), tokens as {{key}}
 * @param onChange    (html) => void, fired as the operator types
 * @param fields      optional [{ group, tokens: [{ key, label, tip }] }] merge-field palette
 * @param showPreview render the result underneath. Largely redundant now that the
 *                    editor shows the real thing; kept for callers that want a
 *                    separate "what families will see" block.
 * @param allowLink   show the Link button. OFF on the confirmation page, where a
 *                    dedicated button field sits under this box and owns the link -
 *                    two ways to make one link is one too many (Jessica, 2026-08-11).
 */
export default function RichBodyEditor({
  value,
  onChange,
  rows = 8,
  placeholder = "",
  fields = [],
  showPreview = true,
  helpText = null,
  allowLink = true,
}) {
  const areaRef = useRef(null);
  // The last HTML WE emitted. `value` coming back equal to this is our own echo
  // and must not be written back into the DOM - doing so on every keystroke
  // resets the caret to the start of the box, which is the classic
  // contenteditable-in-React bug.
  const lastEmitted = useRef(null);
  // The operator's selection, saved on every interaction inside the editable.
  // Toolbar buttons need it because the link panel's inputs take focus away.
  const savedRange = useRef(null);

  const hasFields = Array.isArray(fields) && fields.length > 0;

  const labelFor = useMemo(() => {
    const map = new Map();
    for (const g of fields ?? []) {
      for (const t of g.tokens ?? []) map.set(t.key, t.label);
    }
    return (key) => map.get(key) ?? null;
  }, [fields]);

  const isEmpty = !stripHtml(value || "").trim();

  // Write `value` into the DOM only when it differs from what we last emitted.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const incoming = value || "";
    if (incoming === lastEmitted.current) return;
    el.innerHTML = tokensToChips(sanitizeRichHtml(incoming), labelFor);
  }, [value, labelFor]);

  function rememberSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (areaRef.current?.contains(range.commonAncestorContainer)) {
      savedRange.current = range.cloneRange();
    }
  }

  function restoreSelection() {
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    const range = savedRange.current;
    if (!range) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function emit() {
    const el = areaRef.current;
    if (!el) return;
    // Chips back to {{key}} BEFORE sanitizing, so the stored value is the same
    // shape every other surface and every send function already understands.
    const html = sanitizeRichHtml(chipsToTokens(el.innerHTML));
    lastEmitted.current = html;
    onChange(html);
  }

  function exec(command, arg) {
    restoreSelection();
    document.execCommand(command, false, arg);
    rememberSelection();
    emit();
  }

  function insertHtmlAtCaret(html) {
    restoreSelection();
    document.execCommand("insertHTML", false, html);
    rememberSelection();
    emit();
  }

  const [linkPanel, setLinkPanel] = useState(null); // null | { text, url }

  function openLinkPanel() {
    rememberSelection();
    // Pre-fill from the highlighted words, the way Mailchimp does.
    setLinkPanel({ text: (savedRange.current?.toString() ?? "").trim(), url: "" });
  }

  function insertLink() {
    const words = (linkPanel?.text || "").trim();
    let url = (linkPanel?.url || "").trim();
    if (!words || !url) return;
    // Operators paste "mysite.com" far more often than they type a scheme, and
    // the sanitizer only accepts http/https/mailto — anything else silently
    // collapses to a dead "#". Assume https rather than hand them a broken link.
    if (!/^(https?:|mailto:)/i.test(url)) url = `https://${url}`;
    const safeWords = words.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const safeUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    // insertHTML replaces the selection, so editing the words in the panel
    // swaps the highlighted text for what the operator actually wants shown.
    insertHtmlAtCaret(`<a href="${safeUrl}">${safeWords}</a>&nbsp;`);
    setLinkPanel(null);
  }

  function insertField(key) {
    const label = labelFor(key);
    insertHtmlAtCaret(
      label
        ? `<span data-token="${key}" contenteditable="false" class="enr-chip">${label}</span>&nbsp;`
        : `{{${key}}}`,
    );
  }

  // A paste carries whatever the source felt like sending - Word styling, a
  // whole table, a tracking pixel. Taking the HTML and sanitizing it (rather
  // than forcing plain text) is deliberate: pasting a formatted draft from a
  // document or an assistant KEEPS its bold and its links, which is the case
  // that started all of this.
  function onPaste(e) {
    e.preventDefault();
    const html = e.clipboardData?.getData("text/html");
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (html) {
      insertHtmlAtCaret(sanitizeRichHtml(html));
      return;
    }
    // PLAIN TEXT GOES THROUGH THE MARKDOWN CONVERTER, and this is not a nicety -
    // leaving it out re-created the exact defect this whole build exists to fix.
    //
    // Jeff drafts with an assistant and pastes. Copying the RENDERED answer gives
    // real HTML and lands in the branch above. Copying the RAW answer - out of a
    // code block, or from anywhere that hands over plain text - gives
    // `We **WILL** have class`, which the old textarea converted to bold because
    // its whole editing form was markdown. Escaping it here instead would have
    // put the literal asterisks back in front of 400 families, from the change
    // that was supposed to end them. Caught on staging, not by a test.
    //
    // `editableToHtml` is the converter that has always done this job, so a
    // pasted `[words](url)` becomes a real link too - the other half of his
    // report. Sanitized afterwards like any other inserted HTML.
    insertHtmlAtCaret(sanitizeRichHtml(editableToHtml(text)));
  }

  return (
    <div>
      <style>{EDITOR_CSS}</style>

      {hasFields && (
        <div style={{ marginBottom: 8 }}>
          <FieldPalette fields={fields} onInsert={insertField} />
        </div>
      )}

      {/* Formatting bar, joined to the top of the box so they read as one control. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        border: `1px solid ${RULE}`, borderBottom: "none",
        borderRadius: "6px 6px 0 0", padding: "5px 6px", background: "#FBFBFB",
      }}>
        <FormatButton label="Bold" onClick={() => exec("bold")}>
          <span style={{ fontWeight: 800 }}>B</span>
        </FormatButton>
        <FormatButton label="Italic" onClick={() => exec("italic")}>
          <span style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }}>I</span>
        </FormatButton>
        <FormatButton label="Bulleted list" onClick={() => exec("insertUnorderedList")}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>•</span>
        </FormatButton>
        {allowLink && (
          <>
            <span style={{ width: 1, height: 18, background: RULE, margin: "0 4px" }} />
            <FormatButton label="Add a link" onClick={openLinkPanel}>
              {/* Chain glyph — the icon every email tool uses for this. */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
              </svg>
              <span style={{ marginLeft: 5 }}>Link</span>
            </FormatButton>
          </>
        )}
      </div>

      <div
        ref={areaRef}
        className="enr-rbe"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        data-empty={isEmpty ? "true" : "false"}
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={() => { rememberSelection(); emit(); }}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onPaste={onPaste}
        style={{
          width: "100%", boxSizing: "border-box", padding: "10px 12px",
          border: `1px solid ${RULE}`, borderRadius: "0 0 6px 6px",
          fontFamily: "inherit", fontSize: 13, lineHeight: 1.55, color: INK,
          background: "#fff", overflowY: "auto", overflowWrap: "anywhere",
          // rows is the caller's sizing unit from the textarea days; honour it
          // rather than making every call site learn a new one.
          minHeight: Math.max(2, rows) * 22,
        }}
      />

      {/* Inline link box, not a browser prompt: an inline panel can pre-fill the
          highlighted words, and window.prompt cannot. */}
      {linkPanel && (
        <div style={{ border: `1px solid ${PURPLE}`, borderRadius: 8, padding: 12, marginTop: 8, background: `${PURPLE}08` }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: PURPLE, marginBottom: 8 }}>Add a link</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={{ flex: "1 1 180px", fontSize: 12, color: MUTED }}>
              Words families will see
              <input
                value={linkPanel.text}
                onChange={(e) => setLinkPanel((p) => ({ ...p, text: e.target.value }))}
                /* Generic on purpose. A real tenant's wording or domain must never be
                   the platform's example - every OTHER provider sees it and it reads
                   as ours. Same rule as the referral list. */
                placeholder="Our shop"
                style={linkInputStyle}
              />
            </label>
            <label style={{ flex: "1 1 180px", fontSize: 12, color: MUTED }}>
              Web address
              <input
                value={linkPanel.url}
                onChange={(e) => setLinkPanel((p) => ({ ...p, url: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); insertLink(); } }}
                placeholder="yoursite.com/shop"
                style={linkInputStyle}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={insertLink}
              disabled={!linkPanel.text.trim() || !linkPanel.url.trim()}
              style={{
                padding: "6px 14px", background: PURPLE, color: "#fff", border: "none",
                borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                cursor: (!linkPanel.text.trim() || !linkPanel.url.trim()) ? "not-allowed" : "pointer",
                opacity: (!linkPanel.text.trim() || !linkPanel.url.trim()) ? 0.5 : 1,
              }}
            >Add link</button>
            <button
              type="button"
              onClick={() => setLinkPanel(null)}
              style={{ padding: "6px 12px", background: "transparent", color: INK, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
            >Cancel</button>
          </div>
        </div>
      )}

      <p style={{ margin: "6px 0 0", fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
        {helpText || <>Highlight any words and press <strong>Link</strong> to turn them into a link.</>}
      </p>

      {showPreview && !isEmpty && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
            What families will see
          </div>
          {/* Token pills ONLY when this surface actually has merge fields. A caller
              with no fields does no substitution, so highlighting {{first_name}} as a
              live-looking field would promise a replacement that never happens and the
              literal braces would reach the reader. */}
          <div
            className="enr-rbe"
            style={{ padding: "12px 14px", border: `1px solid ${RULE}`, borderRadius: 8, background: "#faf8f1", fontSize: 13.5, color: INK, lineHeight: 1.55 }}
            dangerouslySetInnerHTML={{ __html: hasFields ? highlightTokens(value || "") : (value || "") }}
          />
        </div>
      )}
    </div>
  );
}

function FieldPalette({ fields, onInsert }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: open ? "#EDE8F5" : "#f7f4ec",
          border: `1px solid ${open ? "#C4B5DC" : RULE}`,
          color: open ? PURPLE : INK, padding: "5px 12px", borderRadius: 999,
          cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
        }}
      >
        {open ? "Hide personalization fields" : "Personalize with fields"}
      </button>
      {open && (
        <div style={{ marginTop: 8, padding: 12, background: "#faf8f1", border: `1px solid ${RULE}`, borderRadius: 8 }}>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
            Click a field to insert it where your cursor is. Each one is replaced with the real
            value for every family when the email sends.
          </p>
          {fields.map((g) => (
            <div key={g.group} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, marginBottom: 4 }}>
                {g.group}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(g.tokens || []).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    // Same reason as the format buttons: a click would blur the
                    // editable and drop the caret before we could insert at it.
                    onMouseDown={(e) => { e.preventDefault(); onInsert(t.key); }}
                    title={t.tip}
                    style={{
                      background: "#fff", border: "1px solid #C4B5DC", borderRadius: 999,
                      padding: "3px 10px", fontSize: 12, fontFamily: "inherit",
                      color: PURPLE, cursor: "pointer", fontWeight: 500,
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
