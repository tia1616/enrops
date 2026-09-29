// website-lead-intake — turns "Get Notified" signups from a tenant's website
// into marketing contacts.
//
// THE PIPELINE
//   Squarespace form -> Google Sheet (Squarespace appends the row) -> a
//   time-driven Apps Script on that sheet -> this function -> marketing_recipients.
//
//   The Apps Script (docs/apps-script/website-lead-intake.gs) runs every five
//   minutes, POSTs every row whose `synced_at` cell is empty, and stamps
//   `synced_at` only for the rows this function reports as handled. A row that
//   errors keeps an empty cell and is retried on the next run.
//
// AUTH — verify_jwt is FALSE, so the gateway lets anyone reach this function.
//   The gate is the tenant's own opaque secret in the `x-enrops-secret` header,
//   looked up against organizations.apps_script_sync_secret (UNIQUE). That
//   column is also the TENANT IDENTIFIER: there is no organization_id in the
//   payload and the caller cannot name one, so a leaked secret exposes exactly
//   one tenant and nothing about any other. Same posture as
//   apps-script-roster-sync, which uses the same column.
//
//   The response carries no PERSONAL data we looked up — no addresses, no
//   names, no counts of other people's rows. It reports, per submitted row, only
//   what happened to the data the caller already had, plus the org's own slug
//   and (on a failed write) the database's error text, both of which belong to
//   the tenant holding the secret. A 401 says nothing at all.
//
// WHAT IT WRITES — marketing_recipients only. One row per (organization, email).
//   * NEW contact  -> insert with source = 'website_notify'.
//   * KNOWN contact -> FILL BLANKS AND UNION TAGS. We never overwrite a field
//     that already has a value, and we never touch `source`, `segments`,
//     `suppress_welcome`, `phone`, the child columns or anything else the form
//     does not ask about. Rationale: the operator edits these by hand in
//     Contacts, and a form that re-states a stale answer must not win over a
//     correction. It also makes the whole endpoint idempotent — re-POSTing the
//     same sheet row changes nothing.
//   * SUPPRESSED address -> written NOWHERE, logged, counted, 200. Someone who
//     unsubscribed does not re-enter the list through a web form.
//
// TAGS — every row gets 'website-notify' (the "all website_notify" audience),
//   plus one slug per interest checked, plus a grade tag when the free-text
//   grade is readable. Targeting a first-access send at an interest is then the
//   campaign builder's existing "A group / tag…" scope, which already filters
//   marketing_recipients.tags — no new audience machinery.
//
// NOT CAPTURED: the "grade and anything we should know" prose. There is no
//   notes column on marketing_recipients and this function does not add one;
//   the grade is read out of that text into a tag and the rest stays in the
//   sheet.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { logPlatformEvent, FEATURE, ACTION, OUTCOME } from '../_shared/logPlatformEvent.ts';
import {
  mapRow,
  mergeLeads,
  parseLeadRow,
  type LocationRow,
  type ParsedLead,
} from './lib.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Apps Script posts server-to-server, not from a browser, so no preflight is
// needed. The headers are here only so a manual curl behaves predictably.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-enrops-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// One sheet's worth of new rows in a five-minute window is a handful. The cap
// bounds one request; a bigger backlog drains over several runs.
const MAX_ROWS = 500;

// PostgREST chokes on very long `.in()` lists (they travel in the URL), so
// every batched lookup is chunked well under that ceiling.
const IN_CHUNK = 100;

type RowStatus =
  | 'created'
  | 'merged'
  | 'unchanged'
  | 'skipped_test'
  | 'skipped_suppressed'
  | 'skipped_invalid_email'
  | 'error';

interface IncomingRow {
  row_number?: unknown;
  values?: unknown;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ---- Auth ----------------------------------------------------------------
  const secret = (req.headers.get('x-enrops-secret') ?? '').trim();
  if (!secret) {
    // Logged for the same reason the unknown-secret path below is: this endpoint
    // is reachable without a JWT and has no rate limit, so an attempt to guess
    // the secret must leave a trace somewhere. The CALLER still learns nothing.
    console.warn('website-lead-intake: rejected a request with no secret header');
    return json({ error: 'unauthorized' }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Anti-enumeration: an unknown secret and a missing secret get the same
  // bodyless-shaped 401. A read ERROR is NOT an auth failure and must not be
  // reported as one — it fails closed with a 500 so the script retries.
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('id, slug')
    .eq('apps_script_sync_secret', secret)
    .maybeSingle();
  if (orgErr) {
    console.error('website-lead-intake: org lookup failed:', orgErr.message);
    return json({ error: 'lookup_failed' }, 500);
  }
  if (!org) {
    console.warn('website-lead-intake: rejected a request whose secret matched no organization');
    return json({ error: 'unauthorized' }, 401);
  }

  // ---- Payload -------------------------------------------------------------
  let body: { rows?: unknown };
  try {
    body = (await req.json()) as { rows?: unknown };
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const rawRows = Array.isArray(body?.rows) ? (body.rows as IncomingRow[]) : null;
  if (!rawRows) return json({ error: 'rows_required' }, 400);
  if (rawRows.length > MAX_ROWS) {
    return json({ error: 'too_many_rows', max: MAX_ROWS, received: rawRows.length }, 413);
  }
  if (rawRows.length === 0) {
    return json({
      ok: true, org_slug: org.slug, rows_received: 0,
      rows: {
        created: 0, merged: 0, unchanged: 0,
        skipped_test: 0, skipped_suppressed: 0, skipped_invalid_email: 0, failed: 0,
      },
      contacts: { created: 0, merged: 0, unchanged: 0, failed: 0 },
      unmapped_interests: [], results: [],
    });
  }

  // THE COLUMN WE BOUND MUST ACTUALLY HOLD ADDRESSES.
  //
  // Checking only that SOME header matched the word "email" is not enough, and
  // the gap is the dangerous kind: Squarespace adds an "Email Opt-In" column
  // (Yes/No) to the left of "Email", the first-match-wins rule in mapRow binds
  // it, every row then reads as a bad address, every row is reported as handled,
  // and the Apps Script stamps the entire sheet as synced. The leads are gone
  // and the run logs as clean.
  //
  // So the guard is about CONTENT, not headers: at least one submitted row's
  // mapped email cell must contain an "@". One person mistyping their address
  // is a row-level skip; a column in which NOTHING looks like an address is a
  // broken binding, and the whole batch is refused so nothing gets stamped and
  // the script raises. (It fails loud and retries rather than failing quiet and
  // discarding, which is the right direction when the alternative is losing
  // every lead in the sheet.)
  const anyPlausibleAddress = rawRows.some((r) => {
    const v = r?.values;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const cell = mapRow(v as Record<string, unknown>).email;
    return typeof cell === 'string' && cell.includes('@');
  });
  if (!anyPlausibleAddress) {
    return json({
      error: 'no_usable_email_column',
      detail: 'no submitted row had an email cell containing "@" - the email column is probably bound to the wrong column. Nothing was written and nothing was marked synced.',
    }, 400);
  }

  // ---- Org-scoped reference data ------------------------------------------
  // Both reads FAIL CLOSED. A missing locations list would silently file every
  // lead with no school and no area; a missing suppression list would add
  // someone who unsubscribed. Neither is a state we are willing to write in.
  // Paginated for the same reason the suppression read below is: PostgREST caps
  // an unbounded select at 1000 rows and says nothing about it, so a tenant past
  // that many sites would silently lose the tail of its own catalog and file
  // those families with no school and no area.
  const locations: LocationRow[] = [];
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: locData, error: locErr } = await supabase
        .from('program_locations')
        .select('name, name_aliases, area')
        .eq('organization_id', org.id)
        .range(from, from + PAGE - 1);
      if (locErr) {
        console.error('website-lead-intake: program_locations read failed:', locErr.message);
        return json({ error: 'lookup_failed' }, 500);
      }
      for (const l of (locData ?? []) as LocationRow[]) locations.push(l);
      if (!locData || locData.length < PAGE) break;
    }
  }

  const suppressed = new Set<string>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: sup, error: sErr } = await supabase
        .from('marketing_suppressions')
        .select('email')
        .eq('organization_id', org.id)
        .range(from, from + PAGE - 1);
      if (sErr) {
        console.error('website-lead-intake: suppression read failed:', sErr.message);
        return json({ error: 'lookup_failed' }, 500);
      }
      for (const s of (sup ?? []) as Array<{ email: string | null }>) {
        if (s.email) suppressed.add(s.email.trim().toLowerCase());
      }
      if (!sup || sup.length < PAGE) break;
    }
  }

  // ---- Parse every row -----------------------------------------------------
  const statusByRow = new Map<number, { row_number: unknown; status: RowStatus; error?: string }>();
  const leadByEmail = new Map<string, ParsedLead>();
  // Which submitted rows a given address came from, so one write reports back
  // to every row that produced it.
  const rowsByEmail = new Map<string, number[]>();
  const unmappedInterests = new Set<string>();

  rawRows.forEach((raw, i) => {
    const rowNumber = raw?.row_number ?? i;
    const values = raw?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      statusByRow.set(i, { row_number: rowNumber, status: 'error', error: 'values_object_required' });
      return;
    }
    const verdict = parseLeadRow(values as Record<string, unknown>, locations);
    if (verdict.kind === 'skip') {
      statusByRow.set(i, {
        row_number: rowNumber,
        status: verdict.reason === 'test_row' ? 'skipped_test' : 'skipped_invalid_email',
      });
      return;
    }
    const lead = verdict.lead;
    for (const u of lead.unmapped_interests) unmappedInterests.add(u);

    if (suppressed.has(lead.email)) {
      // Logged, counted, and 200 — the row is handled, just not written.
      console.log(`website-lead-intake: row ${String(rowNumber)} skipped, address is on the suppression list`);
      statusByRow.set(i, { row_number: rowNumber, status: 'skipped_suppressed' });
      return;
    }

    const prior = leadByEmail.get(lead.email);
    leadByEmail.set(lead.email, prior ? mergeLeads(prior, lead) : lead);
    const rows = rowsByEmail.get(lead.email) ?? [];
    rows.push(i);
    rowsByEmail.set(lead.email, rows);
    // Status filled in after the write.
    statusByRow.set(i, { row_number: rowNumber, status: 'error', error: 'not_processed' });
  });

  // ---- Existing contacts ---------------------------------------------------
  const emails = [...leadByEmail.keys()];
  type ExistingRow = {
    id: string;
    email: string;
    parent_name: string | null;
    school_name: string | null;
    city: string | null;
    geo_segment: string | null;
    tags: string[] | null;
  };
  const existingByEmail = new Map<string, ExistingRow>();
  for (let i = 0; i < emails.length; i += IN_CHUNK) {
    const slice = emails.slice(i, i + IN_CHUNK);
    if (slice.length === 0) break;
    const { data: hits, error: exErr } = await supabase
      .from('marketing_recipients')
      .select('id, email, parent_name, school_name, city, geo_segment, tags')
      .eq('organization_id', org.id)
      .in('email', slice);
    if (exErr) {
      console.error('website-lead-intake: recipient lookup failed:', exErr.message);
      return json({ error: 'lookup_failed' }, 500);
    }
    for (const h of (hits ?? []) as ExistingRow[]) {
      if (h.email) existingByEmail.set(h.email.trim().toLowerCase(), h);
    }
  }

  // ---- Write ---------------------------------------------------------------
  // TWO SETS OF COUNTS, and they are not the same number. Two sheet rows for
  // one family are ONE contact but TWO rows, so a single "created: 3" would
  // have said three people were added when two were. `rows` is what the sheet
  // did; `contacts` is what the list did.
  const rowCounts = {
    created: 0, merged: 0, unchanged: 0,
    skipped_test: 0, skipped_suppressed: 0, skipped_invalid_email: 0, failed: 0,
  };
  const contactCounts = { created: 0, merged: 0, unchanged: 0, failed: 0 };

  for (const [email, lead] of leadByEmail) {
    const rows = rowsByEmail.get(email) ?? [];
    let status: RowStatus;
    let errText: string | undefined;
    try {
      status = await writeLead(supabase, org.id, lead, existingByEmail.get(email) ?? null);
    } catch (err) {
      status = 'error';
      errText = (err as Error).message ?? String(err);
      console.error(`website-lead-intake: write failed for one contact: ${errText}`);
    }
    if (status === 'created') contactCounts.created++;
    else if (status === 'merged') contactCounts.merged++;
    else if (status === 'unchanged') contactCounts.unchanged++;
    else contactCounts.failed++;
    for (const i of rows) {
      const entry = statusByRow.get(i);
      if (entry) {
        entry.status = status;
        entry.error = errText;
        if (errText === undefined) delete entry.error;
      }
    }
  }

  const results = [...statusByRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  for (const r of results) {
    switch (r.status) {
      case 'created': rowCounts.created++; break;
      case 'merged': rowCounts.merged++; break;
      case 'unchanged': rowCounts.unchanged++; break;
      case 'skipped_test': rowCounts.skipped_test++; break;
      case 'skipped_suppressed': rowCounts.skipped_suppressed++; break;
      case 'skipped_invalid_email': rowCounts.skipped_invalid_email++; break;
      case 'error': rowCounts.failed++; break;
    }
  }

  if (unmappedInterests.size > 0) {
    // Not an error — but the day the form gains a seventh checkbox, this is the
    // only place it shows up. A silently dropped option looks like nobody
    // ticking it.
    console.warn(
      `website-lead-intake: ${unmappedInterests.size} interest option(s) had no tag rule: ${[...unmappedInterests].join(' | ')}`,
    );
  }

  await logPlatformEvent(supabase, {
    feature: FEATURE.CONTACTS,
    action: ACTION.CONTACTS_IMPORTED,
    outcome: rowCounts.failed > 0 ? OUTCOME.FAIL : OUTCOME.SUCCESS,
    organizationId: org.id,
    metadata: {
      via: 'website_notify',
      rows_received: rawRows.length,
      contacts_created: contactCounts.created,
      contacts_merged: contactCounts.merged,
      contacts_unchanged: contactCounts.unchanged,
      contacts_failed: contactCounts.failed,
      rows_skipped_test: rowCounts.skipped_test,
      rows_skipped_suppressed: rowCounts.skipped_suppressed,
      rows_skipped_invalid_email: rowCounts.skipped_invalid_email,
      unmapped_interest_count: unmappedInterests.size,
    },
  });

  return json({
    ok: true,
    org_slug: org.slug,
    rows_received: rawRows.length,
    rows: rowCounts,
    contacts: contactCounts,
    unmapped_interests: [...unmappedInterests],
    results,
  });
});

// ---------------------------------------------------------------------------
// The one write path
// ---------------------------------------------------------------------------

// INSERT a contact we have never seen, or FILL THE BLANKS on one we have.
//
// The update half never sends a column whose current value is non-null, so
// "never overwrite an existing value with a form answer" is enforced by what is
// in the payload rather than by a coalesce someone can later delete. Tags are
// unioned. If nothing would change, no write is issued at all.
interface ContactSnapshot {
  id: string;
  parent_name: string | null;
  school_name: string | null;
  city: string | null;
  geo_segment: string | null;
  tags: string[] | null;
}

async function writeLead(
  supabase: SupabaseClient,
  orgId: string,
  lead: ParsedLead,
  known: ContactSnapshot | null,
): Promise<RowStatus> {
  let existing = known;
  if (!existing) {
    const { error } = await supabase.from('marketing_recipients').insert({
      organization_id: orgId,
      email: lead.email,
      parent_name: lead.parent_name,
      school_name: lead.school_name,
      city: lead.city,
      geo_segment: lead.geo_segment,
      tags: lead.tags,
      source: 'website_notify',
    });
    if (!error) return 'created';

    // 23505 = another run inserted the same address between our lookup and this
    // write. Re-read and fall through to the merge path rather than failing a
    // row that is actually fine.
    if (error.code !== '23505') {
      throw new Error(`insert_failed: ${error.message}`);
    }
    const { data: reread, error: reErr } = await supabase
      .from('marketing_recipients')
      .select('id, parent_name, school_name, city, geo_segment, tags')
      .eq('organization_id', orgId)
      .eq('email', lead.email)
      .maybeSingle();
    if (reErr) throw new Error(`insert_conflict_reread_failed: ${reErr.message}`);
    if (!reread) throw new Error('insert_conflict_but_no_row');
    existing = reread as unknown as ContactSnapshot;
  }

  const patch: Record<string, unknown> = {};
  if (!existing.parent_name && lead.parent_name) patch.parent_name = lead.parent_name;
  if (!existing.school_name && lead.school_name) patch.school_name = lead.school_name;
  if (!existing.city && lead.city) patch.city = lead.city;
  if (!existing.geo_segment && lead.geo_segment) patch.geo_segment = lead.geo_segment;

  // "Did this add a tag?" is a SET question, and it has to be asked as one.
  // Comparing the union's length against priorTags.length silently answers "no"
  // whenever the stored array holds a duplicate — ['registrant','registrant']
  // plus a new 'website-notify' is 2 either way — and the contact then never
  // gets the tag a campaign would target them by. Ask whether any incoming tag
  // is missing instead, which is the actual question.
  const priorTags = (existing.tags ?? []).filter((t) => typeof t === 'string' && t.trim() !== '');
  const priorSet = new Set(priorTags);
  const unionTags = [...new Set([...priorTags, ...lead.tags])];
  if (lead.tags.some((t) => !priorSet.has(t))) patch.tags = unionTags;

  if (Object.keys(patch).length === 0) return 'unchanged';

  patch.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('marketing_recipients')
    .update(patch)
    .eq('id', existing.id)
    .eq('organization_id', orgId);
  if (error) throw new Error(`update_failed: ${error.message}`);
  return 'merged';
}
