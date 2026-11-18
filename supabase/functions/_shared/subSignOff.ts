// Sign-off line for the sub emails (offer, decline alert, coordination, cancel).
//
// These used to take the FIRST WORD of `email_from_name ?? org.name`, which is
// right for a person ("Arielle Hammond" -> "Arielle") and wrong for an org name
// ("The Ukulele Project" -> "The @ The Ukulele Project", "Journey to STEAM" ->
// "Journey @ Journey to STEAM").
//
// A from-name that is a person signs as "First @ Org". A from-name that is just
// the org's own name (or no from-name at all) signs as the org. Returns plain
// text; HTML callers escape it.
export function subSignOff(
  orgName: string | null | undefined,
  emailFromName: string | null | undefined,
): string {
  const org = (orgName ?? '').trim();
  const fromName = (emailFromName ?? '').trim();
  if (fromName && fromName.toLowerCase() !== org.toLowerCase()) {
    const first = fromName.split(/\s+/)[0];
    return org ? `${first} @ ${org}` : first;
  }
  return org || 'the team';
}
