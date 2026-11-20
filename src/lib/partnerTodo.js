// "What <partner> still needs from you": the provider's to-do list on its page
// for one partner (Jessica 2026-11-20). Every item is something that partner
// sees as missing, expired, expiring or waiting, worded for the provider, with
// the one place it is fixed.
//
// Pure, and built ONLY from what the partner page already computed:
// providerSummary() for the documents and the instructors' checklist lines
// (instructorChecklist, the same rule the partner's grid uses). So the to-do
// list and the partner's view can never disagree about what is outstanding.
//
// Action types (the page turns each into a button or link):
//   upload      { requirementKey }   a required document with nothing on file
//   renew       { doc }              a document on file that is expired / expiring
//   instructor  { instructorId, upload? }   open that instructor's record
//                                           (upload: "background-check" opens the upload)
//   share       { instructorId }     the instructor must agree in their portal

import { instructorChecklist } from "./partnerPortalLogic.js";
import { formatDate, EXPIRY_STATUS } from "./providerDocumentLogic.js";

const bad = (b) => b?.tone === "bad";
const soon = (b) => b?.tone === "warn";
const chipOf = (d) => EXPIRY_STATUS[d.expiry_status] ?? null;

function name(r) {
  return `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "An instructor";
}

const SIGNED = {
  code_of_conduct: "the code of conduct",
  mandatory_reporter: "the mandatory reporter acknowledgment",
  contractor_agreement: "the contractor agreement",
};

/**
 * @param s            providerSummary() result for this partner
 * @param instructors  listPartnerInstructors() rows (with clearances)
 * @param orgName      the provider's name (instructorChecklist wording)
 * @param today        YYYY-MM-DD
 * @returns [{ key, tone: 'bad'|'warn', text, action }]  bad first, then warn
 */
export function partnerTodo({ s, instructors, orgName, today }) {
  if (!s) return [];
  const items = [];

  for (const b of s.business || []) {
    const label = b.label.toLowerCase();
    if (!b.docs?.length) {
      items.push({ key: `doc:${b.key}`, tone: "bad", text: `Upload your ${label}.`, action: { type: "upload", requirementKey: b.key } });
      continue;
    }
    if (!bad(b.badge) && !soon(b.badge)) continue;
    // The file that makes it red or amber is the one to renew.
    const doc = b.docs.find((d) => chipOf(d)?.tone === b.badge.tone) ?? b.docs[0];
    items.push({
      key: `doc:${b.key}:${doc.id}`,
      tone: b.badge.tone,
      text: bad(b.badge)
        ? `Your ${label} expired${doc.expires_on ? ` ${formatDate(doc.expires_on)}` : ""}. Upload the renewed one.`
        : `Your ${label} expires ${formatDate(doc.expires_on)}. Upload the renewed one before then.`,
      action: { type: "renew", doc },
    });
  }

  const columns = new Set(s.instructors?.columns || []);
  for (const r of instructors || []) {
    const who = name(r);
    if (!r.shared) {
      items.push({
        key: `share:${r.instructor_id}`,
        tone: "bad",
        text: `${who} hasn't agreed to share their record with partners, so nothing about them shows. They agree on their instructor portal.`,
        action: { type: "share", instructorId: r.instructor_id },
      });
      continue;
    }
    for (const l of instructorChecklist(r, orgName, today)) {
      if (!columns.has(l.key)) continue;
      const tone = bad(l.badge) ? "bad" : soon(l.badge) ? "warn" : null;
      if (l.key === "background_check") {
        // l.badge already accounts for a check from another agency standing in;
        // only an instructor the partner still sees as "In review" for a missing
        // date is asked for one.
        if (r.background_check_status === "awaiting_date" && l.badge?.tone === "review") {
          items.push({ key: `bgc:${r.instructor_id}`, tone: "bad", text: `Add the date ${who}'s background check was completed.`, action: { type: "instructor", instructorId: r.instructor_id, upload: "background-check" } });
        } else if (tone === "bad") {
          items.push({
            key: `bgc:${r.instructor_id}`, tone,
            text: r.background_check_expires_on
              ? `${who}'s background check expired ${formatDate(r.background_check_expires_on)}. Upload the new one.`
              : `Upload ${who}'s background check.`,
            action: { type: "instructor", instructorId: r.instructor_id, upload: "background-check" },
          });
        } else if (tone === "warn") {
          items.push({ key: `bgc:${r.instructor_id}`, tone, text: `${who}'s background check renews ${formatDate(r.background_check_expires_on)}. Upload the new one before then.`, action: { type: "instructor", instructorId: r.instructor_id, upload: "background-check" } });
        }
        // "In review" (a check in progress) has nothing for the provider to do.
      } else if (l.key === "training" && tone === "bad") {
        items.push({ key: `training:${r.instructor_id}`, tone, text: `Add ${who}'s training date.`, action: { type: "instructor", instructorId: r.instructor_id } });
      } else if (SIGNED[l.key] && tone === "bad") {
        items.push({ key: `${l.key}:${r.instructor_id}`, tone, text: `${who} hasn't signed ${SIGNED[l.key]} in enrops. They sign it during instructor onboarding.`, action: { type: "instructor", instructorId: r.instructor_id } });
      }
    }
  }

  // Red before amber, keeping each group's order (documents, then people).
  return [...items.filter((i) => i.tone === "bad"), ...items.filter((i) => i.tone === "warn")];
}
