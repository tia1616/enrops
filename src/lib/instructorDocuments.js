// The documents an instructor reads and signs during onboarding — the single
// list of what exists, what each one is for, and a neutral draft to start from.
//
// THE KEYS ARE A CONTRACT, NOT A PREFERENCE. Each one is fetched by name by a
// specific wizard screen, so this list may not invent a key or rename one:
//   contractor_agreement                     -> Screen4Agreement (signed, snapshotted)
//   pay_schedule / attendance_policy /
//   code_of_conduct                          -> Screen5Policies (one ack each)
//   mandatory_reporter_ack /
//   photo_video_release / vehicle_driving_ack -> Screen6Additional
// Adding a key here that no screen reads would produce a document an operator
// writes and no instructor ever sees. Verified against those three files.
//
// `step` records WHICH screen reads each key, and it is load-bearing rather than
// documentation: turning documents off can empty a whole screen, and a screen
// with nothing on it must be dropped from the wizard instead of shown blank. The
// grouping therefore has to be a value both the wizard and the completion gate
// can read, not a comment. See stepHasEnabledDocuments.
//
// ABOUT THE STARTER DRAFTS. They are deliberately SKELETONS with bracketed
// prompts, not finished policies. Two reasons:
//   1. We are not the provider's lawyer. Shipping confident-sounding boilerplate
//      invites someone to publish terms nobody wrote for their business, in
//      their state, for their staffing model.
//   2. J2S's real documents are Oregon-specific and name Journey to STEAM, so
//      copying them into another provider's account was explicitly rejected
//      (Jessica, 2026-08-11).
// Every bracketed prompt is something only the provider can answer. A provider
// who publishes one unedited gets an obviously-unfinished document, which is the
// safe failure — far better than one that reads finished and is wrong.

export const INSTRUCTOR_DOCUMENTS = [
  {
    key: 'contractor_agreement',
    step: 'agreement',
    // NOT TOGGLEABLE, and this flag is what enforces it. It is the one document
    // that is SIGNED rather than acknowledged: submit-agreement requires it,
    // contractor_agreements snapshots its text, and onboarding cannot complete
    // without it. isDocumentEnabled ignores the stored config for this key, and
    // public_org_directory pins it to a literal true, so the two cannot disagree
    // even if a `false` were somehow written for it.
    alwaysOn: true,
    label: 'Contractor agreement',
    // Said in the operator's terms, not the system's.
    // "we keep a copy of exactly what they signed" was the first wording, and
    // Jessica caught it: it implies a provider can go and READ that copy. They
    // cannot. The snapshot, signature, timestamp and IP are all stored on
    // contractor_agreements, and a PDF goes to the contractor-documents bucket —
    // but NOTHING in the product surfaces any of it. Grepped: no read of
    // agreement_text_snapshot anywhere in src, and the only provider-visible
    // trace is a COUNT ("1 signed agreement") inside the deactivate-instructor
    // dialog. So the honest promise is what they can actually observe: it shows
    // as signed on the roster. Backlogged: give providers a way to open one.
    help: 'The agreement each instructor signs before they can be assigned. They type their name to sign it, and it shows as signed on their roster record.',
    signed: true,
    starter: `This agreement is between [your business name] and the instructor named below.

The work
[Describe what you are hiring them to do — the kind of classes they will teach, roughly how often, and where.]

Independent contractor status
[State that the instructor works as an independent contractor, not an employee, and what that means for taxes, their own equipment, and setting their own methods.]

Pay
[State your rate, what it covers, and when you pay. Point to your pay schedule document for the detail rather than repeating it here.]

Scheduling and cancellations
[Say how classes are offered and accepted, how much notice you need if they cannot make a session, and what happens if a class is cancelled.]

Working with children
[State your expectations around supervision, background checks, and mandatory reporting.]

Confidentiality
[Say what family and student information they may see and how they must handle it.]

Ending the agreement
[Say how either side ends this, and how much notice is expected.]`,
    // This document gets AGREEMENT_SIGNATURE_BLOCK appended automatically at
    // publish time — see below. It is deliberately not part of the starter and
    // not editable.
    autoSignatureBlock: true,
  },
  {
    key: 'pay_schedule',
    step: 'policies',
    label: 'Pay schedule',
    help: 'How much you pay, for what, and when it lands. Instructors confirm they have read it.',
    starter: `How you are paid
[State your rate and what it is per — a session, an hour, a day.]

When you are paid
[State your pay cycle and the day payment goes out.]

What counts as a paid session
[Say whether setup, travel, planning or a cancelled class is paid, and at what rate.]

Deductions and adjustments
[List anything that changes a payment, and how you tell them about it beforehand.]

Questions about a payment
[Say who to contact and how quickly you respond.]`,
  },
  {
    key: 'attendance_policy',
    step: 'policies',
    label: 'Attendance policy',
    help: 'What you expect around being there on time, and what to do when they cannot be.',
    starter: `Being on site
[State what time you expect instructors to arrive relative to the class start, and what to do on arrival.]

If you cannot make a session
[Say how much notice you need, who to tell, and how.]

Finding cover
[Say whether the instructor helps find a substitute or whether you arrange it.]

Repeated absence
[Say what happens if sessions are missed repeatedly, and how you will raise it with them first.]`,
  },
  {
    key: 'code_of_conduct',
    step: 'policies',
    label: 'Code of conduct',
    help: 'How you expect instructors to behave with children, families and partner sites.',
    starter: `With students
[State your expectations for how instructors speak to and supervise children, and your rules on physical contact.]

Never alone with a child
[State your policy on one-to-one situations and line of sight.]

With families
[Say how instructors should handle questions from parents, and what to pass to you instead of answering themselves.]

At partner sites
[Say how to treat the site's staff, rules and property.]

Photos and social media
[State whether instructors may photograph students, and what they may post.]

If something goes wrong
[Say who to tell, how fast, and make clear that reporting a concern is always the right call.]`,
  },
  {
    key: 'mandatory_reporter_ack',
    step: 'additional',
    label: 'Mandatory reporting acknowledgment',
    help: 'A short acknowledgment that they understand their duty to report suspected abuse or neglect. Shown in full on screen, not folded away.',
    // Short on purpose: this one renders inline above its checkbox rather than
    // in an accordion (Screen6Additional), so a wall of text would bury it.
    starter: `[State that anyone working with children in your programs is expected to report suspected abuse or neglect, and that this duty applies whether or not the law where you operate names them a mandatory reporter.]

[Say exactly who they contact, how quickly, and that they should report a concern even if they are unsure.]

[Make clear that reporting is never punished.]`,
  },
  {
    key: 'photo_video_release',
    step: 'additional',
    label: 'Photo and video release',
    help: 'Whether you may use photos or video of your instructors, and how they opt out.',
    starter: `[State whether you take photos or video during classes, and where they might appear — your website, social media, a newsletter.]

[Say what an instructor should do if they do not want to appear, and confirm that opting out changes nothing about their work with you.]

[Say how someone asks for an image to be taken down later.]`,
  },
  {
    key: 'vehicle_driving_ack',
    step: 'additional',
    label: 'Driving acknowledgment',
    help: 'Only relevant if instructors drive for you, or transport equipment or students.',
    starter: `[State whether instructors ever drive as part of this work, and what for — travelling between sites, carrying equipment.]

[If they use their own vehicle, say what you require: a valid licence, insurance, and what you do or do not reimburse.]

[State clearly whether instructors may ever transport a student.]`,
  },
];

/**
 * The signature block appended to a signed document at publish time.
 *
 * NOT EDITABLE, and not part of the starter draft. Two reasons, and the second
 * is the one that made this a separate constant:
 *
 *   1. These four `{{...}}` are the ONLY substitutions the agreement pipeline
 *      performs (agreementTemplate.ts renderAgreementText). The text stored
 *      against every signature is supposed to be "exactly what they signed" —
 *      without them the archived record names nobody, carries no date and has no
 *      audit line.
 *   2. When it lived inside the editable body, a provider could delete it, or
 *      mangle a token into `{{signing_date}}` with a typo, and the damage would
 *      only show up in an archived legal record nobody looks at until a dispute.
 *      Contract tools do not let you free-text a signature field for exactly this
 *      reason — DocuSign locks the block, PandaDoc makes signature fields their
 *      own assigned objects rather than body text. So this is appended by the
 *      system and shown to the operator as read-only.
 *
 * Square-bracket prompts elsewhere in a draft are untouched by that
 * substitution, so the rest of the document passes through intact.
 */
export const AGREEMENT_SIGNATURE_BLOCK = `Signature

Signed by {{contractor_legal_name}} on {{signing_date}}.
Recorded electronically at {{signed_at_timestamp}} from {{signed_at_ip}}.`;

export const AGREEMENT_SIGNATURE_TOKENS = [
  'contractor_legal_name',
  'signing_date',
  'signed_at_timestamp',
  'signed_at_ip',
];

/**
 * Body text as it should be STORED for this document.
 *
 * Appends the signature block to a signed document that does not already carry
 * those tokens. The "already carries them" check is load-bearing: the existing
 * seeded agreement has its own signature wording inline, and blindly appending
 * would give it two.
 */
export function bodyForPublish(docKey, body) {
  const text = stripAppendedSignatureBlock(body);
  if (!willAppendSignatureBlock(docKey, text)) return text;
  return `${text}\n\n${AGREEMENT_SIGNATURE_BLOCK}`;
}

/**
 * Remove OUR appended block from the end of a stored body.
 *
 * Why this exists: the block used to be appended once and then lived inside
 * body_text forever. Reopening the document loaded it straight into the editable
 * textarea, so from the second edit onward it was ordinary text the provider
 * could delete a line of — and the old `.some()` check then saw a surviving
 * token, decided the block was intact, and appended nothing. The result was a
 * permanently half-signed agreement: an audit line naming nobody.
 *
 * Stripping on load and re-appending on publish means the editable body NEVER
 * contains the block, so it cannot be half-deleted, and the locked panel is shown
 * every time rather than only on the first write.
 *
 * Exact-match only, anchored at the end. It must not touch a provider's own
 * signature prose — the seeded agreement has its own, which is why
 * willAppendSignatureBlock still checks for tokens afterwards.
 */
export function stripAppendedSignatureBlock(body) {
  const text = (body ?? '').trim();
  const suffix = `\n\n${AGREEMENT_SIGNATURE_BLOCK}`;
  if (text.endsWith(suffix)) return text.slice(0, -suffix.length).trim();
  if (text === AGREEMENT_SIGNATURE_BLOCK) return '';
  return text;
}

/**
 * Will publishing this body actually append the signature block?
 *
 * Exported so the SCREEN and the WRITE ask the same question. The editor shows a
 * panel saying "we add this to the bottom when you publish" — and for a document
 * that already carries its own signature wording inline (the seeded agreement
 * does) that sentence is simply false, and the operator sees the signature twice.
 * Deriving both from one predicate is the only way they cannot drift.
 */
export function willAppendSignatureBlock(docKey, body) {
  const meta = INSTRUCTOR_DOCUMENTS.find((d) => d.key === docKey);
  if (!meta?.autoSignatureBlock) return false;
  const text = stripAppendedSignatureBlock(body);
  // EVERY, not SOME. `.some()` treated a body holding one surviving token as
  // already complete, so a partially deleted block was never repaired — the
  // stored agreement kept an audit line that named nobody. Requiring all four
  // means anything less than a complete signature gets a complete one appended.
  // Worst case is a redundant stray token beside a correct block; the previous
  // worst case was an archived legal record with no signer on it.
  return !AGREEMENT_SIGNATURE_TOKENS.every((t) => text.includes(`{{${t}}}`));
}

export const DOCUMENT_KEYS = INSTRUCTOR_DOCUMENTS.map((d) => d.key);

export function documentByKey(key) {
  return INSTRUCTOR_DOCUMENTS.find((d) => d.key === key) ?? null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Which documents this provider actually uses.
 *
 * Not every provider needs all seven — a chess tutor whose instructors never
 * drive should not have to write a driving acknowledgment before anyone can
 * finish onboarding. The choice is stored on
 * organizations.instructor_document_config, keyed by document key.
 *
 * ABSENT MEANS ON, AND THAT IS THE WHOLE SAFETY ARGUMENT. The tempting shortcut
 * is to treat "no published document" as "this provider doesn't use it" — but a
 * provider who fully intends to have a code of conduct and simply hasn't written
 * it yet would then silently onboard instructors who never acknowledged one.
 * Absence is not a decision. Only an explicit `false` turns a document off, so
 * an unwritten document keeps blocking onboarding exactly as it does today.
 *
 * These read the SAME shape from two places, which is deliberate:
 *   - the admin screen reads organizations.instructor_document_config directly;
 *   - the wizard reads public_org_directory.instructor_documents_public, which
 *     resolves each key to an explicit boolean (instructors cannot read
 *     `organizations` at all).
 * Both are "an object of key -> boolean where anything that isn't false is on",
 * so one predicate serves both and they cannot drift.
 *
 * MIRRORED SERVER-SIDE in supabase/functions/_shared/instructorDocumentConfig.ts
 * for the completion gate. Change one, change the other.
 * ──────────────────────────────────────────────────────────────────────────── */

export function isDocumentEnabled(config, key) {
  const meta = documentByKey(key);
  // The agreement is signed, not acknowledged, and onboarding cannot complete
  // without it. No stored value can switch it off.
  if (meta?.alwaysOn) return true;
  return config?.[key] !== false;
}

export function enabledDocumentKeys(config) {
  return DOCUMENT_KEYS.filter((k) => isDocumentEnabled(config, k));
}

/** The keys a given wizard screen reads, in the order it renders them. */
export function documentKeysForStep(step) {
  return INSTRUCTOR_DOCUMENTS.filter((d) => d.step === step).map((d) => d.key);
}

/** The keys a given wizard screen still reads once the config is applied. */
export function enabledDocumentKeysForStep(config, step) {
  return documentKeysForStep(step).filter((k) => isDocumentEnabled(config, k));
}

/**
 * Does this screen have anything left to show?
 *
 * False means the screen must be DROPPED from the wizard entirely, not rendered
 * empty — and dropped from the completion gate too, or the step key never gets
 * written to steps_completed and onboarding can never reach 'complete'. Same
 * rule effectiveStepOrder and gateCheck already apply to the background-check
 * and training steps.
 */
export function stepHasEnabledDocuments(config, step) {
  return enabledDocumentKeysForStep(config, step).length > 0;
}

/**
 * The version string for the next publication of a document.
 *
 * Operators never see or type this — asking a non-technical person to invent
 * "v2.0_2026-06-15" is the same jargon problem as making them type markdown.
 * The screen says "Version 2"; this produces the stored value.
 *
 * Takes the versions already stored for one (org, key) and returns the next
 * `v<n>`. Parses a leading integer out of whatever is there so hand-seeded
 * values still advance sensibly — J2S's real rows include 'v2.0_2026-06-15',
 * '3.0' and '1.0', so a naive count would collide with the UNIQUE constraint on
 * (organization_id, document_key, document_version).
 */
/**
 * The number to SHOW for a stored version string.
 *
 * Must use the same parse as nextVersionFor, or the screen and the database
 * disagree. It used to count rows: a document with one hand-seeded row named
 * 'v2.0_2026-06-15' displayed as "Version 1" and offered to publish "version 2",
 * while nextVersionFor correctly stored 'v3'. So the operator was told 2, the
 * row said v3, and the signed PDF was named agreement_v3 — nothing lined up for
 * anyone reconciling a signed document later.
 *
 * Falls back to the raw string when there is no integer in it, because showing
 * something odd is better than showing a confidently wrong number.
 */
export function versionNumberOf(versionString) {
  const m = /(\d+)/.exec(String(versionString ?? ''));
  return m ? parseInt(m[1], 10) : null;
}

export function nextVersionFor(existingVersions = []) {
  let highest = 0;
  for (const v of existingVersions) {
    const m = /(\d+)/.exec(String(v ?? ''));
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  // Never below the count: 'a' and 'b' parse to nothing but are still two
  // versions, and returning v1 for either would hit the unique constraint.
  const floor = Array.isArray(existingVersions) ? existingVersions.length : 0;
  return `v${Math.max(highest, floor) + 1}`;
}
