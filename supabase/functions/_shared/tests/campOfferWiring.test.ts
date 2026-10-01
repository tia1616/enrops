// Are the three instructor-offer emails actually WIRED to campProgram.ts?
//
// WHAT THIS IS, HONESTLY. campProgram.test.ts proves the decision - what a camp's
// day label and run label should say. It cannot prove the emails ASK it, because
// each of these functions is an index.ts that calls serve() at import time, so a
// Deno test cannot import one to render it. This is therefore a SOURCE guard, the
// same construction and the same reason as offerCopyTwinParity.test.ts.
//
// It is here because the bug it guards is a wiring bug, not a logic bug: every one
// of these three files had a correct-looking dayLabel() that read day_of_week and
// stopped, so a Mon-Thu winter break camp was offered to an instructor as
// "Mondays 9:00-3:00 - all term". Both halves false, in the email that asks them
// to commit. A perfect campProgram.ts that nobody calls fixes none of that.
//
// The live render is NOT proven by this file. It is proven by sending the offer
// preview for a camp on staging and reading it.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const FUNCTIONS = [
  "send-afterschool-offers",
  "send-afterschool-patch-offer",
  "offer-reminders-cron",
];

// offer-message-reply is the fourth function in this loop and had the same bug,
// but it prints only the day label - no "all term", no programs select of the
// same shape - so it gets its own narrower guard rather than being forced into
// the loop above and weakening what that loop asserts.
Deno.test("offer-message-reply: a camp in the message thread is not 'Mondays'", async () => {
  const src = await Deno.readTextFile(
    new URL("../../offer-message-reply/index.ts", import.meta.url),
  );
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(
    /from '\.\.\/_shared\/campProgram\.ts'/.test(code),
    "offer-message-reply does not import campDayLabel",
  );
  assert(
    code.includes("class_days"),
    "offer-message-reply's programs select is missing class_days, so campDayLabel() always returns ''",
  );
  assertEquals(
    /subLine = \[dayLabel\(prog\.day_of_week\)/.test(code),
    false,
    "offer-message-reply's sub-line reads day_of_week directly again",
  );
});

async function sourceOf(fn: string): Promise<string> {
  const url = new URL(`../../${fn}/index.ts`, import.meta.url);
  return await Deno.readTextFile(url);
}

// Comments in these files quote the old wording on purpose, to say what the bug
// was. Only CODE may be judged.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

for (const fn of FUNCTIONS) {
  Deno.test(`${fn}: asks campProgram.ts instead of reading day_of_week alone`, async () => {
    const code = codeOnly(await sourceOf(fn));
    assert(
      /from '\.\.\/_shared\/campProgram\.ts'/.test(code),
      `${fn} does not import _shared/campProgram.ts`,
    );
  });

  Deno.test(`${fn}: selects the three columns that make a camp visible`, async () => {
    // THE READ/SELECT CONTRACT. class_days is what makes a camp a camp, and
    // first_session_date/end_date are what it runs on instead of "all term".
    // Left out of the .select(), every row arrives looking like a weekly class
    // and the whole fix is silently inert - no error, no crash, just the old
    // wrong email. This is the failure mode that is invisible in review.
    const code = codeOnly(await sourceOf(fn));
    const select = code.match(/\.select\('id, curriculum, day_of_week[^']*'\)/);
    assert(select, `${fn}: could not find the programs select`);
    for (const col of ["class_days", "first_session_date", "end_date"]) {
      assert(select[0].includes(col), `${fn}: programs select is missing ${col}`);
    }
  });

  Deno.test(`${fn}: no template still hard-codes "all term"`, async () => {
    // Both halves of each email. The plain-text half is the one that drifts,
    // because nobody reads it back.
    const code = codeOnly(await sourceOf(fn));
    assertEquals(
      code.includes("all term"),
      false,
      `${fn}: a template still says "all term" literally rather than asking programRunLabel()`,
    );
  });

  Deno.test(`${fn}: the schedule line does not feed day_of_week straight in`, async () => {
    // dayLabel()/dayName() still exist and are still correct FOR A CLASS - they
    // are reached through whenLabel(), which tries the camp first. What must not
    // come back is a template interpolating them directly, which is what made a
    // camp read "Mondays".
    const code = codeOnly(await sourceOf(fn));
    for (const bad of ["dayLabel(p.day_of_week)", "dayName(p.day_of_week"]) {
      assertEquals(
        code.includes(bad),
        false,
        `${fn}: ${bad} is back in a template - a camp will read as its first day`,
      );
    }
  });
}

Deno.test("match-afterschool matches a camp on EVERY day it runs", async () => {
  // This guard used to pin the opposite: camps were excluded, because the whole
  // schedule model was one weekday per program and a camp run through it would
  // be matched as its FIRST day. Camps are now matched (2026-10-01) on their own
  // rules, and what has to hold is that none of the old one-weekday reasoning
  // survives on the camp path - that is the shape that double-books someone for
  // the three days their camp runs after the first.
  const src = await Deno.readTextFile(
    new URL("../../match-afterschool/index.ts", import.meta.url),
  );
  const code = codeOnly(src);
  assert(
    /from '\.\.\/_shared\/campProgram\.ts'/.test(code),
    "match-afterschool does not import the camp predicates",
  );
  assert(
    code.includes("programWeekdays"),
    "match-afterschool is not asking programWeekdays, so a camp occupies only its first day again",
  );
  assertEquals(
    /\.filter\(\(p: any\) => !isCampProgram\(p\)\)/.test(code),
    false,
    "match-afterschool is excluding camps from the matched set again",
  );
  // OCCUPANCY AND CONFLICT ARE THE TWO THAT BITE. Either one reading
  // day_of_week directly books a Mon-Thu camp as a Monday and leaves the
  // instructor free on the other three.
  assertEquals(
    /function addSlot[\s\S]{0,200}?dayCode\(prog\.day_of_week\)/.test(code),
    false,
    "addSlot reads day_of_week again, so a camp occupies one day instead of four",
  );
  assertEquals(
    /function wouldConflict[\s\S]{0,200}?dayCode\(prog\.day_of_week\)/.test(code),
    false,
    "wouldConflict reads day_of_week again, so a camp is only checked against its first day",
  );
  // A camp's availability comes from the survey's camp question, never from the
  // after-school weekday window - "Mondays from 1:00" says nothing about 9-3.
  assert(
    code.includes("camp_availability"),
    "match-afterschool's availability select is missing camp_availability, so campYes is always empty and no camp is ever matched",
  );
  assert(
    /inst\.campYes\.has\(prog\.id\)/.test(code),
    "camp eligibility is no longer gated on an explicit yes to THAT camp",
  );
  assert(
    code.includes("class_days"),
    "match-afterschool's programs select is missing class_days, so isCampProgram() sees undefined and nothing is a camp",
  );
});

// ---------------------------------------------------------------------------
// The two surfaces outside the offer emails that still read day_of_week and
// stopped, found by sweeping every place the Deno side pluralises a weekday
// (2026-10-01). Same construction and the same reason as the guards above: the
// decision is proved in campProgram.test.ts, this proves the caller ASKS it.
// ---------------------------------------------------------------------------

Deno.test("email-program-roster: a camp roster to a school is not 'Mondays'", async () => {
  // The roster PDF, its covering email and the subject line all described a
  // Mon-Thu camp as "Mondays from December 21" to the school partner.
  const src = await Deno.readTextFile(
    new URL("../../email-program-roster/index.ts", import.meta.url),
  );
  const code = codeOnly(src);
  assert(
    /from '\.\.\/_shared\/campProgram\.ts'/.test(code),
    "email-program-roster does not import programScheduleLabel",
  );
  assert(
    code.includes("class_days") && code.includes("end_date"),
    "email-program-roster's programs select is missing class_days/end_date, so a camp reads as its first day again",
  );
  assert(
    /isCampProgram\(program\)/.test(code),
    "email-program-roster no longer branches on isCampProgram, so camps take the weekly path",
  );
  // The PDF header is the half nobody re-reads: it had its OWN copy of the day
  // expression, so fixing only scheduleLabel() left the printed roster wrong.
  assertEquals(
    /subParts\.push\(dayPlural\(program\.day_of_week\)\)/.test(code),
    false,
    "the roster PDF header reads day_of_week directly again",
  );
});

Deno.test("marketing-touchpoint-send: a camp advertised to families is not 'Mondays'", async () => {
  const src = await Deno.readTextFile(
    new URL("../../marketing-touchpoint-send/index.ts", import.meta.url),
  );
  const code = codeOnly(src);
  assert(
    /from "\.\.\/_shared\/campProgram\.ts"/.test(code),
    "marketing-touchpoint-send does not import programScheduleLabel",
  );
  assert(
    code.includes("class_days") && code.includes("end_date"),
    "marketing-touchpoint-send's programs select is missing class_days/end_date, so a camp reads as its first day again",
  );
  assert(
    /isCampProgram\(p\)/.test(code),
    "buildProgramDetails no longer branches on isCampProgram, so camps take the weekly path",
  );
  // TWO selects feed this function and both must carry the columns; one of them
  // alone leaves whichever path uses the other advertising "Mondays".
  assertEquals(
    (code.match(/class_days, end_date, first_session_date/g) ?? []).length,
    2,
    "marketing-touchpoint-send has two programs selects; both must carry class_days + end_date",
  );
});
