import React from 'react';
import { PickupDismissalSection, CustomQuestionsSection, hasPickupSection } from './RegExtraFields.jsx';
import { GRADE_OPTIONS_LONG } from '../../../lib/grades.js';

// Tenant-neutral referral options shared by every operator's registration flow.
// (Replaced J2S-specific entries — "STEAM Night", "PDX Parent", "NW Kids",
// "Kids Out and About" — which leaked Journey to STEAM's Portland-area channels
// to other tenants. Per-tenant configurable options are a queued follow-up.)
const REFERRAL_OPTIONS = [
  'School flyer (from my child\'s school)',
  'School newsletter, PTO, or PTA email',
  'Friend or family referral',
  'Social media (Facebook, Instagram)',
  'Google search',
  'Community event or fair',
  'Local parenting magazine or website',
  'Other',
];

// Was a local list that stopped at 6th grade while operators could set a class to
// any grade, so a family whose child was in 7th could not pick a grade and could not
// register. Now the shared range, in parent wording. ADDITIVE - 7th through 12th are
// gained, nothing a family could already choose is taken away.
const GRADE_OPTIONS = GRADE_OPTIONS_LONG;

export default function StepStudent({ student, onUpdate, childIndex, regFields = { std: {}, custom: [] }, child = {}, onUpdateChild = () => {}, lean = false }) {
  const { std = {}, custom = [] } = regFields;
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

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <div>
          <label className="label-field">First name *</label>
          <input
            className="input-field"
            value={student.first_name}
            onChange={(e) => onUpdate({ first_name: e.target.value })}
            autoComplete="off"
            name="student-first-name"
          />
        </div>
        <div>
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
        <div>
          <label className="label-field">Grade{lean ? "" : " *"}</label>
          <select
            className="input-field"
            value={student.grade}
            onChange={(e) => onUpdate({ grade: e.target.value })}
          >
            <option value="">Select&hellip;</option>
            {GRADE_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-field">Birth date *</label>
          <input
            type="date"
            className="input-field"
            value={student.birthdate}
            onChange={(e) => onUpdate({ birthdate: e.target.value })}
            required
          />
        </div>
        {!lean && (
          <div>
            <label className="label-field">Homeroom teacher</label>
            <input
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
        <div>
          <label className="label-field">Name *</label>
          <input
            className="input-field"
            value={student.emergency_contact_name}
            onChange={(e) => onUpdate({ emergency_contact_name: e.target.value })}
          />
        </div>
        <div>
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
            dismissalMethod={student.dismissal_method || ''}
            onDismissalChange={(v) => onUpdate({ dismissal_method: v })}
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
              {REFERRAL_OPTIONS.map((r) => (
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
