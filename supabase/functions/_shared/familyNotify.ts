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

export interface FamilyRecipient {
  parent_id: string;
  name: string;
  email: string;
  /** Every child this parent has in the class, already joined by groupFamilyRecipients. */
  student_first_name?: string;
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
