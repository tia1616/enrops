// Which start date a school's {{registration_close_date}} is counted back from.
//
// A school can run several picked classes that start on different days (Jackson:
// Mon Jan 11 + Tue Jan 12; Bonny Slope: Wed Jan 13 + Fri Jan 15). The token sits
// inside ONE sentence ("Register by {{registration_close_date}} to be sure of your
// spot"), so it can carry one date. It used to render EMPTY whenever the classes
// disagreed, which left the sentence broken - "Register by  to be sure of your
// spot" - in the Dec 15 subject and body for Jackson (found 2026-11-04).
//
// Jessica's rule (2026-11-04): show the EARLIEST. It is true for every class at the
// school: register by then and every spot is safe. The latest would invite a parent
// to wait past the earlier class's date. Each class's own date still prints beside
// it in {{program_details}}.
//
// Still null - so the token stays empty and the sentence is dropped, never guessed -
// when there is nothing to count back from: no programs, or ANY class with no start
// date, because the date would then be right for only some of the classes named.
export function earliestStartDate(dates: Array<string | null | undefined>): string | null {
  if (!dates || dates.length === 0) return null;
  const cleaned: string[] = [];
  for (const d of dates) {
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return null;
    cleaned.push(d.trim());
  }
  // ISO dates sort correctly as strings.
  return cleaned.sort()[0];
}
