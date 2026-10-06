// The ONE list of merge tokens a marketing campaign email is allowed to use.
//
// WHY THIS FILE EXISTS. marketing-draft-campaign (Ennie's drafting pass) and
// marketing-touchpoint-send (the actual send) used to each keep their OWN
// copy of this set, "KEPT IN SYNC" by a comment in each file. That is exactly
// how program_name/program_name_url shipped broken on 2026-10-01: the send
// path's copy never got the new tokens added, so every occurrence silently
// rendered as "" (replaceTokens drops an unrecognized token to empty, by
// design, so nothing errored) — a live campaign's star links all read
// "...&p=" with nothing after it, for all 229 real recipients. A comment is
// not a mechanism; this file is the mechanism.
//
// Both callers use this the same way: `APPROVED_TOKENS.has(key)` gates
// whether a `{{key}}` in a template renders or gets silently dropped to "".
// Adding a new per-recipient or per-org token means adding it HERE once —
// both the drafting guardrail and the actual send immediately agree.
export const APPROVED_MARKETING_TOKENS = new Set([
  "first_name", "parent_name", "child_first_name", "child_last_name",
  "school", "city", "zip", "geo_segment", "unsubscribe_url",
  "org_name", "sender_name", "sender_email", "register_url", "register_button", "reply_to",
  "logo_url", "closer", "phone", "website",
  "savings", "early_bird_price", "regular_price", "early_bird_deadline",
  "first_session_date", "session_count", "day_of_week", "curriculum", "vip_price",
  // The day registration closes for THIS recipient's program:
  // first_session_date - organizations.registration_close_days_before. Per
  // recipient, so one campaign spanning schools that start on different days
  // states the right deadline to each parent instead of the earliest one to
  // everybody. Empty for camps (see the camps branch), when the program has no
  // first_session_date, and when a school's picked programs do not share one
  // close date — a deadline that is right for only some of the programs named
  // in the same sentence is worse than no deadline at all.
  "registration_close_date",
  // Per-program list for THIS recipient's school: an HTML <ul>, one <li> per
  // program, each carrying its OWN day, start date, session count and sign-up
  // deadline. The afterschool sibling of {{camp_details}}.
  //
  // This is the honest answer for a multi-program school. The inline tokens
  // above describe ONE program while {{curriculum}} names them all, so at a
  // school running two classes on different dates they can only ever be right
  // about one of them. A block per program is right about each, and because it
  // renders as a whole <ul> or as nothing, it cannot leave the half-sentence an
  // empty inline token leaves behind ("sign-ups close on .").
  "program_details",
  "topic", "topics_list", "promo_code", "promo_amount",
  // VIP/annual-pass block: resolves to an HTML <p> built from org.vip_offering
  // for recipients whose school offers it, and to an empty string for
  // recipients whose school is in org.vip_offering.excluded_location_ids (or
  // when the org has no offering enabled). This is the per-school suppression
  // mechanism — same body_html, different rendered output per recipient.
  "vip_block",
  // Per-area camp list (camps mode): an HTML <ul> with each picked camp's name,
  // venue, and date range in THIS recipient's area. Empty for afterschool
  // campaigns.
  "camp_details",
  // Plain-text and URL-safe forms of the recipient's program_name snapshot —
  // added 2026-10-06, see the file header above. Two tokens, not one:
  // {{program_name}} is prose and gets escapeHtml()'d like every other token;
  // {{program_name_url}} is for an href query string and must be
  // percent-encoded instead, or a curriculum name containing "&" (e.g.
  // "Minecraft Makers: Coding & Game Design") truncates the query string at
  // its own ampersand.
  "program_name", "program_name_url",
]);
