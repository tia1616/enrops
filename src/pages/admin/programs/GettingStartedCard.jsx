// Getting started, on Programs, for providers who run registration on enrops.
//
// Stage 1 is a three-item checklist ticked from real data. Once it is done the
// checklist is gone, and the card is at most one line for the stage whose
// moment has come (see lib/gettingStarted.js for the rules and their tests).
//
// Built on HatGuide, the platform's one "what next" panel, so "Not now" is the
// platform rule (hide 24 hours, come back while it still applies). The
// follow-up lines also get "Got it", which hides that line for good, because
// their condition can stay true for months.
//
// Every word a provider reads here is either a guide's own front matter or a
// link into the guide. To change an item's label, edit the guide.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import HatGuide from "../../../components/HatGuide.jsx";
import { GUIDES } from "../../../lib/guides.js";
import { stageOneItems, nextStageLine, isPublished } from "../../../lib/gettingStarted.js";
import { todayLocalISO } from "../../../lib/classPhotoLogic.js";
import { formatTermLabel } from "../../../lib/terms.js";

const BRIGHT = "#5847C9";
const MUTED = "#6b6b6b";
const OK_GREEN = "#2f7a3a";

// Read by screen readers, invisible on screen (the tick and strike-through say
// the same thing visually).
const VISUALLY_HIDDEN = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};

const guideByStage = (n) => GUIDES.find((g) => g.stage === n);

// Where each stage 1 item is done. The share step happens on this page, so it
// has no action of its own; its guide link says how.
const ACTIONS = {
  "first-program": { to: "/admin/programs/quick-new", label: "Build it →" },
  "connect-stripe": { to: "/admin/finances", label: "Connect →" },
};

const doneKey = (k) => `enrops.gettingstarted.done.${k}`;
function isGotIt(k) {
  try { return localStorage.getItem(doneKey(k)) === "1"; } catch { return false; }
}
function setGotIt(k) {
  try { localStorage.setItem(doneKey(k), "1"); } catch { /* private window: Not now still works */ }
}

function GuideLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: BRIGHT, fontWeight: 600, whiteSpace: "nowrap" }}>
      {children}
    </a>
  );
}

function formatDay(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export default function GettingStartedCard({ org, term, termPrograms, datesByProgram }) {
  // Every program in the org, not just the term on screen: a class saved under
  // another term still means "you built one".
  const [orgPrograms, setOrgPrograms] = useState(null); // null = not loaded or failed
  const [, rerender] = useState(0);

  // Re-read when a class on this page is published, unpublished or added, so a
  // tick never lags behind what the provider just did.
  const statusSig = (termPrograms || []).map((p) => `${p.id}:${p.status}`).join(",");
  useEffect(() => {
    if (!org?.id) return undefined;
    let live = true;
    supabase
      .from("programs")
      .select("id, status, first_session_date")
      .eq("organization_id", org.id)
      .then(({ data, error }) => {
        if (!live) return;
        // On a failed read show nothing rather than a checklist that wrongly
        // says the provider has done nothing.
        setOrgPrograms(error ? null : data || []);
      });
    return () => { live = false; };
  }, [org?.id, statusSig]);

  const guide1 = guideByStage(1);
  const items = useMemo(() => {
    if (!orgPrograms || !guide1) return null;
    return stageOneItems(guide1.checklist, {
      hasProgram: orgPrograms.length > 0,
      chargesOn: org?.stripe_charges_enabled === true,
      hasPublished: orgPrograms.some(isPublished),
    });
  }, [orgPrograms, guide1, org?.stripe_charges_enabled]);

  if (!items) return null;
  const stageOneDone = items.every((i) => i.done);

  if (!stageOneDone) {
    const doneCount = items.filter((i) => i.done).length;
    return (
      <div style={{ marginBottom: 14 }}>
        <HatGuide
          character="ennie"
          tip={{
            key: `gettingstarted.${org.id}.stage1`,
            message: (
              <div>
                <div style={{ fontWeight: 700 }}>
                  {guide1.title}: {doneCount} of {items.length} done
                </div>
                <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 }}>
                  {items.map((i) => (
                    <li key={i.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", listStyle: "none" }}>
                      <span aria-hidden="true" style={{ width: 18, color: i.done ? OK_GREEN : MUTED, fontWeight: 700 }}>
                        {i.done ? "✓" : "○"}
                      </span>
                      <span style={{ color: i.done ? MUTED : undefined, textDecoration: i.done ? "line-through" : "none" }}>
                        {i.label}
                        <span style={VISUALLY_HIDDEN}>{i.done ? " (done)" : " (to do)"}</span>
                      </span>
                      {!i.done && ACTIONS[i.id] && (
                        <Link to={ACTIONS[i.id].to} style={{ color: BRIGHT, fontWeight: 600, whiteSpace: "nowrap" }}>
                          {ACTIONS[i.id].label}
                        </Link>
                      )}
                      {!i.done && <GuideLink href={`/admin/help#${i.id}`}>How ↗</GuideLink>}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          }}
        />
      </div>
    );
  }

  const line = nextStageLine({
    stageOneDone,
    orgPrograms,
    term,
    termPrograms: termPrograms || [],
    datesByProgram: datesByProgram || {},
    today: todayLocalISO(),
  });
  if (!line) return null;
  const key = `gettingstarted.${org.id}.${line.key}`;
  if (isGotIt(key)) return null;

  let message;
  if (line.stage === 6) {
    const g = guideByStage(6);
    message = (
      <>
        {formatTermLabel(line.term)} has ended. Getting ready for the next one:{" "}
        <GuideLink href={`/admin/help#guide-${g.slug}`}>{g.title} ↗</GuideLink>
      </>
    );
  } else if (line.stage === 4) {
    const g = guideByStage(4);
    message = (
      <>
        {/* Not the guide's goal line: it names a school partner, and a studio
            provider has none. */}
        Your first class is {formatDay(line.firstDate)}. What to do in the two weeks before:{" "}
        <GuideLink href={`/admin/help#guide-${g.slug}`}>{g.title} ↗</GuideLink>
      </>
    );
  } else {
    const g2 = guideByStage(2);
    const g3 = guideByStage(3);
    message = (
      <>
        You&apos;re live. Next:{" "}
        <GuideLink href={`/admin/help#guide-${g2.slug}`}>{g2.title} ↗</GuideLink>, then{" "}
        <GuideLink href={`/admin/help#guide-${g3.slug}`}>{g3.title} ↗</GuideLink>
      </>
    );
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <HatGuide
        character="ennie"
        tip={{
          key,
          message,
          secondary: { label: "Got it", onClick: () => { setGotIt(key); rerender((x) => x + 1); } },
        }}
      />
    </div>
  );
}
