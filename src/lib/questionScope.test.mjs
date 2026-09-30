// Pins which registration questions a family is actually asked, once a question
// can be aimed at after-school families or camp families.
//
// The failure this replaces: homeroom teacher is REQUIRED and a camp has no
// classroom to collect from, so a camp family was asked a question with no
// answer and the registration stopped dead. That was fixed with a rule written
// into the form. This makes it configuration, and these tests are what stop the
// configuration being read the wrong way round — the direction that blocks a
// real family from finishing a registration.
import { strict as assert } from "node:assert";
import test from "node:test";
import { questionAppliesToCart } from "./registrationFields.js";

const camp = { id: "c", isCamp: true };
const klass = { id: "k", isCamp: false };
const isCamp = (it) => !!it?.isCamp;

const ALL = { appliesTo: "all", appliesToValue: null };
const AFTERSCHOOL = { appliesTo: "enrollment_type", appliesToValue: "afterschool" };
const CAMP_ONLY = { appliesTo: "enrollment_type", appliesToValue: "camp" };

test("a question for everyone is untouched by the cart", () => {
  assert.equal(questionAppliesToCart(ALL, [camp], isCamp), true);
  assert.equal(questionAppliesToCart(ALL, [klass], isCamp), true);
  assert.equal(questionAppliesToCart(ALL, [], isCamp), true);
});

test("a program-scoped question is left alone — the database already resolved it", () => {
  const scoped = { appliesTo: "program", appliesToValue: "some-uuid" };
  assert.equal(questionAppliesToCart(scoped, [camp], isCamp), true);
});

test("an after-school question is dropped only when EVERY item is a camp", () => {
  assert.equal(questionAppliesToCart(AFTERSCHOOL, [camp], isCamp), false);
  assert.equal(questionAppliesToCart(AFTERSCHOOL, [camp, camp], isCamp), false);
  // The mixed cart is the one that matters: the class still needs the answer.
  assert.equal(questionAppliesToCart(AFTERSCHOOL, [camp, klass], isCamp), true);
  assert.equal(questionAppliesToCart(AFTERSCHOOL, [klass], isCamp), true);
});

test("a camp question is asked as soon as ANY item is a camp", () => {
  assert.equal(questionAppliesToCart(CAMP_ONLY, [camp], isCamp), true);
  assert.equal(questionAppliesToCart(CAMP_ONLY, [camp, klass], isCamp), true);
  assert.equal(questionAppliesToCart(CAMP_ONLY, [klass], isCamp), false);
});

test("an empty cart asks everything rather than silently hiding a required question", () => {
  // Nothing has been chosen to rule a question out. Dropping a required question
  // here would block the family with nothing on screen explaining why.
  assert.equal(questionAppliesToCart(AFTERSCHOOL, [], isCamp), true);
  assert.equal(questionAppliesToCart(CAMP_ONLY, [], isCamp), true);
  assert.equal(questionAppliesToCart(AFTERSCHOOL, null, isCamp), true);
  assert.equal(questionAppliesToCart(AFTERSCHOOL, undefined, isCamp), true);
});

test("an unrecognised enrolment type fails towards ASKING, never towards hiding", () => {
  const nonsense = { appliesTo: "enrollment_type", appliesToValue: "weekend_intensive" };
  assert.equal(questionAppliesToCart(nonsense, [camp], isCamp), true);
  assert.equal(questionAppliesToCart(nonsense, [klass], isCamp), true);
  // Same for a scope row saved with no value at all.
  const noValue = { appliesTo: "enrollment_type", appliesToValue: null };
  assert.equal(questionAppliesToCart(noValue, [camp], isCamp), true);
});

test("a missing scope object is treated as 'ask everyone'", () => {
  assert.equal(questionAppliesToCart(undefined, [camp], isCamp), true);
  assert.equal(questionAppliesToCart(null, [camp], isCamp), true);
  assert.equal(questionAppliesToCart({}, [camp], isCamp), true);
});

test("nulls in the cart do not count as a class and resurrect a camp-only question", () => {
  // A half-loaded item must not read as "not a camp" and flip an after-school
  // question back on for a camp-only family.
  assert.equal(questionAppliesToCart(AFTERSCHOOL, [camp, null], isCamp), false);
  assert.equal(questionAppliesToCart(CAMP_ONLY, [null, camp], isCamp), true);
});
