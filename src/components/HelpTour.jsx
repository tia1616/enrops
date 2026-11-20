// HelpTour: a three-step "where to find help" tour, shown once per person.
//
// Jessica 2026-11-20: a short onboarding that only shows where help is (the
// "?" bubbles, Help, Share feedback). She picked an in-app tour over a video,
// because a tour points at the real buttons and cannot go out of date.
//
// Rules it is built to:
//   - Once per person per browser ("seen" in localStorage, keyed by user id).
//     Skip, Done and Escape all count as seen. Help has "Show me around again".
//   - Never over a half-built class: it waits while the provider is in the
//     class builder, which is where signup sends a brand-new provider first.
//   - Steps point at elements marked data-tour="help" / "feedback". When one is
//     not on screen (a phone, where both live inside the Menu), the step points
//     at data-tour="menu" and says to open it.
//   - Nothing behind it is clickable while it is open; it is a short modal.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Ennie from "./Ennie.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";

export const REPLAY_EVENT = "enrops:help-tour-replay";
// The one place the support address is written for the Help page and the tour.
export const HELP_EMAIL = "hello@enrops.com";
const seenKey = (userId) => `enrops.helptour.seen.${userId}`;

// Paths where the tour must not interrupt: the class builders.
const QUIET_PATHS = ["/admin/programs/quick-new", "/admin/programs/new"];

function QuestionGlyph() {
  // Drawn like EnnieTip's "?" so the provider recognises it on the page.
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 18, height: 18, borderRadius: 9, border: `1.5px solid ${BRIGHT}`,
        color: BRIGHT, fontSize: 11, fontWeight: 700, verticalAlign: "middle", margin: "0 2px",
      }}
    >
      ?
    </span>
  );
}

const STEPS = [
  {
    target: null,
    title: "Look for the ?",
    body: (
      <>
        On some pages you&apos;ll see a <QuestionGlyph /> next to a setting. Tap it for a quick explanation and a link to the full guide.
      </>
    ),
  },
  {
    target: "help",
    title: "Help",
    body: <>Every guide, in the order you&apos;ll need them.</>,
    phoneBody: <>Open the <strong>Menu</strong> and tap <strong>Help</strong>: every guide, in the order you&apos;ll need them.</>,
  },
  {
    target: "feedback",
    title: "Ask us anything",
    body: <>Tap <strong>Share feedback</strong> with a question or an idea. A real person reads every message. Or email {HELP_EMAIL}.</>,
    phoneBody: <>Open the <strong>Menu</strong> and tap <strong>Share feedback</strong> with a question or an idea. A real person reads every message. Or email {HELP_EMAIL}.</>,
  },
];

function visibleRect(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  if (r.right <= 0 || r.left >= window.innerWidth || r.bottom <= 0 || r.top >= window.innerHeight) return null;
  return r;
}

export default function HelpTour({ userId, pathname }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null); // highlighted element, or null = centred
  const [viaMenu, setViaMenu] = useState(false);
  // Remembered for this session too, so a failed localStorage write (storage
  // full) cannot reopen the tour every time the provider leaves the builder.
  const [doneThisSession, setDoneThisSession] = useState(false);
  const nextRef = useRef(null);
  const cardRef = useRef(null);

  const quiet = QUIET_PATHS.some((p) => pathname === p || pathname?.startsWith(p + "/"));

  // First visit: open once, outside the builder.
  useEffect(() => {
    if (!userId || quiet || doneThisSession) return;
    let seen = false;
    try { seen = localStorage.getItem(seenKey(userId)) === "1"; } catch { seen = true; }
    if (!seen) { setStep(0); setOpen(true); }
  }, [userId, quiet, doneThisSession]);

  // Replay from the Help page.
  useEffect(() => {
    const replay = () => { setStep(0); setOpen(true); };
    window.addEventListener(REPLAY_EVENT, replay);
    return () => window.removeEventListener(REPLAY_EVENT, replay);
  }, []);

  const finish = useCallback(() => {
    try { if (userId) localStorage.setItem(seenKey(userId), "1"); } catch { /* private window */ }
    setDoneThisSession(true);
    setOpen(false);
  }, [userId]);

  // Find what this step points at, and follow it on resize and scroll.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const want = STEPS[step].target;
    const measure = () => {
      if (!want) { setRect(null); setViaMenu(false); return; }
      const el = document.querySelector(`[data-tour="${want}"]`);
      const r = visibleRect(el);
      if (r) { setRect(r); setViaMenu(false); return; }
      const menu = visibleRect(document.querySelector('[data-tour="menu"]'));
      setRect(menu);
      setViaMenu(!!menu);
    };
    // The sidebar scrolls on a short screen; bring the target into view first.
    const el = want && document.querySelector(`[data-tour="${want}"]`);
    if (el && el.getBoundingClientRect().width > 0) el.scrollIntoView({ block: "nearest" });
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, step]);

  useEffect(() => {
    if (!open) return undefined;
    nextRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { finish(); return; }
      // Keep Tab inside the card: the page behind is dimmed and unclickable.
      if (e.key !== "Tab" || !cardRef.current) return;
      const btns = [...cardRef.current.querySelectorAll("button")];
      if (btns.length === 0) return;
      const i = btns.indexOf(document.activeElement);
      e.preventDefault();
      const n = e.shiftKey ? (i <= 0 ? btns.length - 1 : i - 1) : (i + 1) % btns.length;
      btns[n].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, step, finish]);

  if (!open) return null;

  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  const CARD_W = 320;
  const PAD = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Card beside the target when there is room (desktop sidebar), otherwise
  // below it (phone Menu button), otherwise centred.
  let cardPos;
  // The 16px floors are applied LAST so a very short window can never push the
  // card above the top of the screen.
  if (rect && rect.right + 16 + CARD_W <= vw - 16) {
    cardPos = { left: rect.right + 16, top: Math.max(16, Math.min(rect.top - 20, vh - 260)) };
  } else if (rect) {
    cardPos = { left: Math.max(16, Math.min(rect.right - CARD_W, vw - CARD_W - 16)), top: Math.max(16, Math.min(rect.bottom + 14, vh - 260)) };
  } else {
    cardPos = { left: Math.max(16, (vw - CARD_W) / 2), top: Math.max(16, vh * 0.28) };
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000 }}>
      {/* The dimmed page. With a target, the dimming is the spotlight's own
          shadow so the target stays bright; without one, a plain veil. */}
      {rect ? (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            left: rect.left - PAD, top: rect.top - PAD,
            width: rect.width + PAD * 2, height: rect.height + PAD * 2,
            borderRadius: 10,
            boxShadow: `0 0 0 3px ${BRIGHT}, 0 0 0 9999px rgba(28, 0, 79, 0.45)`,
            pointerEvents: "none",
          }}
        />
      ) : (
        <div aria-hidden="true" style={{ position: "fixed", inset: 0, background: "rgba(28, 0, 79, 0.45)" }} />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-tour-title"
        style={{
          position: "fixed", ...cardPos,
          width: CARD_W, maxWidth: "calc(100vw - 32px)", boxSizing: "border-box",
          background: "#fff", borderRadius: 14, padding: "16px 18px",
          boxShadow: "0 12px 32px rgba(28, 0, 79, 0.25)", color: INK,
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <Ennie state="idle" size={40} framed={false} />
          <div style={{ minWidth: 0 }}>
            <div id="help-tour-title" style={{ fontWeight: 700, color: PURPLE, fontSize: 15.5, marginBottom: 4 }}>{s.title}</div>
            <div style={{ fontSize: 14, lineHeight: 1.55 }}>{viaMenu && s.phoneBody ? s.phoneBody : s.body}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, gap: 8 }}>
          <span style={{ fontSize: 12.5, color: MUTED }}>{step + 1} of {STEPS.length}</span>
          <span style={{ display: "flex", gap: 8 }}>
            {!last && (
              <button type="button" onClick={finish} style={{ background: "transparent", border: "none", color: MUTED, fontFamily: "inherit", fontSize: 14, cursor: "pointer", padding: "8px 10px" }}>
                Skip
              </button>
            )}
            <button
              ref={nextRef}
              type="button"
              onClick={() => (last ? finish() : setStep(step + 1))}
              style={{ background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "8px 16px", minHeight: 40 }}
            >
              {last ? "Got it" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
