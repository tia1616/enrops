// "How did you hear about us?" - the one definition of the answers we offer.
//
// WHY THIS FILE EXISTS. The list used to live inside StepStudent.jsx and once
// carried Journey to STEAM's own Portland-area channels ("STEAM Night", "PDX
// Parent", "NW Kids", "Kids Out and About"), which every other tenant's families
// then saw on their registration page. Those were removed; this module exists so
// the next channel worth adding has somewhere tenant-neutral to go, and so the
// rule can be pinned by referral.test.mjs instead of by a comment.
//
// Same shape as src/lib/grades.js and src/lib/dismissal.js: the vocabulary is
// data, in one place, with a test.

// Channels that mean the same thing for every operator. Nothing here names a
// tenant, a city, or a publication.
export const REFERRAL_OPTIONS = [
  'School flyer (from my child\'s school)',
  'School newsletter, PTO, or PTA email',
  'Friend or family referral',
  'Social media (Facebook, Instagram)',
  'Google search',
  'Community event or fair',
  'Local parenting magazine or website',
  'Other',
];

// The option this sits next to, so the two email answers stay together. Named
// rather than indexed: a reorder of the list above must not silently move this.
const EMAIL_ANCHOR = 'School newsletter, PTO, or PTA email';

// The operator's own mailing list is a real channel families arrive from, but
// the LABEL has to be the tenant's name or it puts one provider's brand on
// another's form. So it is derived from organizations.name at render time and
// never written down: J2S families read "Journey to STEAM email", Shoreview
// Chess families read "Shoreview Chess email".
//
// No org name (missing, or an org row that never set one) = the option is not
// offered at all, rather than asking a family whether they heard from
// "undefined email".
//
// Answers are stored as free text in parent_org_relationships.how_heard and
// registrations.how_heard - no CHECK constraint on either column - so adding a
// label cannot invalidate a registration that already chose something else.
export function referralOptions(orgName) {
  const name = typeof orgName === 'string' ? orgName.trim() : '';
  if (!name) return REFERRAL_OPTIONS;
  const at = REFERRAL_OPTIONS.indexOf(EMAIL_ANCHOR);
  const insertAt = at === -1 ? REFERRAL_OPTIONS.length - 1 : at + 1;
  return [
    ...REFERRAL_OPTIONS.slice(0, insertAt),
    `${name} email`,
    ...REFERRAL_OPTIONS.slice(insertAt),
  ];
}
