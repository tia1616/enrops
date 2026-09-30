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

Deno.test("match-afterschool refuses camps rather than matching them on one day", async () => {
  // Its whole schedule model is one weekday per program: availability, the
  // time-overlap test and the max_days cap all key on day_of_week. A camp run
  // through it is matched as its FIRST day, so the instructor is never checked
  // for the other three and can be double-booked inside them.
  const src = await Deno.readTextFile(
    new URL("../../match-afterschool/index.ts", import.meta.url),
  );
  const code = codeOnly(src);
  assert(
    /from '\.\.\/_shared\/campProgram\.ts'/.test(code),
    "match-afterschool does not import isCampProgram",
  );
  assert(
    /\.filter\(\(p: any\) => !isCampProgram\(p\)\)/.test(code),
    "match-afterschool no longer excludes camps from the matched set",
  );
  assert(
    code.includes("class_days"),
    "match-afterschool's programs select is missing class_days, so isCampProgram() sees undefined and excludes nothing",
  );
  assert(
    code.includes("camps_skipped"),
    "match-afterschool no longer reports camps_skipped, so the board cannot tell the operator what it left alone",
  );
});
