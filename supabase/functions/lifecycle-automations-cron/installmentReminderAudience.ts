// Who gets the "payment coming up" email, and about which charge. Pure, so it is
// tested without a database (installmentReminderAudience.test.ts).
//
// ONE EMAIL PER CHARGE, NOT PER ROW. process-installments charges a family's
// rows together as one PaymentIntent (installmentGroupKey), so a two-child cart
// is ONE charge and gets ONE reminder naming both children. This file uses the
// charger's own grouping function rather than a second spelling of it.
//
// THE CHARGE DATE IS THE EARLIEST DUE DATE IN THE GROUP. The charger pulls a
// group's later-dated siblings forward when the earliest comes due, so a reminder
// that quoted a later row's date would name a day the card is not charged on.
//
// NEVER A CHARGE THAT IS ALREADY DUE. A group whose earliest row is due today or
// earlier is skipped: it is being charged by today's run, and "coming up" would be
// false. The window is (today, today + REMINDER_DAYS_AHEAD].
//
// NO DOLLAR AMOUNT, ON PURPOSE. What a family is charged is not installments.amount_cents:
// the charger adds the family's agreed share of the enrops service fee, rebuilt
// from the whole cart and the provider's fee settings as of the plan's start. A
// second copy of that math here would drift from the charge. The email names the
// date and the children instead.

import { addDaysUtc, NOT_CHARGEABLE_REGISTRATION_STATUSES } from "../_shared/declineRetry.ts";
import { installmentGroupKey } from "../_shared/installmentGroup.ts";
import { formatChildNameList } from "../_shared/childNameList.ts";

/** How many days ahead of the charge the family is told. Provider-editable timing
 *  is not offered: one number, one place. */
export const REMINDER_DAYS_AHEAD = 3;

export interface ReminderRow {
  id: string;
  organization_id: string;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  installment_number: number;
  due_date: string; // 'YYYY-MM-DD', the charger's calendar (UTC)
  status: string;
  registration_id: string;
  stripe_checkout_session_id: string | null;
  registration_status: string | null;
  // The charger pauses a row whose PROGRAM is cancelled instead of charging it
  // (process-installments, 'paused_program_cancelled'), so it is not coming up.
  program_status: string | null;
  parent_id: string | null;
  parent_email: string | null;
  parent_first_name: string | null;
  child_first_name: string | null;
  program_name: string | null;
}

export interface InstallmentReminderRecipient {
  context_key: string;
  parent_id: string;
  parent_email: string;
  parent_first_name: string | null;
  child_first_name: string;
  program_name: string;
  installment_number: number;
  charge_date: string; // 'YYYY-MM-DD'
}

export function installmentReminderContextKey(groupKey: string, chargeDate: string): string {
  return `installment_reminder:${groupKey}:${chargeDate}`;
}

/** "second" for installment 2. Beyond the plans the platform writes (3), a plain number. */
export function installmentLabel(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `#${n}`;
}

function joinNames(names: Array<string | null | undefined>): string {
  // Same "A, B, and C" phrasing as the child names, for program names.
  return formatChildNameList(names);
}

/**
 * Charges worth a reminder today, one recipient each.
 *
 * `rows` must be the installment rows with status 'pending' and due_date up to
 * today + REMINDER_DAYS_AHEAD, INCLUDING any already due or overdue: those are
 * what tell a group it is being charged today. Rows outside that range are not
 * needed, and a row this function is not given cannot hurt it (a later-dated
 * sibling only ever rides along on the earlier row's date).
 */
export function installmentReminderRecipients(
  rows: ReminderRow[],
  today: string,
): InstallmentReminderRecipient[] {
  const horizon = addDaysUtc(today, REMINDER_DAYS_AHEAD);

  // Group by the CHARGER's key. Rows that cannot be charged are dropped first, so
  // a cancelled sibling never drags a live row's date.
  const groups = new Map<string, ReminderRow[]>();
  for (const r of rows) {
    if (!r || r.status !== "pending") continue;
    if (!r.organization_id || !r.stripe_customer_id || !r.registration_id) continue;
    // No saved card = nothing will be charged, and "your card on file" would be a lie.
    if (!r.stripe_payment_method_id) continue;
    if (r.registration_status && NOT_CHARGEABLE_REGISTRATION_STATUSES.includes(r.registration_status)) continue;
    if (r.program_status === "cancelled") continue;
    const key = installmentGroupKey({
      organization_id: r.organization_id,
      stripe_customer_id: r.stripe_customer_id,
      installment_number: r.installment_number,
      registration_id: r.registration_id,
      registrations: { stripe_checkout_session_id: r.stripe_checkout_session_id },
    });
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out: InstallmentReminderRecipient[] = [];
  for (const [key, list] of groups) {
    const chargeDate = list.map((r) => r.due_date).filter(Boolean).sort()[0];
    if (!chargeDate) continue;
    // Already due (being charged today) or beyond the window: no "coming up" email.
    if (chargeDate <= today || chargeDate > horizon) continue;

    // The family: the first row that has a real address. A roster import with no
    // real address stores a placeholder ending in @import.local, which program
    // messages already treat as unreachable; this email goes out by default, so
    // never mail it.
    const who = list.find((r) =>
      r.parent_id && r.parent_email?.includes("@") && !r.parent_email.trim().toLowerCase().endsWith("@import.local"));
    if (!who) continue;

    out.push({
      context_key: installmentReminderContextKey(key, chargeDate),
      parent_id: who.parent_id as string,
      parent_email: (who.parent_email as string).trim(),
      parent_first_name: who.parent_first_name,
      child_first_name: formatChildNameList(list.map((r) => r.child_first_name)) || "your child",
      program_name: joinNames(list.map((r) => r.program_name)) || "their program",
      installment_number: who.installment_number,
      charge_date: chargeDate,
    });
  }
  return out.sort((a, b) => a.context_key.localeCompare(b.context_key));
}
