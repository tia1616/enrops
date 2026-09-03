import React from 'react';
import { PickupDismissalSection, CustomQuestionsSection, hasPickupSection } from './RegExtraFields.jsx';
import { GRADE_OPTIONS_LONG, gradeFitProblem } from '../../../lib/grades.js';
import { programsForChild } from '../../../lib/cartPrograms.js';
import { needsAftercareProvider } from '../../../lib/dismissal.js';
// The referral answers, incl. the tenant-derived "<provider> email" option, live
// in src/lib/referral.js so no tenant's channel can be written into this file
// again - see the note there and src/lib/referral.test.mjs.
import { referralOptions } from '../../../lib/referral.js';
// Catches a parent's own birth date in the child's field. Shared with
// Register.jsx's advance guard so the message and the block agree - see
// src/lib/studentBirthdate.js for why the band is loose.
import { birthdateProblem } from '../../../lib/studentBirthdate.js';

// Was a local list that stopped at 6th grade while operators could set a class to
// any grade, so a family whose child was in 7th could not pick a grade and could not
// register. Now the shared range, in parent wording. ADDITIVE - 7th through 12th are
// gained, nothing a family could already choose is taken away.
const GRADE_OPTIONS = GRADE_OPTIONS_LONG;

export default function StepStudent({ student, onUpdate, childIndex, regFields = { std: {}, custom: [] }, child = {}, onUpdateChild = () => {}, lean = false, orgName = '' }) {
  const { std = {}, custom = [] } = regFields;
  const referrals = referralOptions(orgName);
  const dobProblem = birthdateProblem(student.birthdate);
  // EVERY class this child is actually buying, VIP bundle legs included.
  //
  // Read through programsForChild rather than `item.program`: a VIP bundle is ONE
  // item holding three term rows, and reading the item's own program would check
  // only the Fall leg. StepReview matches per line and so would have caught a
  // Winter-only mismatch this screen had said nothing about - the form and the last
  // screen before the card disagreeing about the same child. One join, one answer,
  // and it has tests in src/lib/cartPrograms.test.mjs because neither screen can be
  // imported by the test runner.
  //
  // Deduped by message: the three legs of a bundle share a grade range, so without
  // this a VIP family would get the same sentence three times under one dropdown,
  // which reads as a bug rather than as emphasis.
  //
  // This step renders ONE child at a time, so the message needs no name to be
  // unambiguous about who it is about.
  //
  // Same call the advance guard makes, with the same provider name, so the box
  // under the field and the sentence beside the refused Continue press are the
  // same string rather than two that can drift.
  const gradeWarnings = [...new Set(
    programsForChild(child)
      .map((program) => gradeFitProblem(program, student.grade, orgName)?.message)
      .filter(Boolean),
  )];
  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        {childIndex === 0 ? 'About your student' : `About child ${childIndex + 1}`}
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        {/* Written to the PARENT. "Your roster" was the operator's word for it,
            addressed to the wrong person entirely. */}
        {lean
          ? 'We use this to save your child’s spot and keep their safety details on hand.'
          : 'We use this info for rosters, medical notes, and pickup.'}
      </p>

      {/* data-reg-field marks the field each advanceProblem() sentence is about,
          so the wizard's "Take me there" can find it without this component
          knowing the wizard exists. See src/lib/registerAdvance.js. */}
      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <div data-reg-field="student_first_name">
          <label className="label-field">First name *</label>
          <input
            className="input-field"
            value={student.first_name}
            onChange={(e) => onUpdate({ first_name: e.target.value })}
            autoComplete="off"
            name="student-first-name"
          />
        </div>
        <div data-reg-field="student_last_name">
          <label className="label-field">Last name *</label>
          <input
            className="input-field"
            value={student.last_name}
            onChange={(e) => onUpdate({ last_name: e.target.value })}
            autoComplete="off"
            name="student-last-name"
          />
        </div>
        {/* ASKED OF EVERY FAMILY, not just the legacy tenant's. Jessica, 2026-08-07:
            "lean org reg should ask for grades though." Providers can now state a
            grade range on a class, so a roster with no grade on it is a gap for
            exactly the operators who just gained the field.

            Required only where it always was (full-nav orgs, enforced in
            Register.jsx). For lean orgs it is OPTIONAL: /j2s/register is not the
            only live checkout any more, and adding a NEW blocking field to a
            working payment path is not something to do in the same pass that
            introduces the question. The asterisk follows the real rule rather than
            being decorative. */}
        <div data-reg-field="student_grade">
          {/* "(optional)" spelled out rather than just dropping the asterisk. Every
              sibling field here is starred, so an unmarked one reads as a mistake
              and a parent skips it - which defeats the point of asking. htmlFor/id
              because the label was naming nothing: a screen reader announced this
              only as "Select...". */}
          <label className="label-field" htmlFor={`student-grade-${childIndex}`}>
            Grade{lean ? " (optional)" : " *"}
          </label>
          <select
            id={`student-grade-${childIndex}`}
            className="input-field"
            value={student.grade}
            onChange={(e) => onUpdate({ grade: e.target.value })}
            aria-invalid={gradeWarnings.length ? 'true' : undefined}
            // Every message, space-separated, not just the first. A VIP bundle
            // whose terms carry different ranges renders more than one box, and
            // aria-describedby naming a single id would read one of them out and
            // silently drop the rest.
            aria-describedby={gradeWarnings.length
              ? gradeWarnings.map((_, i) => `student-grade-problem-${childIndex}-${i}`).join(' ')
              : undefined}
          >
            <option value="">Select&hellip;</option>
            {GRADE_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
          {/* THIS BLOCKS, so it wears the blocking colours. It was purple-soft
              while it was only a warning; Jessica made it a gate on 2026-09-03
              and the styling had to follow, because a box that stops a family
              must not look like the same box that does not. It is now the exact
              orange treatment the birth-date problem uses two fields below, which
              is the palette this form already uses for "you cannot go on".

              role="alert" and aria-invalid, both upgraded from the warning
              version for the same reason: the value now IS refused, and a screen
              reader that says otherwise would contradict the Continue button. */}
          {gradeWarnings.map((message, i) => (
            <div
              key={message}
              // Indexed, because more than one of these can render and a repeated
              // id is invalid HTML that resolves to the first match - the same
              // trap RegExtraFields already documents for its per-child inputs.
              id={`student-grade-problem-${childIndex}-${i}`}
              role="alert"
              className="mt-2 rounded-lg border-2 border-j2s-orange-dark/30 bg-j2s-orange-dark/5 px-4 py-3 text-sm text-j2s-orange-dark"
            >
              {message}
            </div>
          ))}
        </div>
        <div data-reg-field="student_birthdate">
          <label className="label-field" htmlFor={`student-birthdate-${childIndex}`}>Birth date *</label>
          <input
            id={`student-birthdate-${childIndex}`}
            type="date"
            className="input-field"
            value={student.birthdate}
            onChange={(e) => onUpdate({ birthdate: e.target.value })}
            required
            // The field a parent is most likely to fill with their OWN details,
            // so it stays out of the browser's identity autofill the same way
            // the name fields above do.
            autoComplete="off"
            name={`student-birthdate-${childIndex}`}
            aria-invalid={dobProblem ? 'true' : undefined}
            aria-describedby={dobProblem ? `student-birthdate-problem-${childIndex}` : undefined}
          />
          {/* Shown inline rather than only disabling Continue: a greyed-out
              button with no reason is the silent-wall pattern, and this is
              precisely the mistake nobody notices until the confirmation email
              greets the wrong person. */}
          {dobProblem && (
            <div
              id={`student-birthdate-problem-${childIndex}`}
              className="mt-2 rounded-lg border-2 border-j2s-orange-dark/30 bg-j2s-orange-dark/5 px-4 py-3 text-sm text-j2s-orange-dark"
              role="alert"
            >
              {dobProblem.message}
            </div>
          )}
        </div>
        {/* A NORMAL CONFIGURABLE QUESTION as of 2026-08-31, not a hardcoded one.
            This used to be `{!lean && ...}`, where `lean` is
            `instructor_pay_model !== 'legacy_own_platform'` - a BILLING column.
            Measured on prod 2026-08-28: j2s was the only active org of seven
            whose families were ever asked, and the providers who could not see
            it here could not see it in Registration Questions either, so one of
            them built a duplicate custom question. Now the provider decides,
            like the other standard questions, and j2s's row was seeded ON and
            REQUIRED in 20260831a so nothing changed for the families mid-season.

            Presence in `std` means enabled: get_active_registration_fields
            returns active rows only, which is the same test the dismissal,
            pickup and do-not-release questions below already use.

            Required as of 2026-08-24 for the org that asks it. Jessica, on FA26:
            42 of 118 confirmed registrations had no homeroom teacher, so
            instructors collecting a class from classrooms had nothing to go on
            for a third of the roster.

            The asterisk follows the REAL rule and is enforced in Register.jsx -
            the same pair as Grade above. "(optional)" is spelled out rather than
            left blank for exactly the reason the grade field spells it out: every
            sibling field here is starred, so an unmarked one reads as a mistake
            and a parent skips it. */}
        {std.homeroom_teacher && (
          <div data-reg-field="student_homeroom">
            <label className="label-field" htmlFor={`student-homeroom-${childIndex}`}>
              {std.homeroom_teacher.label || 'Homeroom teacher'}
              {std.homeroom_teacher.required ? ' *' : ' (optional)'}
            </label>
            <input
              id={`student-homeroom-${childIndex}`}
              className="input-field"
              value={student.homeroom_teacher}
              onChange={(e) => onUpdate({ homeroom_teacher: e.target.value })}
              placeholder="e.g. Ms. Smith"
            />
          </div>
        )}
      </div>

      <h2 className="mt-10 font-titan text-xl text-j2s-ink">Health &amp; safety</h2>
      <div className="mt-4 grid gap-5">
        <div>
          <label className="label-field">Allergies</label>
          <textarea
            className="input-field min-h-[70px]"
            value={student.allergies}
            onChange={(e) => onUpdate({ allergies: e.target.value })}
            placeholder="Food, environmental, etc. Leave blank if none."
          />
        </div>
        <div>
          <label className="label-field">Medical notes or accommodations</label>
          <textarea
            className="input-field min-h-[70px]"
            value={student.medical_notes}
            onChange={(e) => onUpdate({ medical_notes: e.target.value })}
            placeholder="Anything our instructor should know. Leave blank if none."
          />
        </div>
      </div>

      <h2 className="mt-10 font-titan text-xl text-j2s-ink">Emergency contact</h2>
      <p className="mt-1 text-sm text-j2s-ink/60">
        Someone we can reach if we can't reach you.
      </p>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div data-reg-field="emergency_name">
          <label className="label-field">Name *</label>
          <input
            className="input-field"
            value={student.emergency_contact_name}
            onChange={(e) => onUpdate({ emergency_contact_name: e.target.value })}
          />
        </div>
        <div data-reg-field="emergency_phone">
          <label className="label-field">Phone *</label>
          <input
            type="tel"
            className="input-field"
            value={student.emergency_contact_phone}
            onChange={(e) => onUpdate({ emergency_contact_phone: e.target.value })}
          />
        </div>
      </div>

      {hasPickupSection(std) && (
        <>
          <h2 className="mt-10 font-titan text-xl text-j2s-ink">Pickup &amp; dismissal</h2>
          <p className="mt-1 text-sm text-j2s-ink/60">Who we can release your child to.</p>
          <PickupDismissalSection
            std={std}
            // One child renders at a time in this wizard, so nothing collides
            // today. Passed anyway so it stays correct if the step ever shows
            // siblings side by side.
            instanceKey={`child-${childIndex}`}
            dismissalMethod={student.dismissal_method || ''}
            // Clear the provider name when the answer moves off aftercare, so a
            // name typed and then reconsidered cannot ride along to the roster
            // attached to an answer it no longer describes.
            onDismissalChange={(v) => onUpdate(
              needsAftercareProvider(v)
                ? { dismissal_method: v }
                : { dismissal_method: v, aftercare_provider: '' },
            )}
            aftercareProvider={student.aftercare_provider || ''}
            onAftercareProviderChange={(v) => onUpdate({ aftercare_provider: v })}
            pickup={child.authorized_pickup || []}
            onPickupChange={(v) => onUpdateChild({ authorized_pickup: v })}
            doNotRelease={child.do_not_release || []}
            onDoNotReleaseChange={(v) => onUpdateChild({ do_not_release: v })}
          />
        </>
      )}

      {custom.length > 0 && (
        <>
          <h2 className="mt-10 font-titan text-xl text-j2s-ink">A few more questions</h2>
          <CustomQuestionsSection
            fields={custom}
            answers={child.custom_answers || {}}
            onAnswer={(key, val) => onUpdateChild({ custom_answers: { ...(child.custom_answers || {}), [key]: val } })}
          />
        </>
      )}

      {!lean && (
        <>
          <h2 className="mt-10 font-titan text-xl text-j2s-ink">One last thing</h2>
          <div className="mt-4">
            <label className="label-field">How did you hear about us?</label>
            <select
              className="input-field"
              value={student.how_heard}
              onChange={(e) => onUpdate({ how_heard: e.target.value })}
            >
              <option value="">Select&hellip;</option>
              {referrals.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {student.how_heard === 'Other' && (
              <input
                className="input-field mt-3"
                placeholder="Please tell us how&hellip;"
                value={student.how_heard_other}
                onChange={(e) => onUpdate({ how_heard_other: e.target.value })}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
