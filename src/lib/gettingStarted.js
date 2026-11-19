// What the Getting started card on Programs shows. Pure, so the node test can
// pin every state. The card itself is GettingStartedCard.jsx.
//
// Spec (docs/handoffs/2026-11-19-provider-onboarding-scope.md, chunk 2, and
// Jessica 2026-11-19):
//   - Stage 1 is a three-item checklist, each item ticked from real data. The
//     labels come from the stage 1 guide's front matter, never retyped here.
//   - When stage 1 is done the checklist goes away. After that the card is at
//     most ONE line, for the stage whose moment has come:
//       stage 6  the term on screen has ended and nothing new is published
//       stage 4  a published class starts within 14 days
//       stage 2+3  stage 1 is done and no published class has met yet
//       otherwise nothing: an established provider gets no standing nag
//     Most urgent first, so a provider never sees two at once.

export const STAGE_FOUR_DAYS = 14;

// A class counts as published once it has been opened, even if it has since
// closed. programs_status_check allows exactly draft / open / closed / cancelled.
const PUBLISHED = new Set(["open", "closed"]);

// The stage 1 items. `checklist` is the guide's [{ id, label }]; `facts` is what
// the database says. An id this function does not know is reported not-done
// rather than silently ticked.
export function stageOneItems(checklist, { hasProgram, chargesOn, hasPublished }) {
  const done = {
    "first-program": !!hasProgram,
    "connect-stripe": !!chargesOn,
    "share-link": !!hasPublished && !!chargesOn,
  };
  return (checklist || []).map((c) => ({ id: c.id, label: c.label, done: done[c.id] === true }));
}

export function isPublished(p) {
  return PUBLISHED.has(p?.status);
}

// Add days to a YYYY-MM-DD string without touching time zones.
export function addDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

// The single follow-up line once stage 1 is done, or null.
//   orgPrograms:   every program in the org: { status, first_session_date }
//   term:          the term on screen ("FA26"), or null
//   termPrograms:  that term's programs: { id, status }
//   datesByProgram: { [id]: [{ date, kind }] } for those programs
//   today:         YYYY-MM-DD
export function nextStageLine({ stageOneDone, orgPrograms = [], term, termPrograms = [], datesByProgram = {}, today }) {
  if (!stageOneDone || !today) return null;

  const published = orgPrograms.filter((p) => isPublished(p) && p.first_session_date);
  const upcoming = published.filter((p) => p.first_session_date >= today);
  const hasStarted = published.some((p) => p.first_session_date < today);

  // Stage 6: every published class in this term that has dates is over, AND
  // nothing is lined up yet. Once next term's classes are published the
  // provider has done what this line asks, so it gives way to stage 4.
  const lastDates = termPrograms
    .filter(isPublished)
    .map((p) => (datesByProgram[p.id] || []).filter((x) => x?.kind === "session").map((x) => x.date))
    .filter((ds) => ds.length > 0)
    .map((ds) => ds.reduce((a, b) => (b > a ? b : a)));
  if (term && upcoming.length === 0 && lastDates.length > 0 && lastDates.every((d) => d < today)) {
    return { stage: 6, key: `stage6-${term}`, term };
  }

  // Stage 4: the soonest published class that starts within the window.
  const horizon = addDays(today, STAGE_FOUR_DAYS);
  const soon = upcoming
    .map((p) => p.first_session_date)
    .filter((d) => d <= horizon)
    .sort()[0];
  if (soon) return { stage: 4, key: `stage4-${soon}`, firstDate: soon };

  // Stages 2 and 3 are for a provider who has just gone live: only until their
  // first published class has met. After that they are running, not starting.
  if (hasStarted) return null;
  return { stage: 2, key: "stage2" };
}
