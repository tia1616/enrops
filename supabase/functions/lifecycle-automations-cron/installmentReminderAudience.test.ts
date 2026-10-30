// Pins who is told a payment is coming, and - the part that matters most - who is
// NOT: nobody whose charge is already due, nobody who cannot be charged, never two
// emails for one charge, never a date the card is not charged on.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  installmentReminderRecipients, installmentReminderContextKey, installmentLabel,
  REMINDER_DAYS_AHEAD, type ReminderRow,
} from "./installmentReminderAudience.ts";

const TODAY = "2026-11-03";

let n = 0;
const row = (over: Partial<ReminderRow> = {}): ReminderRow => ({
  id: `i${++n}`,
  organization_id: "org1",
  stripe_customer_id: "cus_1",
  stripe_payment_method_id: "pm_1",
  installment_number: 2,
  due_date: "2026-11-06",
  status: "pending",
  registration_id: "reg1",
  stripe_checkout_session_id: "cs_1",
  registration_status: "confirmed",
  parent_id: "par1",
  parent_email: "mom@example.com",
  parent_first_name: "Sam",
  child_first_name: "Ada",
  program_name: "Minecraft",
  ...over,
});

Deno.test("a charge three days out gets one reminder naming the date", () => {
  const out = installmentReminderRecipients([row()], TODAY);
  assertEquals(out.length, 1);
  assertEquals(out[0].charge_date, "2026-11-06");
  assertEquals(out[0].installment_number, 2);
  assertEquals(out[0].child_first_name, "Ada");
});

Deno.test("the window is tomorrow through REMINDER_DAYS_AHEAD days out, no further", () => {
  assertEquals(REMINDER_DAYS_AHEAD, 3);
  assertEquals(installmentReminderRecipients([row({ due_date: "2026-11-04" })], TODAY).length, 1);
  assertEquals(installmentReminderRecipients([row({ due_date: "2026-11-06" })], TODAY).length, 1);
  assertEquals(installmentReminderRecipients([row({ due_date: "2026-11-07" })], TODAY).length, 0);
});

Deno.test("a charge due today or overdue is being charged now, so it is never 'coming up'", () => {
  assertEquals(installmentReminderRecipients([row({ due_date: TODAY })], TODAY), []);
  assertEquals(installmentReminderRecipients([row({ due_date: "2026-10-30" })], TODAY), []);
});

Deno.test("two children in one cart are ONE charge, ONE email, naming both", () => {
  const out = installmentReminderRecipients([
    row({ registration_id: "regA", child_first_name: "Ada", program_name: "Minecraft" }),
    row({ registration_id: "regB", child_first_name: "Ben", program_name: "Robotics" }),
  ], TODAY);
  assertEquals(out.length, 1);
  assertEquals(out[0].child_first_name, "Ada and Ben");
  assertEquals(out[0].program_name, "Minecraft and Robotics");
});

Deno.test("the date is the EARLIEST row in the charge: the charger pulls later siblings forward", () => {
  const out = installmentReminderRecipients([
    row({ registration_id: "regA", due_date: "2026-11-06" }),
    row({ registration_id: "regB", due_date: "2026-11-05" }),
  ], TODAY);
  assertEquals(out.length, 1);
  assertEquals(out[0].charge_date, "2026-11-05");
});

Deno.test("a sibling already due today means the whole charge goes today: no reminder", () => {
  const out = installmentReminderRecipients([
    row({ registration_id: "regA", due_date: TODAY }),
    row({ registration_id: "regB", due_date: "2026-11-05" }),
  ], TODAY);
  assertEquals(out, []);
});

Deno.test("two separate checkouts by one parent are two charges, two emails", () => {
  const out = installmentReminderRecipients([
    row({ registration_id: "regA", stripe_checkout_session_id: "cs_A", due_date: "2026-11-05" }),
    row({ registration_id: "regB", stripe_checkout_session_id: "cs_B", due_date: "2026-11-06" }),
  ], TODAY);
  assertEquals(out.length, 2);
});

Deno.test("a cancelled or refunded registration is never charged, so never reminded", () => {
  assertEquals(installmentReminderRecipients([row({ registration_status: "cancelled" })], TODAY), []);
  assertEquals(installmentReminderRecipients([row({ registration_status: "refunded" })], TODAY), []);
});

Deno.test("a cancelled sibling does not drag a live row's date", () => {
  const out = installmentReminderRecipients([
    row({ registration_id: "regA", registration_status: "cancelled", due_date: "2026-11-04" }),
    row({ registration_id: "regB", due_date: "2026-11-06" }),
  ], TODAY);
  assertEquals(out.length, 1);
  assertEquals(out[0].charge_date, "2026-11-06");
});

Deno.test("only pending rows: paused, paid and failed ones are not coming up", () => {
  for (const status of ["paused_card_failed", "paid", "failed", "cancelled"]) {
    assertEquals(installmentReminderRecipients([row({ status })], TODAY), [], status);
  }
});

Deno.test("no saved card or no Stripe customer means nothing will be charged", () => {
  assertEquals(installmentReminderRecipients([row({ stripe_payment_method_id: null })], TODAY), []);
  assertEquals(installmentReminderRecipients([row({ stripe_customer_id: null })], TODAY), []);
});

Deno.test("a placeholder or missing address is never mailed", () => {
  assertEquals(installmentReminderRecipients([row({ parent_email: "x@import.local" })], TODAY), []);
  assertEquals(installmentReminderRecipients([row({ parent_email: null })], TODAY), []);
  assertEquals(installmentReminderRecipients([row({ parent_email: "not-an-email" })], TODAY), []);
  assertEquals(installmentReminderRecipients([row({ parent_id: null })], TODAY), []);
});

Deno.test("the same charge seen on two days has the SAME key (the ledger sends once); a moved date is a new key", () => {
  const a = installmentReminderRecipients([row()], "2026-11-03")[0].context_key;
  const b = installmentReminderRecipients([row()], "2026-11-04")[0].context_key;
  assertEquals(a, b);
  const moved = installmentReminderRecipients([row({ due_date: "2026-11-07" })], "2026-11-04")[0].context_key;
  assertEquals(moved === a, false);
  assertEquals(a.startsWith("installment_reminder:"), true);
  assertEquals(installmentReminderContextKey("g", "2026-11-06"), "installment_reminder:g:2026-11-06");
});

Deno.test("households sharing an address are still separate families", () => {
  const out = installmentReminderRecipients([
    row({ parent_id: "p1", stripe_customer_id: "cus_1", registration_id: "r1", stripe_checkout_session_id: "cs_1" }),
    row({ parent_id: "p2", stripe_customer_id: "cus_2", registration_id: "r2", stripe_checkout_session_id: "cs_2" }),
  ], TODAY);
  assertEquals(out.length, 2);
});

Deno.test("labels", () => {
  assertEquals([1, 2, 3].map(installmentLabel), ["first", "second", "third"]);
});
