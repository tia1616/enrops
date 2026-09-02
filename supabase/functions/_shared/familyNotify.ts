// Sending ONE email per family about ONE class - the send half, once.
//
// WHY THIS EXISTS. notify-program-curriculum-change already does exactly this:
// resolve the families in a class, fill {placeholders}, POST each one to Resend,
// and record a per-recipient result so a partial failure is visible. That is the
// whole mechanism Jessica asked for next ("there is no way to email just the
// families in one class - and it cost a real send today"), and it was welded to
// one trigger: a curriculum swap. Rather than write a second send loop beside it,
// the loop moves here and both callers use it.
//
// WHO ALREADY OWNS THE OTHER HALVES, so this file does not re-do them:
//   - WHICH families      program_note_recipients (SECURITY DEFINER, org-checked,
//                         raises PN001 for a caller who is not owner/admin/staff)
//   - ONE ROW PER PARENT  _shared/familyRecipients.ts groupFamilyRecipients,
//                         which names EVERY child that parent has in the class.
//                         A per-CHILD email with a per-PARENT recipient list is
//                         how Yu Zhou's second son went unmentioned on 2026-08-14.
//   - WHO IT IS FROM      _shared/orgBrand.ts loadOrgBrand + formatFromAddress
//
// ONE EMAIL PER RECIPIENT, NEVER A SHARED "to". Families in a class must not
// learn each other's addresses from a class note. That is why this loops instead
// of batching, and why a failure for one family does not abort the rest.
//
// `fetchImpl` IS INJECTABLE FOR ONE REASON: a send loop whose failure paths have
// never been executed is a guess. The tests drive a fake through the non-ok
// branch, the throw branch and the happy path, which is not possible against the
// real Resend API.

import { joinChildNames } from './familyRecipients.ts';

export interface FamilyRecipient {
  parent_id: string;
  name: string;
  email: string;
  /** Every child this parent has in the class, already joined by groupFamilyRecipients. */
  student_first_name?: string;
}

// One FLAT row per (address, child) as program_message_recipients returns them.
export interface MessageRecipientRow {
  recipient_email: string;
  recipient_name: string;
  recipient_kind: 'parent' | 'guardian' | string;
  parent_id: string;
  student_id: string;
  student_first_name: string | null;
  audience: 'enrolled' | 'waitlist' | string;
  /** null = sendable. 'placeholder_email' = imported roster, no real address. */
  unreachable_reason?: string | null;
}

// COLLAPSE TO ONE EMAIL PER ADDRESS, naming every child that address is
// responsible for.
//
// GROUPED BY (ADDRESS, FAMILY) - both halves are load-bearing, for opposite
// reasons, and getting either alone wrong is a real defect:
//
//   ADDRESS, so one inbox gets ONE email. Now that a second guardian is a
//   recipient (Jessica: "both parents should also be emailed") the same person
//   can arrive twice - once as the account holder, once as the guardian on their
//   own child. Measured on prod 2026-09-02: 12 enrolled children across the two
//   live orgs have a guardian address IDENTICAL to the primary, and the first
//   staging class tested was exactly that shape. Keyed by parent alone, that
//   family gets two identical emails.
//
//   FAMILY, so one email never names TWO households' children. An address can
//   legitimately serve two families in one class - a grandparent minding two
//   cousins, a nanny guardian for two households. Keyed by address alone those
//   merge and each household learns the other's child. Zero such addresses exist
//   on prod today; this keeps it impossible rather than waiting for the first.
//   Two families sharing an inbox therefore get two emails, which is correct -
//   they are two separate pieces of business.
//
// Lower-cased because the addresses come back lower-cased from SQL, but a
// hand-typed guardian address may not be - "Sam@x.com" and "sam@x.com" are one
// inbox and must be one email.
//
// CHILD NAMES ARE DEDUPED TOO: a child reached via both the parent row and the
// guardian row would otherwise be named twice ("Ryan and Ryan").
//
// THE NAME shown is the account holder's where we have it, falling back to the
// guardian's - so an email addressed to a shared inbox greets the person who
// registered rather than whichever row sorted first.
//
// Deterministic order (by address) so a preview, the send and the audit row all
// list recipients the same way. An operator who counts 14 names in the preview
// must see the same 14, in the same order, in the record afterwards.
export function groupRecipientsByAddress(rows: MessageRecipientRow[]) {
  const byEmail = new Map<string, {
    email: string;
    name: string;
    kinds: Set<string>;
    childNames: string[];
    childIds: Set<string>;
    audiences: Set<string>;
    parentIds: Set<string>;
    unreachable: string | null;
  }>();

  for (const r of rows ?? []) {
    const email = (r?.recipient_email ?? '').trim().toLowerCase();
    if (!email) continue;
    // KEYED BY (ADDRESS, FAMILY), NOT ADDRESS ALONE - and the second half is a
    // privacy rule, not tidiness. One address can legitimately appear against
    // two DIFFERENT families in the same class: a grandparent minding two
    // cousins, a nanny listed as guardian for two households. Keyed by address
    // alone, those merge into one email naming BOTH families' children, so each
    // household learns who else is in the class - the same disclosure this file
    // avoids by never putting two addresses in one `to`.
    //
    // It still collapses the case that actually occurs: the 12 children whose
    // guardian address equals the account holder's are the SAME parent_id, so
    // they remain one email. Two families sharing an inbox get two emails, which
    // is correct - they are two separate pieces of business.
    //
    // Zero addresses on prod currently span two families in one class (measured
    // 2026-09-02); this keeps it impossible rather than waiting for the first one.
    // Delimited with a pipe, which cannot occur in an email address or a UUID.
    // Concatenated bare, "a@x.test" + "famA" and "a@x.testfamA" + "" are the
    // same key - vanishingly unlikely with UUID parent ids, but a key that is
    // only safe by luck is not a key.
    const key = `${email}|${r.parent_id ?? ''}`;
    let g = byEmail.get(key);
    if (!g) {
      g = {
        email,
        name: (r.recipient_name ?? '').trim(),
        kinds: new Set(),
        childNames: [],
        childIds: new Set(),
        audiences: new Set(),
        parentIds: new Set(),
        unreachable: null,
      };
      byEmail.set(key, g);
    }
    // STICKY, and it fails CLOSED: once any row for this address says the
    // address is unreachable, the whole group stays unreachable. The alternative
    // - last row wins - would let one sendable-looking row promote a placeholder
    // address back into the send.
    if (r.unreachable_reason && !g.unreachable) {
      g.unreachable = String(r.unreachable_reason);
    }
    // The account holder's name wins over a guardian's for the same inbox.
    if (r.recipient_kind === 'parent' && (r.recipient_name ?? '').trim()) {
      g.name = (r.recipient_name ?? '').trim();
    } else if (!g.name && (r.recipient_name ?? '').trim()) {
      g.name = (r.recipient_name ?? '').trim();
    }
    if (r.recipient_kind) g.kinds.add(String(r.recipient_kind));
    if (r.audience) g.audiences.add(String(r.audience));
    if (r.parent_id) g.parentIds.add(r.parent_id);
    const childName = (r.student_first_name ?? '').trim();
    if (r.student_id && !g.childIds.has(r.student_id)) {
      g.childIds.add(r.student_id);
      if (childName) g.childNames.push(childName);
    }
  }

  const all = [...byEmail.values()]
    .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
    .map((g) => ({
      parent_id: [...g.parentIds][0] ?? '',
      email: g.email,
      name: g.name,
      // joinChildNames, not a local join: it is the one place that decides
      // "Ryan and Evan" vs "Ryan, Evan and Mia" vs "your child".
      student_first_name: joinChildNames(g.childNames),
      child_count: g.childIds.size,
      kinds: [...g.kinds].sort(),
      audiences: [...g.audiences].sort(),
      unreachable_reason: g.unreachable ?? null,
    }));

  // TWO LISTS, NOT ONE LIST PLUS A FLAG, and that is deliberate. A caller who
  // forgets to filter a flag sends to everybody; a caller who forgets to read
  // `unreachable` simply does not mention it. The failure mode of the shape
  // decides which mistake is possible, so the shape makes the harmful one hard.
  //
  // Measured on prod 2026-09-02: the OES Pokemon class returns 13 recipients and
  // ALL 13 are placeholder addresses from a partner-run roster import. Flat, an
  // operator would be told 13 were emailed while 13 bounced.
  return {
    sendable: all.filter((g) => !g.unreachable_reason),
    unreachable: all.filter((g) => !!g.unreachable_reason),
  };
}

export interface FamilySendResult {
  parent_id: string;
  name: string;
  email: string;
  resend_message_id: string | null;
  status: 'sent' | 'failed';
  failure_reason: string | null;
}

// Replace {key} occurrences with values. A key MISSING from `vars` is left as it
// was written, on purpose: the operator's template wins, so a typo like
// {Parent_First_Name} reaches the reader and the audit row visibly, instead of
// being silently blanked and nobody ever learning the placeholder was wrong.
export function substitute(template: string, vars: Record<string, string>): string {
  return (template ?? '').replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

// The two placeholders every family email has, whoever is sending it. Callers
// merge their own on top (the class summary, a from/to curriculum, a cancellation
// reason). Defaults are deliberate: an email that opens "Hi there" is fine, one
// that opens "Hi undefined" is not, and "your child" is the honest fallback when
// the roster row carries no first name.
export function familyVars(
  r: FamilyRecipient,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    parent_first_name: (r.name ?? '').trim().split(/\s+/)[0] || 'there',
    student_first_name: (r.student_first_name ?? '').trim() || 'your child',
    ...extra,
  };
}

export interface SendFamilyEmailsOptions {
  recipients: FamilyRecipient[];
  subject: string;
  bodyText: string;
  /** Applied to every recipient, under the two familyVars defaults. */
  vars?: Record<string, string>;
  from: string;
  replyTo?: string | null;
  apiKey: string;
  /** Resend tags. `type` should name the SENDER, so a bounce can be traced back. */
  tags?: Array<{ name: string; value: string }>;
  fetchImpl?: typeof fetch;
}

export async function sendFamilyEmails(
  opts: SendFamilyEmailsOptions,
): Promise<FamilySendResult[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const results: FamilySendResult[] = [];

  for (const r of opts.recipients ?? []) {
    const vars = familyVars(r, opts.vars ?? {});
    const subject = substitute(opts.subject, vars);
    const text = substitute(opts.bodyText, vars);
    try {
      const resp = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          from: opts.from,
          to: r.email,
          // Omitted entirely rather than sent as null: Resend rejects a null
          // reply_to, and an org with no reply-to configured must still send.
          reply_to: opts.replyTo ? [opts.replyTo] : undefined,
          subject,
          text,
          tags: opts.tags ?? [],
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        results.push({
          parent_id: r.parent_id,
          name: r.name,
          email: r.email,
          resend_message_id: null,
          status: 'failed',
          // Truncated: this lands in an audit row a person reads, and Resend can
          // return a whole HTML page on a bad gateway.
          failure_reason: `resend ${resp.status}: ${errText.slice(0, 200)}`,
        });
        continue;
      }
      const data = await resp.json().catch(() => ({}));
      results.push({
        parent_id: r.parent_id,
        name: r.name,
        email: r.email,
        resend_message_id: (data as { id?: string })?.id ?? null,
        status: 'sent',
        failure_reason: null,
      });
    } catch (err) {
      // A thrown fetch is one family's problem, not the class's. Recorded and
      // the loop continues, because aborting here would leave the remaining
      // families un-notified with nothing saying which ones.
      results.push({
        parent_id: r.parent_id,
        name: r.name,
        email: r.email,
        resend_message_id: null,
        status: 'failed',
        failure_reason: (err as Error)?.message ?? String(err),
      });
    }
  }

  return results;
}

// Counts for the audit row and for what the operator is told afterwards. Kept
// here so "how many went" is computed once rather than re-derived per caller -
// two places counting the same send is how an email says one number while the
// screen it links to says another.
export function tallyFamilySends(results: FamilySendResult[]): {
  sent: number;
  failed: number;
  total: number;
} {
  const list = results ?? [];
  const sent = list.filter((r) => r.status === 'sent').length;
  return { sent, failed: list.length - sent, total: list.length };
}
