// export-finances — Spec C2. Returns a flat CSV of an org's money records
// (registrations + instructor payouts) for a bookkeeper to import into
// QuickBooks / Xero. This is the "you keep your own books, we feed them" half
// of the accounting story (pairs with the C1 Stripe metadata standard).
//
// AUTH: verify_jwt=true. We ALSO re-check that the caller is an owner/admin of
// the requested org server-side (the money permission) before reading anything
// — never trust the client's claim. Reads run with service_role internally so
// the export can span tables, but only AFTER the permission check passes.
//
// DAY BOUNDARIES: rows are bucketed by the ORG'S LOCAL day (organizations.
// timezone), not UTC, so a bookkeeper reconciling by calendar day gets the
// right rows in the right day. The CSV `date` column is the org-local date.
//
// FEES: we deliberately do NOT fabricate Stripe's processing fee or the
// application fee — neither is stored in our DB (the fee lives on Stripe's
// balance transaction). Those columns are left blank; the Stripe→QBO connector
// captures the real fee directly. We export gross + identifiers so books
// reconcile against Stripe, not a half-computed number.
//
// INPUT (POST JSON): { organization_id, date_from?, date_to?, record_types? }
//   date_from / date_to: YYYY-MM-DD (org-local). Default = last 90 days.
//   record_types: optional subset of ['registration','contractor_payout'].
// OUTPUT: text/csv attachment.

import { corsHeaders, adminClient } from '../_shared/instructor.ts';

const CSV_HEADER = [
  'date', 'type', 'gross_cents', 'stripe_fee_cents', 'application_fee_cents',
  'net_cents', 'counterparty', 'program', 'term', 'status', 'stripe_object_id',
  'enrops_record_id',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_FALLBACK = 'UTC';

// RFC-4180 CSV cell, plus spreadsheet formula-injection neutralization: a value
// starting with = + - @ (or tab/CR) is prefixed with a single quote so Excel /
// Sheets treat it as text, not a formula, when the bookkeeper opens the file.
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// The YYYY-MM-DD calendar day after the given one (date-only arithmetic).
function nextDayStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return isoDate(new Date(Date.UTC(y, m - 1, d + 1)));
}

// The UTC instant corresponding to 00:00:00 LOCAL time on `dateStr` in
// `timeZone`. Uses the zone's actual offset at that date, so it's DST-correct.
function localDayStartUtc(dateStr: string, timeZone: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMidnight))) map[p.type] = p.value;
  const hour = map.hour === '24' ? '00' : map.hour; // some zones emit '24' for midnight
  const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +hour, +map.minute, +map.second);
  const offset = asUtc - utcMidnight; // ms local-time is ahead of UTC at that instant
  return new Date(utcMidnight - offset).toISOString();
}

// The org-local calendar day (YYYY-MM-DD) for a stored UTC timestamp.
function localDateOf(ts: string | null | undefined, timeZone: string): string {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(ts));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // ── auth: who is calling ────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    // ── input ───────────────────────────────────────────────────────────
    let body: {
      organization_id?: string;
      date_from?: string;
      date_to?: string;
      record_types?: string[];
    } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_body' }, 400); }

    const orgId = (body.organization_id || '').trim();
    if (!orgId) return json({ error: 'missing_organization_id' }, 400);

    // Validate any supplied dates up front (also closes a filename edge case).
    if (body.date_from && !DATE_RE.test(body.date_from)) return json({ error: 'invalid_date_from' }, 400);
    if (body.date_to && !DATE_RE.test(body.date_to)) return json({ error: 'invalid_date_to' }, 400);

    // ── money permission: caller must be owner/admin of THIS org ─────────
    const { data: cmData } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!cmData) return json({ error: 'forbidden' }, 403);

    // Org timezone (for local-day bucketing) + fallback term for camp regs.
    const { data: orgRow } = await supabase
      .from('organizations')
      .select('timezone, active_registration_term')
      .eq('id', orgId)
      .maybeSingle();
    const tz = (orgRow as { timezone?: string | null } | null)?.timezone || TZ_FALLBACK;
    const orgTerm = (orgRow as { active_registration_term?: string | null } | null)?.active_registration_term ?? '';

    // ── date window (org-local), default last 90 days ───────────────────
    const today = new Date();
    const dateFrom = body.date_from || isoDate(new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000));
    const dateTo = body.date_to || isoDate(today);
    // UTC instants for [local 00:00 of dateFrom, local 00:00 of dateTo+1)
    const fromInstant = localDayStartUtc(dateFrom, tz);
    const toInstant = localDayStartUtc(nextDayStr(dateTo), tz);

    const types = Array.isArray(body.record_types) && body.record_types.length
      ? new Set(body.record_types)
      : new Set(['registration', 'contractor_payout']);

    const rows: string[][] = [];

    // ── registrations (money IN) ─────────────────────────────────────────
    if (types.has('registration')) {
      const { data: regs, error: regErr } = await supabase
        .from('registrations')
        .select(`
          id, amount_cents, payment_status, registered_at, stripe_payment_intent_id,
          students ( first_name, last_name ),
          programs ( curriculum, term ),
          camp_sessions ( curriculum_name )
        `)
        .eq('organization_id', orgId)
        .gte('registered_at', fromInstant)
        .lt('registered_at', toInstant)
        .order('registered_at', { ascending: true });
      if (regErr) {
        console.error('[export-finances] registrations query failed:', regErr.message);
        return json({ error: 'query_failed', detail: 'registrations' }, 500);
      }
      for (const r of (regs ?? []) as any[]) {
        const student = r.students ?? {};
        const counterparty = `${student.first_name ?? ''} ${student.last_name ?? ''}`.trim();
        const program = r.programs?.curriculum ?? r.camp_sessions?.curriculum_name ?? '';
        const term = r.programs?.term ?? orgTerm;
        rows.push([
          localDateOf(r.registered_at, tz),
          'registration',
          String(r.amount_cents ?? ''),
          '', // stripe_fee_cents — connector captures from Stripe
          '', // application_fee_cents — not stored; do not fabricate
          '', // net_cents — reconciled by connector against Stripe
          counterparty,
          program,
          term,
          r.payment_status ?? '',
          r.stripe_payment_intent_id ?? '',
          r.id,
        ]);
      }
    }

    // ── instructor payouts (money OUT) ───────────────────────────────────
    if (types.has('contractor_payout')) {
      const { data: payouts, error: poErr } = await supabase
        .from('instructor_payouts')
        .select(`
          id, amount_cents, status, created_at, succeeded_at, via_stripe, stripe_transfer_id,
          instructors ( first_name, last_name ),
          programs ( curriculum ),
          camp_sessions ( curriculum_name )
        `)
        .eq('organization_id', orgId)
        .gte('created_at', fromInstant)
        .lt('created_at', toInstant)
        .order('created_at', { ascending: true });
      if (poErr) {
        console.error('[export-finances] payouts query failed:', poErr.message);
        return json({ error: 'query_failed', detail: 'instructor_payouts' }, 500);
      }
      for (const p of (payouts ?? []) as any[]) {
        const inst = p.instructors ?? {};
        const counterparty = `${inst.first_name ?? ''} ${inst.last_name ?? ''}`.trim();
        const program = p.programs?.curriculum ?? p.camp_sessions?.curriculum_name ?? '';
        rows.push([
          localDateOf(p.succeeded_at ?? p.created_at, tz),
          'contractor_payout',
          String(p.amount_cents ?? ''),
          '', // stripe_fee_cents — transfers carry no Stripe processing fee
          '', // application_fee_cents — N/A for transfers
          '', // net_cents
          counterparty,
          program,
          '', // term — payouts are not term-tagged
          p.status ?? '',
          p.stripe_transfer_id ?? (p.via_stripe ? '' : 'manual'),
          p.id,
        ]);
      }
    }

    // ── assemble CSV (header always present, even with zero rows) ────────
    const lines = [CSV_HEADER.map(cell).join(',')];
    for (const row of rows) lines.push(row.map(cell).join(','));
    const csv = lines.join('\r\n') + '\r\n';

    const filename = `enrops-finances-${dateFrom}_to_${dateTo}.csv`;
    return new Response(csv, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('[export-finances] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
