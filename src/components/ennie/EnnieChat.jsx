// EnnieChat: "Ask Ennie", the help chat in the bottom-right corner of every
// admin page (provider onboarding chunk 3, Jessica 11/24).
//
// - Answers come ONLY from the Help guides (server: supabase/functions/ennie-help).
//   Each answer links the guide section it used: /admin/help#<id>, new tab, so a
//   half-built class is never lost.
// - No answer in the guides, a thumbs down, or "Talk to a person" -> "Send to
//   the enrops team": the chat goes through submit-feedback (the same path as
//   Share feedback) and lands in Jessica's inbox with reply-to = the provider.
// - The corner button rises above any bar pinned to the bottom of a page: such a
//   bar calls useEnnieLift(ref) (marketing's question step and schedule review).
// - Phone (<= PHONE_MAX wide): the chat fills the screen.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "../../lib/supabase";
import Ennie from "../Ennie.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const LAVENDER = "#F2F0FF";
const GOLD = "#F8A638";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const SOFT = "#f7f6f1";
const RED = "#b42318";

const PHONE_MAX = 560;
const LAUNCHER_H = 48;
const LIFT_VAR = "--ennie-lift";

// Starters: each one is answered by a real guide section (connect-stripe,
// refund, copy-to-term). Change them only alongside the guides.
const STARTERS = [
  "How do I connect Stripe?",
  "How do I refund a family?",
  "How do I copy my classes to next term?",
];

// A page with a bar pinned to the bottom passes that bar's ref; the corner
// button sits above it for as long as the bar is mounted.
export function useEnnieLift(ref) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const root = document.documentElement;
    const set = () => root.style.setProperty(LIFT_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(LIFT_VAR);
    };
  }, [ref]);
}

function usePhone() {
  const query = `(max-width: ${PHONE_MAX}px)`;
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return phone;
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback for older browsers.
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
}

async function invoke(fn, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Your session expired. Refresh the page and sign in again.");
  const { data, error } = await supabase.functions.invoke(fn, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    body,
  });
  if (error) {
    let detail = null;
    try { detail = await error?.context?.json?.(); } catch (_e) { /* not JSON */ }
    const err = new Error(detail?.error || "Something went wrong. Try again.");
    err.limit = detail?.limit === true;
    throw err;
  }
  return data;
}

// Ennie's text: paragraphs, lists, bold. No links, images or HTML from the model.
const MD = {
  p: ({ node, ...p }) => <p style={{ margin: "0 0 6px" }} {...p} />,
  ul: ({ node, ...p }) => <ul style={{ margin: "4px 0 6px", paddingLeft: 20, listStyleType: "disc" }} {...p} />,
  ol: ({ node, ...p }) => <ol style={{ margin: "4px 0 6px", paddingLeft: 20, listStyleType: "decimal" }} {...p} />,
  li: ({ node, ...p }) => <li style={{ margin: "2px 0", listStyleType: "inherit" }} {...p} />,
  strong: ({ node, ...p }) => <strong style={{ fontWeight: 700 }} {...p} />,
};
const MD_ALLOWED = ["p", "ul", "ol", "li", "strong", "em", "code", "br"];

const linkBtn = {
  background: "none", border: "none", padding: 0, color: BRIGHT, fontFamily: "inherit",
  fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline",
};
const primaryBtn = {
  background: PURPLE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px",
  fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, cursor: "pointer",
};

export default function EnnieChat({ org, user }) {
  const orgId = org?.id ?? null;
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState(newId);
  const [turns, setTurns] = useState([]); // { key, question, status: 'asking'|'done'|'error', reply?, error?, limit?, rating? }
  const [draft, setDraft] = useState("");
  const [view, setView] = useState("chat"); // chat | handoff | sent
  const [note, setNote] = useState("");
  const [handoff, setHandoff] = useState({ status: "idle", error: "" });
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const launcherRef = useRef(null);

  const asking = turns.some((t) => t.status === "asking");
  const askedAny = turns.some((t) => t.status === "done");

  // Newest message in view: while Ennie is working, the bottom; once an answer
  // arrives, the top of that turn (the question), so a long answer is read from
  // its first line instead of its last.
  const lastTurnRef = useRef(null);
  const lastStatus = turns.length ? turns[turns.length - 1].status : null;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const last = lastTurnRef.current;
    if (last && (lastStatus === "done" || lastStatus === "error")) {
      // The list is position:relative, so offsetTop is measured from its top.
      list.scrollTop = Math.max(0, last.offsetTop - 8);
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }, [turns.length, lastStatus, view]);

  useEffect(() => {
    if (open && view === "chat") inputRef.current?.focus();
  }, [open, view]);

  const close = useCallback(() => {
    setOpen(false);
    launcherRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // A phone sheet covers the page; stop the page scrolling underneath it.
  useEffect(() => {
    if (!(open && phone)) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open, phone]);

  async function ask(text) {
    const question = String(text ?? "").trim();
    if (!question || asking) return;
    if (question.length > 1000) return;
    const key = newId();
    setDraft("");
    setTurns((ts) => [...ts, { key, question, status: "asking" }]);
    try {
      const reply = await invoke("ennie-help", {
        organization_id: orgId,
        conversation_id: conversationId,
        question,
        page_path: window.location.pathname,
      });
      setTurns((ts) => ts.map((t) => (t.key === key ? { ...t, status: "done", reply } : t)));
    } catch (e) {
      setTurns((ts) => ts.map((t) => (t.key === key ? { ...t, status: "error", error: e.message, limit: e.limit } : t)));
    }
  }

  async function rate(turn, rating) {
    const id = turn.reply?.id;
    if (!id) return;
    const prevRating = turn.rating ?? null;
    setTurns((ts) => ts.map((t) => (t.key === turn.key ? { ...t, rating, rateError: false } : t)));
    // .select: an update RLS hides returns no error and no rows; that is a failure too.
    const { data, error } = await supabase.from("ennie_questions").update({ rating }).eq("id", id).select("id");
    if (error || !data?.length) {
      setTurns((ts) => ts.map((t) => (t.key === turn.key ? { ...t, rating: prevRating, rateError: true } : t)));
    }
  }

  function startHandoff() {
    setNote("");
    setHandoff({ status: "idle", error: "" });
    setView("handoff");
  }

  async function sendHandoff() {
    const text = note.trim();
    if (handoff.status === "sending") return;
    if (!askedAny && !text) {
      setHandoff({ status: "idle", error: "Tell us what you need help with." });
      return;
    }
    setHandoff({ status: "sending", error: "" });
    try {
      const data = await invoke("submit-feedback", {
        organization_id: orgId,
        message: text,
        ennie_conversation_id: askedAny ? conversationId : undefined,
        page_url: window.location.href,
        page_path: window.location.pathname,
        user_agent: navigator.userAgent,
      });
      if (!data?.ok) throw new Error("Something went wrong. Try again.");
      setHandoff({ status: "idle", error: "" });
      setView("sent");
    } catch (e) {
      setHandoff({ status: "idle", error: e.message });
    }
  }

  function newChat() {
    setTurns([]);
    setConversationId(newId());
    setView("chat");
    setDraft("");
  }

  if (!orgId) return null;

  const panelStyle = phone
    ? { position: "fixed", inset: 0, borderRadius: 0, width: "auto", height: "auto" }
    : {
      position: "fixed",
      right: 20,
      // Just above the launcher: its 20px gap + its height + 12px.
      bottom: `calc(${20 + LAUNCHER_H + 12}px + var(${LIFT_VAR}, 0px) + env(safe-area-inset-bottom, 0px))`,
      width: 380,
      height: `min(600px, calc(100vh - 140px - var(${LIFT_VAR}, 0px)))`,
      borderRadius: 14,
      border: `1px solid ${RULE}`,
      boxShadow: "0 12px 40px rgba(28,0,79,0.18)",
    };

  return (
    <>
      {!(open && phone) && (
        <button
          ref={launcherRef}
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          aria-expanded={open}
          data-tour="ennie"
          // A labelled pill, not a bare face: Jessica 11/25, a face alone did not
          // read as a place to click. The words are the label.
          style={{
            position: "fixed",
            right: `calc(20px + env(safe-area-inset-right, 0px))`,
            bottom: `calc(20px + var(${LIFT_VAR}, 0px) + env(safe-area-inset-bottom, 0px))`,
            height: LAUNCHER_H,
            borderRadius: LAUNCHER_H / 2,
            border: `2px solid ${open ? PURPLE : "#fff"}`,
            background: GOLD,
            color: PURPLE,
            padding: "0 16px 0 4px",
            cursor: "pointer",
            boxShadow: "0 4px 14px rgba(28,0,79,0.25)",
            zIndex: 90,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "inherit",
            fontSize: 15,
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          <Ennie state="idle" size={LAUNCHER_H - 10} />
          <span>{open ? "Close" : "Ask Ennie"}</span>
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="Ask Ennie"
          style={{
            ...panelStyle,
            zIndex: 95,
            background: "#fff",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            color: INK,
            fontSize: 14,
          }}
        >
          <header style={{
            display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
            paddingTop: phone ? "calc(12px + env(safe-area-inset-top, 0px))" : 12,
            borderBottom: `1px solid ${RULE}`,
          }}>
            <Ennie state={asking ? "thinking" : "idle"} size={36} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: PURPLE, fontSize: 15 }}>Ask Ennie</div>
              <div style={{ color: MUTED, fontSize: 12.5 }}>AI assistant</div>
            </div>
            {turns.length > 0 && view === "chat" && (
              <button type="button" onClick={newChat} disabled={asking} style={{ ...linkBtn, fontWeight: 500, fontSize: 12.5, opacity: asking ? 0.5 : 1 }}>
                New chat
              </button>
            )}
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              style={{ background: "none", border: "none", fontSize: 22, lineHeight: 1, color: MUTED, cursor: "pointer", padding: 4 }}
            >
              ×
            </button>
          </header>

          {view === "chat" && (
            <>
              <div ref={listRef} aria-live="polite" style={{ position: "relative", flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10, background: SOFT }}>
                {turns.length === 0 && (
                  <div>
                    <p style={{ margin: "2px 0 10px", lineHeight: 1.5 }}>
                      Hi, I'm Ennie. What can I help you with?
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
                      {STARTERS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => ask(s)}
                          style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 16, padding: "6px 12px", fontFamily: "inherit", fontSize: 13.5, color: PURPLE, cursor: "pointer", textAlign: "left" }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {turns.map((t, i) => (
                  <div key={t.key} ref={i === turns.length - 1 ? lastTurnRef : undefined} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ alignSelf: "flex-end", maxWidth: "85%", background: LAVENDER, color: PURPLE, borderRadius: 12, padding: "8px 11px", lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {t.question}
                    </div>

                    {t.status === "asking" && (
                      // The chat norm: three moving dots in Ennie's bubble (Jessica
                      // 11/25). The ElapsedTimer rule is for long AI jobs, not a
                      // few-second chat reply.
                      <div role="status" aria-label="Ennie is typing" style={{ alignSelf: "flex-start", background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "11px 14px", display: "flex", gap: 5 }}>
                        <style>{"@keyframes ennieDot{0%,60%,100%{transform:translateY(0);opacity:.35}30%{transform:translateY(-4px);opacity:1}}"}</style>
                        {[0, 1, 2].map((i) => (
                          <span key={i} aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: PURPLE, animation: `ennieDot 1.2s ${i * 0.15}s infinite ease-in-out` }} />
                        ))}
                      </div>
                    )}

                    {t.status === "error" && (
                      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "8px 11px", lineHeight: 1.45 }}>
                        <span style={{ color: RED }}>{t.error}</span>
                        <div style={{ marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
                          {!t.limit && (
                            <button type="button" style={linkBtn} disabled={asking} onClick={() => {
                              setTurns((ts) => ts.filter((x) => x.key !== t.key));
                              ask(t.question);
                            }}>Try again</button>
                          )}
                          <button type="button" style={linkBtn} onClick={startHandoff}>Send to the enrops team</button>
                        </div>
                      </div>
                    )}

                    {t.status === "done" && (
                      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "9px 11px", lineHeight: 1.5, overflowWrap: "anywhere" }}>
                        {t.reply.answered ? (
                          <ReactMarkdown components={MD} allowedElements={MD_ALLOWED} unwrapDisallowed>{t.reply.answer}</ReactMarkdown>
                        ) : (
                          <p style={{ margin: "0 0 8px" }}>{t.reply.answer}</p>
                        )}

                        {t.reply.answered && t.reply.sources.length > 0 && (
                          <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED }}>
                            From:{" "}
                            {t.reply.sources.map((s, i) => (
                              <span key={s.id}>
                                {i > 0 && ", "}
                                <a href={`/admin/help#${encodeURIComponent(s.id)}`} target="_blank" rel="noopener noreferrer" style={{ color: BRIGHT, fontWeight: 600 }}>
                                  {s.label} · {s.title}
                                </a>
                              </span>
                            ))}
                          </div>
                        )}

                        {!t.reply.answered && (
                          <button type="button" style={primaryBtn} onClick={startHandoff}>Send to the enrops team</button>
                        )}

                        {t.reply.answered && t.reply.id && (
                          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: MUTED }}>
                            {t.rating == null && <span>Did this help?</span>}
                            {t.rating === 1 && <span>Thanks for telling us.</span>}
                            {t.rating === -1 && <span>Sorry about that.</span>}
                            <RateButton label="Yes, this helped" active={t.rating === 1} onClick={() => rate(t, 1)} glyph="👍" />
                            <RateButton label="No, this didn't help" active={t.rating === -1} onClick={() => rate(t, -1)} glyph="👎" />
                            {t.rateError && <span style={{ color: RED }}>Couldn't save that. Try again.</span>}
                          </div>
                        )}
                        {t.rating === -1 && (
                          <div style={{ marginTop: 6 }}>
                            <button type="button" style={linkBtn} onClick={startHandoff}>Send to the enrops team</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <form
                onSubmit={(e) => { e.preventDefault(); ask(draft); }}
                style={{ borderTop: `1px solid ${RULE}`, padding: "10px 12px", paddingBottom: phone ? "calc(10px + env(safe-area-inset-bottom, 0px))" : 10, background: "#fff" }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); }
                    }}
                    rows={1}
                    maxLength={1000}
                    placeholder="Ask a question"
                    aria-label="Ask Ennie a question"
                    style={{ flex: 1, resize: "none", border: `1px solid ${RULE}`, borderRadius: 8, padding: "9px 10px", fontFamily: "inherit", fontSize: 16, lineHeight: 1.35, maxHeight: 120, color: INK }}
                  />
                  <button type="submit" disabled={asking || !draft.trim()} style={{ ...primaryBtn, opacity: asking || !draft.trim() ? 0.5 : 1 }}>
                    Ask
                  </button>
                </div>
                <div style={{ marginTop: 8, textAlign: "center" }}>
                  <button type="button" onClick={startHandoff} style={{ ...linkBtn, fontWeight: 500 }}>Talk to a person</button>
                </div>
              </form>
            </>
          )}

          {view === "handoff" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontWeight: 700, color: PURPLE, fontSize: 15 }}>Send to the enrops team</div>
              <p style={{ margin: 0, color: MUTED, lineHeight: 1.5 }}>
                {askedAny
                  ? "We'll send this chat. Add anything that helps."
                  : "Tell us what you need help with."}
              </p>
              <textarea
                value={note}
                onChange={(e) => { setNote(e.target.value); if (handoff.error) setHandoff({ status: "idle", error: "" }); }}
                rows={5}
                maxLength={5000}
                placeholder={askedAny ? "Anything to add? (optional)" : "What are you trying to do?"}
                aria-label="Your message to the enrops team"
                style={{ resize: "vertical", border: `1px solid ${RULE}`, borderRadius: 8, padding: "9px 10px", fontFamily: "inherit", fontSize: 16, lineHeight: 1.4, color: INK }}
              />
              {handoff.error && <div role="alert" style={{ color: RED, fontSize: 13 }}>{handoff.error}</div>}
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <button type="button" onClick={sendHandoff} disabled={handoff.status === "sending"} style={{ ...primaryBtn, opacity: handoff.status === "sending" ? 0.6 : 1 }}>
                  {handoff.status === "sending" ? "Sending…" : "Send"}
                </button>
                <button type="button" onClick={() => setView("chat")} style={{ ...linkBtn, fontWeight: 500 }}>Back to chat</button>
              </div>
            </div>
          )}

          {view === "sent" && (
            <div style={{ flex: 1, padding: 18, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
              <div role="status" style={{ background: "#ecfdf3", color: "#05603a", borderRadius: 8, padding: "10px 12px", lineHeight: 1.5 }}>
                {user?.email ? `Sent. We'll email you at ${user.email}.` : "Sent. We'll email you back."}
              </div>
              <button type="button" onClick={newChat} style={{ ...linkBtn, fontWeight: 500 }}>Ask Ennie something else</button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function RateButton({ label, active, onClick, glyph }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      style={{
        border: `1px solid ${active ? BRIGHT : RULE}`,
        background: active ? LAVENDER : "#fff",
        borderRadius: 8,
        padding: "2px 7px",
        cursor: "pointer",
        fontSize: 14,
        lineHeight: 1.3,
      }}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
