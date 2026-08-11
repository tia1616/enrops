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
// So: the toolbar comes from the automations side, the field palette from the
// Campaigns side, and nothing here exposes a markdown marker to an operator.
// Mailchimp, HubSpot and MailerSend all work this way — select your words, press
// a button, a small box asks for the web address.
//
// STATE OF ADOPTION — read this before believing the paragraph above. As of
// 2026-08-11 the ONLY caller is BrandLogoSettings (the confirmation page), and it
// passes allowLink={false}, showPreview={false} and no fields. So the link panel, the
// merge-field palette and the preview are all currently UNREACHABLE, and the drift
// this file was written to end still exists in AutomationEditor, the Campaigns body
// editor and Templates. Those three are unblocked and at parity — adopting them is
// the remaining work, and the unreachable code is here for that, not because it is
// used. Do not read this header as "the four editors are unified". They are not yet.
//
// The HTML round-trip itself is NOT reimplemented here. bodyEditorUtils already
// owns it (and its regexes carry hard-won bug history — the attribute-value
// lookahead, the bullet marker that must not eat a "- {{sender_name}}" sign-off).
// It is imported from its existing home on purpose: relocating it would mean
// editing AutomationEditor.jsx, which another chat is inside as of 2026-08-10.
import { useEffect, useRef, useState } from "react";
import {
  editableToHtml,
  htmlToEditable,
  highlightTokens,
} from "../pages/admin/marketing-v2/bodyEditorUtils.js";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const linkInputStyle = {
  width: "100%", boxSizing: "border-box", marginTop: 4, padding: "8px 10px",
  fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit",
};

function FormatButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
 * @param value       stored HTML (the canonical form)
 * @param onChange    (html) => void, fired on every keystroke
 * @param fields      optional [{ group, tokens: [{ key, label, tip }] }] merge-field palette
 * @param showPreview render the result underneath, so authoring is previewable in place
 * @param allowLink   show the Link button. OFF on the confirmation page, where a
 *                    dedicated button field sits under this box and owns the link -
 *                    two ways to make one link is one too many (Jessica, 2026-08-11).
 *                    Email bodies keep it: it is the whole point of that toolbar.
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
  // editableText is the operator-facing form and the thing they type into. It is
  // local state, NOT derived on every render: re-deriving would fight the caret
  // and mangle half-typed markers. `value` is only read back in when it changes
  // to something we did not ourselves emit (an async load, or a parent reset).
  const lastEmitted = useRef(null);
  const [editableText, setEditableText] = useState(() => htmlToEditable(value || ""));

  useEffect(() => {
    const incoming = value || "";
    if (incoming === lastEmitted.current) return; // our own echo coming back
    setEditableText(htmlToEditable(incoming));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const areaRef = useRef(null);
  // Where to put the selection after a programmatic insert. Applied in an effect
  // rather than inline because React has to commit the new text first.
  //
  // A RANGE, not a caret position. It used to be a single number applied as
  // setSelectionRange(pos, pos), which meant the bold/italic PLACEHOLDER was never
  // actually selected: pressing B on an empty box put the caret between the
  // asterisks and the next keystroke inserted BEFORE "bold text" instead of
  // replacing it, so families got "**Ukuleles bold text**" on the page.
  const caretRef = useRef(null); // null | { start, end }
  useEffect(() => {
    if (caretRef.current == null || !areaRef.current) return;
    const { start, end } = caretRef.current;
    caretRef.current = null;
    areaRef.current.focus();
    areaRef.current.setSelectionRange(start, end);
  }, [editableText]);

  function emit(text) {
    setEditableText(text);
    const html = editableToHtml(text);
    lastEmitted.current = html;
    onChange(html);
  }

  function selection() {
    const el = areaRef.current;
    if (!el) return { start: editableText.length, end: editableText.length };
    return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  }

  /** Wrap the selection in `marker`; with nothing selected, drop in a placeholder
   *  and leave it SELECTED so the next keystroke replaces it. */
  function wrapSelection(marker, placeholder2) {
    const { start, end } = selection();
    const selected = editableText.slice(start, end);
    const inner = selected || placeholder2;
    const next = `${marker}${inner}${marker}`;
    emit(editableText.slice(0, start) + next + editableText.slice(end));
    caretRef.current = selected
      // Had a selection: land after the whole wrapped run and keep typing.
      ? { start: start + next.length, end: start + next.length }
      // No selection: select the placeholder itself, so typing overwrites it.
      : { start: start + marker.length, end: start + marker.length + inner.length };
  }

  const [linkPanel, setLinkPanel] = useState(null); // null | { text, url, start, end }

  function openLinkPanel() {
    const { start, end } = selection();
    // Pre-fill from the highlighted words, the way Mailchimp does.
    setLinkPanel({ text: editableText.slice(start, end), url: "", start, end });
  }

  function insertLink() {
    const words = (linkPanel?.text || "").trim();
    let url = (linkPanel?.url || "").trim();
    if (!words || !url) return;
    // Operators paste "mysite.com" far more often than they type a scheme, and
    // bodyEditorUtils' sanitizer only accepts http/https/mailto — anything else
    // silently collapses to a dead "#". Assume https rather than hand them a
    // broken link.
    if (!/^(https?:|mailto:)/i.test(url)) url = `https://${url}`;
    const { start, end } = linkPanel;
    emit(`${editableText.slice(0, start)}[${words}](${url})${editableText.slice(end)}`);
    setLinkPanel(null);
  }

  function insertField(key) {
    const tag = `{{${key}}}`;
    const { start, end } = selection();
    caretRef.current = { start: start + tag.length, end: start + tag.length };
    emit(editableText.slice(0, start) + tag + editableText.slice(end));
  }

  const [paletteOpen, setPaletteOpen] = useState(false);
  const hasFields = Array.isArray(fields) && fields.length > 0;

  return (
    <div>
      {hasFields && (
        <div style={{ marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => setPaletteOpen((v) => !v)}
            style={{
              background: paletteOpen ? "#EDE8F5" : "#f7f4ec",
              border: `1px solid ${paletteOpen ? "#C4B5DC" : RULE}`,
              color: paletteOpen ? PURPLE : INK, padding: "5px 12px", borderRadius: 999,
              cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
            }}
          >
            {paletteOpen ? "Hide personalization fields" : "Personalize with fields"}
          </button>
          {paletteOpen && (
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
                        onClick={() => insertField(t.key)}
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
        </div>
      )}

      {/* Formatting bar, joined to the top of the box so they read as one control. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        border: `1px solid ${RULE}`, borderBottom: "none",
        borderRadius: "6px 6px 0 0", padding: "5px 6px", background: "#FBFBFB",
      }}>
        <FormatButton label="Bold" onClick={() => wrapSelection("**", "bold text")}>
          <span style={{ fontWeight: 800 }}>B</span>
        </FormatButton>
        <FormatButton label="Italic" onClick={() => wrapSelection("_", "italic text")}>
          <span style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }}>I</span>
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

      <textarea
        ref={areaRef}
        value={editableText}
        onChange={(e) => emit(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        style={{
          width: "100%", boxSizing: "border-box", padding: "10px 12px",
          border: `1px solid ${RULE}`, borderRadius: "0 0 6px 6px",
          fontFamily: "inherit", fontSize: 13, lineHeight: 1.55, color: INK,
          background: "#fff", resize: "vertical", outline: "none",
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
        {helpText || <>Highlight any words and press <strong>Link</strong> to turn them into a link. Leave a blank line to start a new paragraph.</>}
      </p>

      {showPreview && (editableText || "").trim() !== "" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
            What families will see
          </div>
          {/* Token pills ONLY when this surface actually has merge fields. A caller
              with no fields does no substitution, so highlighting {{first_name}} as a
              live-looking field would promise a replacement that never happens and the
              literal braces would reach the reader. */}
          <div
            style={{ padding: "12px 14px", border: `1px solid ${RULE}`, borderRadius: 8, background: "#faf8f1", fontSize: 13.5, color: INK, lineHeight: 1.55 }}
            dangerouslySetInnerHTML={{ __html: hasFields ? highlightTokens(editableToHtml(editableText)) : editableToHtml(editableText) }}
          />
        </div>
      )}
    </div>
  );
}
