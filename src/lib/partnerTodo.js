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
    // Forms are signed only in enrops onboarding (on production 11/23 every
    // active instructor had signed there except one invited that day), so the
    // unsigned ones become ONE item: finish onboarding, with the invite on
    // their record. No paper path (Jessica 11/23: overengineered).
    const unsigned = [];
    for (const l of instructorChecklist(r, orgName, today)) {
      if (!columns.has(l.key)) continue;
      const tone = bad(l.badge) ? "bad" : soon(l.badge) ? "warn" : null;
      if (l.key === "background_check") {
        // l.badge already accounts for a check from another agency standing in;
        // only an instructor the partner still sees as "In review" for a missing
        // date is asked for one.
        if (r.background_check_status === "awaiting_date" && l.badge?.tone === "review") {
          // The upload form takes the report and its date together, so say so.
          items.push({ key: `bgc:${r.instructor_id}`, tone: "bad", text: `${who}'s background check is cleared but has no completed date. Upload the report again with its date.`, action: { type: "instructor", instructorId: r.instructor_id, upload: "background-check" } });
        } else if (tone === "bad") {
          items.push({
            key: `bgc:${r.instructor_id}`, tone,
            text: r.background_check_expires_on
              ? `${who}'s background check expired ${formatDate(r.background_check_expires_on)}. Upload the new one.`
              : `Upload ${who}'s background check.`,
            action: { type: "instructor", instructorId: r.instructor_id, upload: "background-check" },
          });
        } else if (tone === "warn" && l.date) {
          // A check from another agency is standing in and it is the one
          // renewing (instructorChecklist sets `date` only then). It is renewed
          // on their record, under statuses from another source, not with the
          // enrops upload.
          items.push({ key: `bgc:${r.instructor_id}`, tone, text: `${who}'s background check from another agency renews ${formatDate(l.date)}. Add the new one on their record before then.`, action: { type: "instructor", instructorId: r.instructor_id } });
        } else if (tone === "warn") {
          items.push({ key: `bgc:${r.instructor_id}`, tone, text: `${who}'s background check renews ${formatDate(r.background_check_expires_on)}. Upload the new one before then.`, action: { type: "instructor", instructorId: r.instructor_id, upload: "background-check" } });
        }
        // "In review" (a check in progress) has nothing for the provider to do.
      } else if (l.key === "training" && tone === "bad") {
        items.push({ key: `training:${r.instructor_id}`, tone, text: `Add ${who}'s training date.`, action: { type: "instructor", instructorId: r.instructor_id } });
      } else if (SIGNED[l.key] && tone === "bad") {
        unsigned.push(SIGNED[l.key]);
      }
    }
    if (unsigned.length) {
      const list = unsigned.length === 1 ? unsigned[0]
        : `${unsigned.slice(0, -1).join(", ")}${unsigned.length > 2 ? "," : ""} and ${unsigned[unsigned.length - 1]}`;
      items.push({
        key: `signed:${r.instructor_id}`, tone: "bad",
        text: `${who} hasn't signed ${list} yet. They sign in enrops onboarding; if they haven't finished it, resend their invite from their record.`,
        action: { type: "instructor", instructorId: r.instructor_id },
      });
    }
  }

  // Red before amber, keeping each group's order (documents, then people).
  return [...items.filter((i) => i.tone === "bad"), ...items.filter((i) => i.tone === "warn")];
}
