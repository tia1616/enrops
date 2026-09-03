// WHY THE REGISTRATION WIZARD'S "CONTINUE" BUTTON CAN NEVER GO GREY IN SILENCE.
//
// Register.jsx used to answer "may this family move on?" with a bare boolean.
// Every `return false` knew exactly which requirement had failed and threw that
// knowledge away, so three conditions could stop a family dead with nothing
// anywhere on the page explaining why:
//
//   - authorized_pickup marked required, no fully-named person   (step 0)
//   - do_not_release marked required, no fully-named person      (step 0)
//   - guardian_secondary marked required, no first + last name   (step 1)
//
// All three are LIST-shaped, which is what made them invisible. An unanswered
// text field at least looks empty; an unanswered list looks like a list. The
// pickup question makes it worse by sitting under helper text that reads "You
// don't need to list yourself", so a family with nobody else to name reads that
// as permission to leave it blank, and then Continue just stops working.
//
// The fix is the one `birthdateProblem()` and `PickupInfoGate.problemFor()`
// already use here: ONE function answers both "is this blocked" and "what do we
// tell them", so the button and the message cannot disagree.
//
// WHY CONTINUE IS NOT DISABLED. The first version of this greyed the button out
// and put the sentence beside it, and Jessica read straight past it - "looks
// like just a part of the form to fill out". That is the documented failure of
// disabled submit buttons: nothing ever responds to the parent, so an
// explanation sitting on the page is page furniture rather than an answer. The
// established guidance is to leave the control enabled, validate when it is
// pressed, and say what is wrong then. So callers keep Continue live, call this
// on click, and only show the warning once a press has actually been refused.
//
// `focus` names the field the sentence is about, matched in the DOM by
// `[data-reg-field="..."]`. One step renders at a time, so exactly one element
// carries any given key and callers do not need to know which component owns it.
//
// Pure and dependency-light on purpose - it is imported by a .test.mjs that node
// runs directly, so nothing in this file may reach a .jsx module.
//
// `conflicts` is still passed IN rather than computed here, even though
// pickupDnrConflicts moved to lib/studentCare.js on 2026-08-31 and is now
// reachable: Register.jsx already computes it for the inline warning beside the
// list, so taking it as a parameter means the warning and the block are looking
// at the same array rather than at two evaluations of the same rule. The three
// post-checkout editors call careProblem(), which DOES compute it - they have no
// second caller to agree with.
import { needsAuthorizedPickup, dismissalAnswerIncomplete } from './dismissal.js';
import { birthdateProblem } from './studentBirthdate.js';
import { namedContacts } from './registrationFields.js';
import { gradeFitProblem } from './grades.js';
import { programsForChild } from './cartPrograms.js';

// The grade gate, in one place so step 0 and step 3 cannot disagree about it.
//
// Reads EVERY class the child is buying, VIP bundle legs included, and returns
// the first that does not fit. `gradeFitProblem` decides what "does not fit"
// means and stays silent for an unanswered grade, an age-based class, a class
// with no stated range and a class whose own range reads backwards - so this
// blocks only where there is a real, stated mismatch.
function gradeGate(child, orgName) {
  for (const program of programsForChild(child)) {
    const problem = gradeFitProblem(program, child?.student?.grade, orgName);
    if (problem) return problem;
  }
  return null;
}

// Has the parent answered a custom question? (by field type)
export function hasAnswer(value, type) {
  if (type === 'multiselect') return Array.isArray(value) && value.length > 0;
  if (type === 'checkbox') return value === true || value === 'true';
  if (type === 'number') return value !== undefined && value !== null && String(value).trim() !== '';
  return typeof value === 'string' ? value.trim() !== '' : value != null;
}

// The name rule is NOT spelled again here - it is imported, because the
// parent-portal pickup gate applies the same one to rows that land in the same
// table, and the two used to disagree.
const fullyNamed = namedContacts;

// One blocking reason, with the field it belongs to.
function stop(focus, message) {
  return { focus, message };
}

/**
 * What (if anything) stops this family advancing from `step`?
 *
 * Returns null when the step is complete, otherwise ONE reason a parent can act
 * on: `{ focus, message }`. First failure wins, in the order the questions
 * appear on the page, so it always points at the topmost thing still missing
 * rather than at whichever check happened to be written last.
 *
 * Steps are 0=Student, 1=Parent, 2=Waivers, 3=Review, 4=Pay.
 *
 * @returns {null | { focus: string, message: string }}
 */
export function advanceProblem({
  step,
  isLean,
  activeChild,
  parent,
  regFields,
  waivers,
  conflicts,
  orgName,
  // The whole cart, for the review step only. Optional: every other step is about
  // the child in front of the parent, and passing it is what lets the last press
  // before the card speak for all of them.
  children,
} = {}) {
  const std = regFields?.std || {};
  const child = activeChild || {};

  switch (step) {
    case 0: {
      const s = child.student || {};
      // These truthiness checks are deliberately IDENTICAL to the ones that used
      // to gate the button - including `s.grade !== ''` letting undefined
      // through. Tightening one of them here would newly block a family who can
      // submit today, which is a different change from telling them why they are
      // blocked, and this one is not that change.
      if (!s.first_name) return stop('student_first_name', "Add your child's first name.");
      if (!s.last_name) return stop('student_last_name', "Add your child's last name.");
      if (!isLean && s.grade === '') return stop('student_grade', "Choose your child's grade.");
      // Homeroom is a CONFIGURED question as of 2026-08-31, not a lean-vs-legacy
      // one - see StepStudent.jsx. The guard now reads the same flag the label's
      // asterisk reads, so the two cannot disagree; `isLean` still decides grade
      // above, which is a different question and stays as it was.
      if (std.homeroom_teacher?.required && !(s.homeroom_teacher || '').trim()) {
        return stop('student_homeroom', "Add your child's homeroom teacher.");
      }
      if (!s.birthdate) return stop('student_birthdate', "Add your child's date of birth.");
      if (!s.emergency_contact_name) return stop('emergency_name', 'Add an emergency contact name.');
      if (!s.emergency_contact_phone) return stop('emergency_phone', 'Add an emergency contact phone number.');

      // StepStudent already renders this one against the field itself. Repeating
      // it beside the button is not noise: the birth date sits far enough up the
      // form that on a phone the inline message and the grey button are never on
      // screen together, and the same string in both places cannot drift.
      const dob = birthdateProblem(s.birthdate);
      if (dob) return stop('student_birthdate', dob.message);

      // THE GRADE GATE. Jessica, 2026-09-03: "we shouldn't allow people to
      // register if they're not in the grade range. shouldn't be a warning should
      // be a gate." It sits AFTER the birth date deliberately - a family who has
      // mistyped the year should be told about that first, since correcting it is
      // more likely than the grade being genuinely wrong.
      //
      // Blocking here rather than only at the end is the whole point: the last
      // thing this platform wants is a family who has filled in every screen and
      // signed the waivers before being told no.
      const gradeProblem = gradeGate(child, orgName);
      if (gradeProblem) return stop('student_grade', gradeProblem.message);

      if (std.dismissal_method?.required && !s.dismissal_method) {
        return stop('dismissal_method', 'Choose how your child leaves at the end of class.');
      }
      // "Aftercare" with no program named answers the category and withholds the
      // destination - the one detail the answer exists to supply.
      if (dismissalAnswerIncomplete(s.dismissal_method, s.aftercare_provider)) {
        return stop('aftercare_provider', 'Add which aftercare program your child goes to.');
      }

      // THE WALL THIS FILE WAS WRITTEN FOR. Says "first and last name" out loud,
      // because a half-filled row looks answered and reads as a working form.
      if (std.authorized_pickup?.required && (needsAuthorizedPickup(s.dismissal_method) || !std.dismissal_method)) {
        if (fullyNamed(child.authorized_pickup).length === 0) {
          return stop('authorized_pickup', 'Add a first and last name for at least one person who can pick up your child.');
        }
      }
      if (std.do_not_release?.required && fullyNamed(child.do_not_release).length === 0) {
        return stop('do_not_release', 'Add a first and last name for anyone we should not release your child to.');
      }

      // NO BLOCK ON A ONE-NAME ROW, deliberately. A draft of this demanded both
      // names on every row and it was wrong: prod's three single-name pickup
      // entries read "Club K Teachers", "Casey Negrieff" and "AINSWORTH
      // AFTERCARE - MOST DAYS". Families use this box as free text, so asking
      // for a surname would have told a parent to add a last name for an
      // after-school club, with deleting a real instruction as the only way
      // past. One name is kept and saved; it just does not by itself satisfy a
      // question marked mandatory. See contactsWithAnyName in registrationFields.

      // Named with the provider's own label, since a custom question is whatever
      // they wrote and "answer the required question" would send a parent hunting.
      for (const f of regFields?.custom || []) {
        if (f.is_required && !hasAnswer(child.custom_answers?.[f.field_key], f.field_type)) {
          return stop(
            `custom:${f.field_key}`,
            f.label ? `Answer "${f.label}".` : 'Answer the required question above.',
          );
        }
      }

      // RegExtraFields shows a richer named warning up at the list itself; this
      // is the same fact where the parent is looking when the button fails them.
      if ((conflicts || []).length > 0) {
        return stop('do_not_release', "A name is on both the pickup and do-not-release lists. The same person can't be on both - remove it from one.");
      }
      return null;
    }
    case 1: {
      const p = parent || {};
      if (!p.first_name) return stop('parent_first_name', 'Add your first name.');
      if (!p.last_name) return stop('parent_last_name', 'Add your last name.');
      if (!p.email) return stop('parent_email', 'Add your email address.');
      if (!p.phone) return stop('parent_phone', 'Add your phone number.');
      if (std.guardian_secondary?.required) {
        const g = p.guardian2 || {};
        if (!(g.first_name || '').trim() || !(g.last_name || '').trim()) {
          const label = std.guardian_secondary.label || 'second parent or guardian';
          return stop('guardian_secondary', `Add a first and last name for the ${label.toLowerCase()}.`);
        }
      }
      return null;
    }
    case 2: {
      // Names the form still unsigned rather than saying "agree to the waivers",
      // which on a page of several is a scavenger hunt.
      const unsigned = (waivers || []).filter(
        (w) => w.required && child.waivers?.[w.id]?.agreed !== true,
      );
      if (unsigned.length === 0) return null;
      const focus = `waiver:${unsigned[0].id}`;
      if (unsigned.length === 1) {
        return stop(focus, unsigned[0].name
          ? `Tick the box to agree to the ${unsigned[0].name.toLowerCase()}.`
          : 'Tick the box to agree to the required form.');
      }
      return stop(focus, `Tick the box on each required form - ${unsigned.length} still need your agreement.`);
    }
    case 3:
      // The review screen, and the last press before the card. Step 0 already
      // refuses an out-of-range grade, so reaching here with one means the cart
      // was restored from an earlier session or the grade changed underneath -
      // rare, and precisely why the money press gets its own check rather than
      // trusting a guard three screens back.
      //
      // Empty focus, not 'student_grade': that field is three screens back and
      // not in the DOM here, so naming it would scroll to nothing. The message
      // still says which class and what to do.
      //
      // EVERY CHILD, not just the active one. Step 0 gates each child as they are
      // filled in, but this screen pays for the whole cart at once - and the
      // review lines already draw a red box for every affected child. Checking
      // only the active child let the button through while the screen showed the
      // refusal, and the server then refused the press in its own words. Falls
      // back to the active child when the caller passes no cart, so the guard
      // never gets quietly weaker than it was.
      {
        const all = Array.isArray(children) && children.length ? children : [child];
        for (const c of all) {
          const late = gradeGate(c, orgName);
          if (late) return stop('', late.message);
        }
        return null;
      }
    default:
      // Unreachable while Continue only renders for steps 0-3, but a reason
      // beats `false` if a step is ever added and this switch is not.
      return stop('', 'Finish this step to continue.');
  }
}
