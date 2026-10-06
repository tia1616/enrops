// Formats a set of real child first names into one readable phrase, for the
// {{child_first_name}} token in marketing-touchpoint-send and the review_request
// resolver in lifecycle-automations-cron. ONE resolver, two callers — see
// 20261006d_campaign_child_name_resolver.sql for the SQL half (which decides
// WHICH names apply to a given recipient's registration); this is just the
// shared "how do we say two or three names" formatting, kept in one place so
// a campaign send and a review request never phrase a sibling list differently.
//
// Trims, drops blanks, and de-dupes (a family with the same child on two
// matching registrations — e.g. two sessions of the same camp — must not
// read "Ava and Ava").
export function formatChildNameList(names: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of names) {
    const n = raw?.trim();
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(n);
  }
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
}
