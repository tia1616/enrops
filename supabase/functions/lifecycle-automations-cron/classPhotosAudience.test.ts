// Pins when a family hears about class photos, and - the part that matters most -
// when they do NOT: never about today, never twice for one day, never on a day
// without photos, and never one email per photo.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  photoDaysToNotify, classPhotoRecipients, classPhotoContextKey, localDay, type EnrolledReg,
} from "./classPhotosAudience.ts";

const LA = "America/Los_Angeles";
// 2026-10-14 is a Wednesday. 23:30 UTC on the 14th is 4:30pm Pacific on the 14th;
// 06:30 UTC on the 15th is 11:30pm Pacific on the 14th - still the 14th locally.
const photo = (program_id: string, created_at: string) => ({ program_id, created_at });

Deno.test("the upload day is the provider's local day, not UTC", () => {
  assertEquals(localDay("2026-10-15T06:30:00Z", LA), "2026-10-14");
  assertEquals(localDay("2026-10-15T06:30:00Z", "UTC"), "2026-10-15");
});

Deno.test("ten photos in one afternoon are ONE class-day, counted", () => {
  const photos = Array.from({ length: 10 }, (_, i) => photo("p1", `2026-10-14T2${i % 4}:00:00Z`));
  assertEquals(photoDaysToNotify(photos, LA, "2026-10-15"), [{ programId: "p1", day: "2026-10-14", count: 10 }]);
});

Deno.test("today is never emailed about: the day is not over", () => {
  // 4:30pm Pacific on the 15th, and the run is on the 15th.
  assertEquals(photoDaysToNotify([photo("p1", "2026-10-15T23:30:00Z")], LA, "2026-10-15"), []);
});

Deno.test("a late-evening upload belongs to that evening's day, not the next UTC day", () => {
  // 11:30pm Pacific on the 14th. A UTC reading would call it the 15th = "today" and skip it.
  assertEquals(photoDaysToNotify([photo("p1", "2026-10-15T06:30:00Z")], LA, "2026-10-15"),
    [{ programId: "p1", day: "2026-10-14", count: 1 }]);
});

Deno.test("the look-back catches a missed run, and stops", () => {
  const photos = [
    photo("p1", "2026-10-12T20:00:00Z"), // 3 days back: caught
    photo("p1", "2026-10-11T20:00:00Z"), // 4 days back: too old, ignored
  ];
  assertEquals(photoDaysToNotify(photos, LA, "2026-10-15").map((d) => d.day), ["2026-10-12"]);
});

Deno.test("no photos means no days means nobody", () => {
  assertEquals(photoDaysToNotify([], LA, "2026-10-15"), []);
  assertEquals(classPhotoRecipients([], [reg("p1", "par1", "Ada")]), []);
});

const reg = (program_id: string, parent_id: string, kid: string, email = `${parent_id}@x.test`): EnrolledReg => ({
  program_id, parent_id, parent_email: email, parent_first_name: "Pat", child_first_name: kid, program_name: "Lego Robotics",
});

Deno.test("siblings in the same class are one email naming both", () => {
  const out = classPhotoRecipients(
    [{ programId: "p1", day: "2026-10-14", count: 4 }],
    [reg("p1", "par1", "Ada"), reg("p1", "par1", "Ben"), reg("p1", "par2", "Cleo")],
  );
  assertEquals(out.length, 2);
  assertEquals(out.find((r) => r.parent_id === "par1")!.child_first_names, ["Ada", "Ben"]);
  assertEquals(out[0].photo_count, 4);
});

Deno.test("two classes with photos the same day are two emails, one per class", () => {
  const out = classPhotoRecipients(
    [{ programId: "p1", day: "2026-10-14", count: 1 }, { programId: "p2", day: "2026-10-14", count: 2 }],
    [reg("p1", "par1", "Ada"), reg("p2", "par1", "Ben")],
  );
  assertEquals(out.map((r) => r.program_id).sort(), ["p1", "p2"]);
});

Deno.test("a class without photos that day reaches nobody, even with families enrolled", () => {
  const out = classPhotoRecipients([{ programId: "p1", day: "2026-10-14", count: 1 }], [reg("p2", "par1", "Ada")]);
  assertEquals(out, []);
});

Deno.test("two households sharing one address are still two families", () => {
  const out = classPhotoRecipients(
    [{ programId: "p1", day: "2026-10-14", count: 1 }],
    [reg("p1", "parA", "Ada", "shared@x.test"), reg("p1", "parB", "Ben", "shared@x.test")],
  );
  assertEquals(out.length, 2);
});

Deno.test("a family with no usable address is skipped, not sent to nowhere", () => {
  const out = classPhotoRecipients(
    [{ programId: "p1", day: "2026-10-14", count: 1 }],
    [reg("p1", "par1", "Ada", "mike.degliantoni"), { ...reg("p1", "par2", "Ben"), parent_email: null }],
  );
  assertEquals(out, []);
});

Deno.test("the key carries class, day and family, so a day is sent at most once", () => {
  assertEquals(classPhotoContextKey("p1", "2026-10-14", "par1"), "class_photos:program:p1:day:2026-10-14:parent:par1");
  const days = [{ programId: "p1", day: "2026-10-14", count: 1 }];
  const a = classPhotoRecipients(days, [reg("p1", "par1", "Ada")]);
  const b = classPhotoRecipients(days, [reg("p1", "par1", "Ada")]);
  assertEquals(a[0].context_key, b[0].context_key);
});
