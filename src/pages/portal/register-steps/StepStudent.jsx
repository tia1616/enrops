import React from 'react';
import { PickupDismissalSection, CustomQuestionsSection, hasPickupSection } from './RegExtraFields.jsx';

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

const GRADE_OPTIONS = [
  { value: '0', label: 'Kindergarten' },
  { value: '1', label: '1st grade' },
  { value: '2', label: '2nd grade' },
  { value: '3', label: '3rd grade' },
  { value: '4', label: '4th grade' },
  { value: '5', label: '5th grade' },
  { value: '6', label: '6th grade' },
];

export default function StepStudent({ student, onUpdate, childIndex, regFields = { std: {}, custom: [] }, child = {}, onUpdateChild = () => {}, lean = false }) {
  const { std = {}, custom = [] } = regFields;
  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        {childIndex === 0 ? 'About your student' : `About child ${childIndex + 1}`}
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        {lean
          ? 'We use this to build your roster and keep safety info on hand.'
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
        {!lean && (
          <div>
            <label className="label-field">Grade *</label>
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
        )}
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
