// FA26 early-bird registration send — one personalized email per school.
// Modes: preview (JSON only), test (send all variants to one inbox), send (real).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UNSUBSCRIBE_SECRET = Deno.env.get('MARKETING_UNSUBSCRIBE_SECRET')!;

const FROM_EMAIL = 'Journey to STEAM <hello@updates.journeytosteam.com>';
const REPLY_TO = 'jessica@journeytosteam.com';
const REGISTER_URL = 'https://enrops.com/j2s';
// Public endpoint for the unsubscribe edge function. Built from SUPABASE_URL so
// it works in any project without hardcoding the project ref.
const UNSUBSCRIBE_ENDPOINT = `${SUPABASE_URL}/functions/v1/marketing-unsubscribe`;
const VIP_TOTAL_CENTS = 72000;
const VIP_PER_TERM_CENTS = 24000;

// Each invocation gives itself this much wall-clock time for the send loop.
// Supabase edge functions are capped at ~150s, so 120s leaves room for the
// per-invocation setup (campaign/org/programs/recipients/dedup queries) plus
// the response write. When the budget is exhausted, the function fires a
// continuation request to its own URL (via EdgeRuntime.waitUntil) and returns
// a partial summary. The continuation picks up exactly where we left off
// because marketing_sends dedup skips everyone already sent.
const SEND_TIME_BUDGET_MS = 120_000;
const MAX_CHAIN_DEPTH = 30;

// Tenant-overridable colors and fonts are loaded per request from org_branding.
// These constants are platform defaults applied when an org has no branding row
// or a field is null.
const DEFAULT_PRIMARY = '#674EE8';
const DEFAULT_SECONDARY = '#4430AC';
const DEFAULT_ACCENT = '#F8A638';
const DEFAULT_PAGE_BG = '#f5f5f7';
const DEFAULT_FONT_STACK = "-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif";

// Platform-neutral text and chrome (not tenant-overridable).
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ProgramRow = {
  term: 'FA26' | 'WI27' | 'SP27';
  curriculum: string;
  day_of_week: string;
  start_time: string | null;
  end_time: string | null;
  first_session_date: string | null;
  session_count: number;
  price_cents: number;
  early_bird_price_cents: number | null;
  early_bird_deadline: string | null;
  short_description: string | null;
  program_type: string;
};

type SchoolContext = {
  displayName: string;
  programs: ProgramRow[];
  programsByTerm: { FA26: ProgramRow[]; WI27: ProgramRow[]; SP27: ProgramRow[] };
  pathways: ProgramRow[][]; // grouped by day_of_week when multi-program
  isFallOnly: boolean;
  isMultiProgram: boolean;
  fallProgram: ProgramRow | null;
  hasFullYear: boolean;
  vipSavingsCents: number; // per-pathway (Cannady's two pathways come out equal)
  fallSavingsCents: number;
  isSoftOpen: boolean;
};

type Campaign = {
  id: string;
  organization_id: string;
  template_data: {
    school_list: string[];
    soft_open_schools: string[];
    school_name_aliases: Record<string, string>;
    fall_descriptions: Record<string, string>;
    soft_open_ps: string;
    year_long_hook: string;
  };
};

type Recipient = {
  id: string;
  email: string;
  parent_name: string | null;
  child_first_name: string | null;
  school_name: string | null;
};

type Org = { id: string; name: string; logo_url: string | null; logo_email_url: string | null };

type Branding = {
  primary: string;
  secondary: string;
  accent: string;
  extra: string | null;
  pageBg: string;
  bodyFontStack: string;
  headingFontStack: string;
  googleFontsUrl: string | null;
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      campaign_id,
      mode = 'preview',
      test_email,
      school_filter,
      batch_size = 50,
      delay_ms = 1000,
    } = body ?? {};

    if (!campaign_id) return json({ error: 'campaign_id required' }, 400);
    if (!['preview', 'test', 'send'].includes(mode)) {
      return json({ error: `invalid mode: ${mode}` }, 400);
    }
    if (mode === 'test' && !test_email) {
      return json({ error: 'test_email required for mode=test' }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ---- Load campaign ----
    const { data: campaign, error: cErr } = await supabase
      .from('marketing_campaigns')
      .select('id, organization_id, template_data')
      .eq('id', campaign_id)
      .single<Campaign>();
    if (cErr || !campaign) return json({ error: `campaign not found: ${cErr?.message}` }, 404);
    const orgId = campaign.organization_id;
    const td = campaign.template_data || ({} as Campaign['template_data']);

    // ---- Load org ----
    const { data: org, error: oErr } = await supabase
      .from('organizations')
      .select('id, name, logo_url, logo_email_url')
      .eq('id', orgId)
      .single<Org>();
    if (oErr || !org) return json({ error: `org not found: ${oErr?.message}` }, 404);

    const branding = await loadBranding(supabase, orgId);

    // ---- Load programs (joined with locations) ----
    const { data: progRows, error: pErr } = await supabase
      .from('programs')
      .select(`
        term, curriculum, day_of_week, start_time, end_time,
        first_session_date, session_count, price_cents, early_bird_price_cents,
        early_bird_deadline, short_description, program_type,
        program_location:program_locations!inner(name)
      `)
      .eq('organization_id', orgId)
      .in('term', ['FA26', 'WI27', 'SP27'])
      .in('status', ['open']);
    if (pErr) return json({ error: `programs query failed: ${pErr.message}` }, 500);

    // ---- Build school -> programs map ----
    const schoolPrograms: Record<string, ProgramRow[]> = {};
    for (const row of progRows ?? []) {
      const schoolName = (row as any).program_location?.name as string;
      if (!schoolName) continue;
      const p: ProgramRow = {
        term: row.term,
        curriculum: row.curriculum,
        day_of_week: row.day_of_week,
        start_time: row.start_time,
        end_time: row.end_time,
        first_session_date: row.first_session_date,
        session_count: row.session_count,
        price_cents: row.price_cents,
        early_bird_price_cents: row.early_bird_price_cents,
        early_bird_deadline: row.early_bird_deadline,
        short_description: row.short_description,
        program_type: row.program_type,
      };
      (schoolPrograms[schoolName] ||= []).push(p);
    }

    // ---- Determine the school list ----
    const campaignSchools = td.school_list ?? [];
    const filterSet = school_filter ? new Set<string>(school_filter) : null;
    const targetSchools = campaignSchools.filter(s => {
      if (!schoolPrograms[s]) return false;
      if (!filterSet) return true;
      // school_filter accepts either display names or recipient aliases
      const recAliases = Object.entries(td.school_name_aliases ?? {})
        .filter(([_, disp]) => disp === s)
        .map(([rec]) => rec);
      return filterSet.has(s) || recAliases.some(a => filterSet.has(a));
    });

    // ---- Build display->recipient school name map ----
    const displayToRecipientNames: Record<string, string[]> = {};
    for (const s of campaignSchools) displayToRecipientNames[s] = [s];
    for (const [recName, dispName] of Object.entries(td.school_name_aliases ?? {})) {
      const arr = (displayToRecipientNames[dispName] ||= []);
      if (!arr.includes(recName)) arr.push(recName);
    }

    // ---- Build school contexts ----
    const softOpenSet = new Set(td.soft_open_schools ?? []);
    const contexts: SchoolContext[] = targetSchools.map(displayName => {
      const programs = schoolPrograms[displayName] ?? [];
      return buildSchoolContext(displayName, programs, softOpenSet.has(displayName));
    });

    // ---- Load recipients for target schools ----
    const allRecipientAliases = new Set<string>();
    for (const s of targetSchools) {
      for (const r of displayToRecipientNames[s] ?? []) allRecipientAliases.add(r);
    }
    // PostgREST caps responses at 1000 rows by default. Paginate so we always
    // get every recipient.
    const recRows: Recipient[] = [];
    const aliasList = [...allRecipientAliases];
    const PAGE = 1000;
    for (let off = 0; ; off += PAGE) {
      const { data: page, error: rErr } = await supabase
        .from('marketing_recipients')
        .select('id, email, parent_name, child_first_name, school_name')
        .eq('organization_id', orgId)
        .in('school_name', aliasList)
        .range(off, off + PAGE - 1);
      if (rErr) return json({ error: `recipients query failed: ${rErr.message}` }, 500);
      if (!page || page.length === 0) break;
      recRows.push(...(page as Recipient[]));
      if (page.length < PAGE) break;
    }

    const recipientsBySchool: Record<string, Recipient[]> = {};
    for (const r of recRows) {
      // map recipient.school_name back to display name
      const display = targetSchools.find(d =>
        (displayToRecipientNames[d] ?? []).includes(r.school_name ?? ''),
      );
      if (!display) continue;
      (recipientsBySchool[display] ||= []).push(r);
    }

    // ---- Load already-sent emails for dedup ----
    const alreadySent = new Set<string>();
    for (let off = 0; ; off += PAGE) {
      const { data: page } = await supabase
        .from('marketing_sends')
        .select('email')
        .eq('campaign_id', campaign_id)
        .eq('status', 'sent')
        .range(off, off + PAGE - 1);
      if (!page || page.length === 0) break;
      for (const r of page as { email: string }[]) alreadySent.add(r.email.toLowerCase());
      if (page.length < PAGE) break;
    }

    // ---- Load suppressed emails for this org ----
    // Anyone in marketing_suppressions is skipped without writing to
    // marketing_sends — the suppression row is the audit trail. CAN-SPAM
    // compliance + Gmail/Yahoo bulk-sender rules require honoring opt-outs
    // before sending, not after.
    const suppressed = new Set<string>();
    for (let off = 0; ; off += PAGE) {
      const { data: page } = await supabase
        .from('marketing_suppressions')
        .select('email')
        .eq('organization_id', orgId)
        .range(off, off + PAGE - 1);
      if (!page || page.length === 0) break;
      for (const r of page as { email: string }[]) suppressed.add(r.email.toLowerCase());
      if (page.length < PAGE) break;
    }

    // ---- Render emails per school ----
    type SchoolResult = {
      school: string;
      subject: string;
      recipient_count: number;
      sent: number;
      skipped_already_sent: number;
      skipped_suppressed: number;
      errors: number;
      first_error?: string;
      html?: string;
    };
    const results: SchoolResult[] = [];

    for (const ctx of contexts) {
      const recipients = recipientsBySchool[ctx.displayName] ?? [];
      const subject = renderSubject(ctx);
      // Preview HTML uses a synthetic unsubscribe URL — preview is never sent, so the
      // token doesn't need to verify. Real sends compute per-recipient URLs below.
      const previewUrl = await computeUnsubscribeUrl('preview@example.com', orgId);
      const previewHtml = renderHtml(ctx, td, org, 'there', branding, previewUrl);
      const result: SchoolResult = {
        school: ctx.displayName,
        subject,
        recipient_count: recipients.length,
        sent: 0,
        skipped_already_sent: 0,
        skipped_suppressed: 0,
        errors: 0,
      };
      if (mode === 'preview') {
        result.html = previewHtml;
      }
      results.push({ result, ctx, recipients } as any);
    }

    // ---- Dispatch by mode ----
    if (mode === 'preview') {
      const summary = (results as any[]).map(r => r.result);
      return json({
        mode,
        campaign_id,
        organization: org.name,
        schools_targeted: targetSchools.length,
        total_recipients: summary.reduce((n: number, r: SchoolResult) => n + r.recipient_count, 0),
        already_sent_count: alreadySent.size,
        suppressed_count: suppressed.size,
        schools_with_zero_recipients: summary
          .filter((r: SchoolResult) => r.recipient_count === 0)
          .map((r: SchoolResult) => r.school),
        results: summary,
      });
    }

    if (mode === 'test') {
      const testResults: { school: string; subject: string; ok: boolean; error?: string }[] = [];
      // Test sends use the test_email's real unsubscribe token so the link is
      // clickable end-to-end during QA.
      const testUnsubUrl = await computeUnsubscribeUrl(test_email!, orgId);
      for (const item of results as any[]) {
        const ctx: SchoolContext = item.ctx;
        const subject = `[TEST · ${ctx.displayName}] ${item.result.subject}`;
        const html = renderHtml(ctx, td, org, 'Jessica', branding, testUnsubUrl);
        try {
          await sendViaResend(test_email, subject, html, testUnsubUrl);
          testResults.push({ school: ctx.displayName, subject: item.result.subject, ok: true });
        } catch (e) {
          testResults.push({ school: ctx.displayName, subject: item.result.subject, ok: false, error: String(e) });
        }
        await sleep(delay_ms);
      }
      return json({
        mode,
        campaign_id,
        test_email,
        total_sent: testResults.filter(r => r.ok).length,
        total_failed: testResults.filter(r => !r.ok).length,
        results: testResults,
      });
    }

    // mode === 'send'
    const sendStarted = new Date().toISOString();
    const sendLoopStart = Date.now();
    const chainDepth = Number((body as any)?._chainDepth ?? 0);
    let queued = 0;
    let outOfTime = false;

    sendLoop: for (const item of results as any[]) {
      const ctx: SchoolContext = item.ctx;
      const recipients: Recipient[] = item.recipients;
      const result: SchoolResult = item.result;
      for (let i = 0; i < recipients.length; i++) {
        if (Date.now() - sendLoopStart > SEND_TIME_BUDGET_MS) {
          outOfTime = true;
          break sendLoop;
        }
        const r = recipients[i];
        const emailLower = r.email.toLowerCase();
        if (suppressed.has(emailLower)) {
          result.skipped_suppressed++;
          continue;
        }
        if (alreadySent.has(emailLower)) {
          result.skipped_already_sent++;
          continue;
        }
        const firstName = parseFirstName(r);
        const unsubUrl = await computeUnsubscribeUrl(r.email, orgId);
        const html = renderHtml(ctx, td, org, firstName, branding, unsubUrl);
        const subject = result.subject;
        try {
          const resendId = await sendViaResend(r.email, subject, html, unsubUrl);
          alreadySent.add(r.email.toLowerCase());
          await supabase.from('marketing_sends').insert({
            organization_id: orgId,
            campaign_id,
            recipient_id: r.id,
            email: r.email,
            school_name: ctx.displayName,
            status: 'sent',
            rendered_subject: subject,
            resend_message_id: resendId,
            sent_at: new Date().toISOString(),
          });
          result.sent++;
        } catch (e) {
          result.errors++;
          if (!result.first_error) result.first_error = String(e);
          await supabase.from('marketing_sends').insert({
            organization_id: orgId,
            campaign_id,
            recipient_id: r.id,
            email: r.email,
            school_name: ctx.displayName,
            status: 'failed',
            rendered_subject: subject,
            error_message: String(e).slice(0, 1000),
          });
        }
        queued++;
        if (queued % batch_size === 0) {
          await sleep(delay_ms);
        }
      }
    }

    // If we stopped early because we were running out of time, fire a
    // self-invocation to keep working in the background. Dedup against
    // marketing_sends.status='sent' means the continuation picks up exactly
    // where we left off without re-sending anyone.
    let continuationFired = false;
    if (outOfTime && chainDepth < MAX_CHAIN_DEPTH) {
      try {
        const continuationBody = { ...(body as Record<string, unknown>), _chainDepth: chainDepth + 1 };
        const continuationPromise = fetch(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(continuationBody),
        }).catch(err => console.error('continuation fetch failed:', err));
        const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
        if (edgeRuntime?.waitUntil) {
          edgeRuntime.waitUntil(continuationPromise);
        }
        continuationFired = true;
      } catch (e) {
        console.error('failed to schedule continuation:', e);
      }
    }

    const summary = (results as any[]).map(r => r.result);
    return json({
      mode,
      campaign_id,
      started_at: sendStarted,
      finished_at: new Date().toISOString(),
      schools: summary.length,
      total_sent: summary.reduce((n: number, r: SchoolResult) => n + r.sent, 0),
      total_skipped_already_sent: summary.reduce((n: number, r: SchoolResult) => n + r.skipped_already_sent, 0),
      total_skipped_suppressed: summary.reduce((n: number, r: SchoolResult) => n + r.skipped_suppressed, 0),
      total_errors: summary.reduce((n: number, r: SchoolResult) => n + r.errors, 0),
      suppressed_count: suppressed.size,
      chain_depth: chainDepth,
      continuation_fired: continuationFired,
      results: summary,
    });
  } catch (e) {
    console.error('marketing-send error:', e);
    return json({ error: (e as Error).message }, 500);
  }
});

// =====================================================================
// Helpers
// =====================================================================

function buildSchoolContext(
  displayName: string,
  programs: ProgramRow[],
  isSoftOpen: boolean,
): SchoolContext {
  const programsByTerm = {
    FA26: programs.filter(p => p.term === 'FA26'),
    WI27: programs.filter(p => p.term === 'WI27'),
    SP27: programs.filter(p => p.term === 'SP27'),
  };
  const hasFullYear = programsByTerm.FA26.length > 0 && programsByTerm.WI27.length > 0 && programsByTerm.SP27.length > 0;
  const isFallOnly = programsByTerm.FA26.length > 0 && !hasFullYear;
  const isMultiProgram = programsByTerm.FA26.length > 1;
  const fallProgram = programsByTerm.FA26[0] ?? null;

  // Group programs into "pathways" by day_of_week (Cannady has Mon + Fri).
  const days = isMultiProgram ? [...new Set(programsByTerm.FA26.map(p => p.day_of_week))] : [];
  const pathways: ProgramRow[][] = isMultiProgram
    ? days.map(day => {
        const fa = programsByTerm.FA26.find(p => p.day_of_week === day);
        const wi = programsByTerm.WI27.find(p => p.day_of_week === day);
        const sp = programsByTerm.SP27.find(p => p.day_of_week === day);
        return [fa, wi, sp].filter(Boolean) as ProgramRow[];
      })
    : hasFullYear
    ? [[programsByTerm.FA26[0], programsByTerm.WI27[0], programsByTerm.SP27[0]]]
    : [[programsByTerm.FA26[0]].filter(Boolean) as ProgramRow[]];

  // Compute VIP savings using the first complete pathway.
  let vipSavingsCents = 0;
  if (hasFullYear) {
    const firstFullPath = pathways.find(p => p.length === 3);
    if (firstFullPath) {
      const total = firstFullPath.reduce((s, p) => s + (p.price_cents || 0), 0);
      vipSavingsCents = Math.max(0, total - VIP_TOTAL_CENTS);
    }
  }
  const fallSavingsCents =
    fallProgram && fallProgram.early_bird_price_cents != null
      ? Math.max(0, fallProgram.price_cents - fallProgram.early_bird_price_cents)
      : 0;

  return {
    displayName,
    programs,
    programsByTerm,
    pathways,
    isFallOnly,
    isMultiProgram,
    fallProgram,
    hasFullYear,
    vipSavingsCents,
    fallSavingsCents,
    isSoftOpen,
  };
}

function renderSubject(ctx: SchoolContext): string {
  if (ctx.hasFullYear) {
    return `Save $${dollars(ctx.vipSavingsCents)} on a full year of STEAM at ${ctx.displayName} — early bird ends June 5`;
  }
  return `Save $${dollars(ctx.fallSavingsCents)} on fall STEAM at ${ctx.displayName} — early bird ends June 5`;
}

function renderHtml(
  ctx: SchoolContext,
  td: Campaign['template_data'],
  org: Org,
  firstName: string,
  branding: Branding,
  unsubscribeUrl: string,
): string {
  const intro = buildIntro(ctx, firstName);
  const vipBlock = ctx.hasFullYear ? renderVipBlock(ctx, td, branding) : '';
  const fallSection = renderFallSection(ctx, td, branding);
  const dividerForFallSection = ctx.hasFullYear
    ? `<tr><td style="padding:8px 0 0;">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
           <tr>
             <td style="border-top:1px solid ${BORDER};font-size:12px;color:${MUTED};padding-top:18px;text-align:center;letter-spacing:1px;text-transform:uppercase;">
               Just want fall?
             </td>
           </tr>
         </table>
       </td></tr>`
    : '';

  const ps = renderPsBlock(ctx, td);
  const preheader = ctx.hasFullYear
    ? `Three terms, one registration. Save $${dollars(ctx.vipSavingsCents)} before June 5.`
    : `Fall STEAM at ${ctx.displayName} — save $${dollars(ctx.fallSavingsCents)} before June 5.`;
  const fontsLink = branding.googleFontsUrl
    ? `<link rel="stylesheet" href="${escapeHtml(branding.googleFontsUrl)}">`
    : '';

  return asciiSafeHtml(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(renderSubject(ctx))}</title>
${fontsLink}
</head>
<body style="margin:0;padding:0;background:${branding.pageBg};font-family:${branding.bodyFontStack};color:${TEXT};line-height:1.55;">
<span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;color:${branding.pageBg};max-height:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${branding.pageBg};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;max-width:600px;width:100%;border:1px solid ${BORDER};">

<tr><td style="background:${branding.primary};padding:24px 24px;text-align:center;">
  ${renderHeaderLogo(org, branding)}
</td></tr>

<tr><td style="padding:32px 28px 8px;font-family:${branding.bodyFontStack};">
  <p style="margin:0 0 16px;font-size:16px;">Hi ${escapeHtml(firstName)},</p>
  <p style="margin:0 0 20px;font-size:16px;">${intro}</p>
</td></tr>

${vipBlock ? `<tr><td style="padding:0 28px;">${vipBlock}</td></tr>` : ''}

${
  ctx.hasFullYear
    ? `<tr><td style="padding:20px 28px 8px;text-align:center;">
         ${renderCta(REGISTER_URL, 'Register for the full year &rarr;', 'primary', branding)}
       </td></tr>`
    : ''
}

${dividerForFallSection}

<tr><td style="padding:${ctx.hasFullYear ? '24px' : '4px'} 28px 8px;">
  ${fallSection}
</td></tr>

<tr><td style="padding:8px 28px 24px;text-align:center;">
  ${renderCta(REGISTER_URL, ctx.hasFullYear ? 'Register for fall only &rarr;' : 'Register now &rarr;', ctx.hasFullYear ? 'secondary' : 'primary', branding)}
</td></tr>

<tr><td style="padding:8px 28px 28px;font-family:${branding.bodyFontStack};">
  ${ps}
</td></tr>

<tr><td style="background:${branding.pageBg};padding:24px 28px;color:${MUTED};font-size:13px;line-height:1.55;border-top:1px solid ${BORDER};font-family:${branding.bodyFontStack};">
  <p style="margin:0 0 8px;color:${TEXT};font-weight:600;font-size:14px;">Jessica Vorster &middot; Journey to STEAM</p>
  <p style="margin:0 0 12px;">jessica@journeytosteam.com &middot; (971) 258-2178</p>
  <p style="margin:0 0 14px;">You&rsquo;re receiving this because your child participated in a Journey to STEAM program at ${escapeHtml(ctx.displayName)}. Hit reply anytime &mdash; it goes straight to Jessica.</p>
  <p style="margin:0;font-size:12px;color:${MUTED};">Don&rsquo;t want emails like this? <a href="${escapeHtml(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>.</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`);
}

function renderHeaderLogo(org: Org, branding: Branding): string {
  const safeName = escapeHtml(org.name);
  // Prefer the rasterized email-safe PNG. Fall back to logo_url for orgs that
  // have not yet been processed by regenerate-email-logo. Text wordmark last.
  const logoUrl = org.logo_email_url ?? org.logo_url;
  if (logoUrl) {
    return `
      <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;">
        <tr><td style="padding:10px 18px;">
          <img src="${escapeHtml(logoUrl)}" alt="${safeName}" width="200" height="86" border="0" style="display:block;width:200px;height:86px;max-width:200px;border:0;outline:none;text-decoration:none;" />
        </td></tr>
      </table>`;
  }
  return `<span style="display:inline-block;background:#ffffff;padding:10px 22px;border-radius:10px;font-weight:700;font-size:20px;color:${branding.primary};letter-spacing:0.3px;font-family:${branding.headingFontStack};">${safeName}</span>`;
}

function renderVipBlock(ctx: SchoolContext, td: Campaign['template_data'], branding: Branding): string {
  const regularTotalCents = ctx.vipSavingsCents + VIP_TOTAL_CENTS;
  const pathwayBlocks = ctx.pathways
    .filter(p => p.length === 3)
    .map((path, idx) => {
      const dayLabel = ctx.isMultiProgram ? `${path[0].day_of_week} after-school pathway` : '';
      const cards = path.map(p => renderTermCard(p, branding)).join('');
      const header = dayLabel
        ? `<p style="margin:${idx === 0 ? '0' : '24px 0 0'};margin-bottom:12px;font-weight:700;font-size:13px;color:${branding.secondary};text-transform:uppercase;letter-spacing:0.6px;">${escapeHtml(dayLabel)}</p>`
        : '';
      return `${header}${cards}`;
    })
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid ${branding.primary};border-radius:14px;background:#faf9ff;">
      <tr><td style="padding:20px 22px 4px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${branding.secondary};">STEAM Year VIP</p>
        <p style="margin:0 0 4px;font-size:32px;font-weight:700;color:${TEXT};font-family:${branding.headingFontStack};">
          $${dollars(VIP_TOTAL_CENTS)}
          <span style="font-size:14px;font-weight:400;color:${MUTED};text-decoration:line-through;margin-left:8px;">$${dollars(regularTotalCents)}</span>
        </p>
        <p style="margin:0 0 6px;color:${MUTED};font-size:14px;">3 terms · $${dollars(VIP_PER_TERM_CENTS)}/term</p>
        <p style="margin:0 0 14px;">
          <span style="display:inline-block;background:${branding.accent};color:#ffffff;font-weight:700;font-size:12px;padding:4px 10px;border-radius:999px;letter-spacing:0.4px;">SAVE $${dollars(ctx.vipSavingsCents)}</span>
        </p>
      </td></tr>
      <tr><td style="padding:0 22px 20px;">
        ${pathwayBlocks}
        <p style="margin:14px 0 0;font-size:12px;color:${MUTED};line-height:1.5;">Returning families: $235/term. Sibling discount: 10% off the second child and beyond.</p>
      </td></tr>
    </table>`;
}

function renderTermCard(p: ProgramRow, branding: Branding): string {
  const termLabel = p.term === 'FA26' ? 'Fall' : p.term === 'WI27' ? 'Winter' : 'Spring';
  const dateBit =
    p.term === 'FA26' && p.first_session_date
      ? ` · Starts ${formatDate(p.first_session_date)}`
      : '';
  const sessions = p.session_count ? ` · ${p.session_count} sessions` : '';
  const desc = p.short_description ? `<p style="margin:6px 0 0;color:${MUTED};font-size:13px;line-height:1.5;">${escapeHtml(p.short_description)}</p>` : '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;">
      <tr>
        <td width="56" valign="top" style="width:56px;">
          <div style="background:${branding.primary};color:#ffffff;border-radius:999px;width:44px;height:44px;line-height:44px;text-align:center;font-weight:800;font-size:12px;letter-spacing:0.5px;">${termLabel.toUpperCase().slice(0, 3)}</div>
        </td>
        <td valign="top" style="padding-left:8px;">
          <p style="margin:0;font-weight:700;font-size:15px;color:${TEXT};">${escapeHtml(p.curriculum)}</p>
          <p style="margin:2px 0 0;color:${MUTED};font-size:13px;">${escapeHtml(p.day_of_week)}${dateBit}${sessions}</p>
          ${desc}
        </td>
      </tr>
    </table>`;
}

function renderFallSection(ctx: SchoolContext, td: Campaign['template_data'], branding: Branding): string {
  const cards = ctx.programsByTerm.FA26.map(p => renderFallCard(p, ctx, td, branding)).join('');
  return cards;
}

function renderFallCard(p: ProgramRow, ctx: SchoolContext, td: Campaign['template_data'], branding: Branding): string {
  const eb = p.early_bird_price_cents ?? p.price_cents;
  const reg = p.price_cents;
  const savings = Math.max(0, reg - eb);
  const dateBit = p.first_session_date ? ` · Starts ${formatDate(p.first_session_date)}` : '';
  const timeBit = p.start_time ? `, ${p.start_time}` : '';
  const sessions = p.session_count ? ` · ${p.session_count} sessions` : '';
  const dayMaybeMulti = ctx.isMultiProgram ? `${p.day_of_week} pathway · ` : '';
  const longDesc = td.fall_descriptions?.[p.curriculum] ?? p.short_description ?? '';
  const desc = longDesc ? `<p style="margin:14px 0 6px;color:${TEXT};font-size:14px;line-height:1.6;">${escapeHtml(longDesc)}</p>` : '';

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:12px;margin:12px 0;">
      <tr><td style="padding:18px 20px;">
        <p style="margin:0 0 2px;font-size:12px;font-weight:700;color:${MUTED};letter-spacing:0.6px;text-transform:uppercase;">${escapeHtml(dayMaybeMulti)}Fall 2026</p>
        <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:${TEXT};">${escapeHtml(p.curriculum)}</p>
        <p style="margin:0 0 10px;color:${MUTED};font-size:13px;">${escapeHtml(p.day_of_week)}${timeBit}${dateBit}${sessions}</p>
        <p style="margin:0 0 4px;">
          <span style="font-size:22px;font-weight:700;color:${TEXT};">$${dollars(eb)}</span>
          <span style="font-size:14px;font-weight:400;color:${MUTED};text-decoration:line-through;margin-left:8px;">$${dollars(reg)}</span>
          ${savings > 0 ? `<span style="display:inline-block;background:${branding.accent};color:#ffffff;font-weight:700;font-size:12px;padding:3px 10px;border-radius:999px;letter-spacing:0.4px;margin-left:8px;">SAVE $${dollars(savings)}</span>` : ''}
        </p>
        <p style="margin:6px 0 0;color:${branding.secondary};font-size:12px;font-weight:600;">Early-bird pricing ends June 5</p>
        ${desc}
        ${longDesc ? `<p style="margin:10px 0 0;font-size:13px;color:${MUTED};font-style:italic;">Future-ready skills, right after school.</p>` : ''}
      </td></tr>
    </table>`;
}

function renderCta(href: string, label: string, variant: 'primary' | 'secondary', branding: Branding): string {
  if (variant === 'primary') {
    return `<a href="${href}" style="display:inline-block;background:${branding.accent};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px;letter-spacing:0.2px;font-family:${branding.bodyFontStack};">${label}</a>`;
  }
  return `<a href="${href}" style="display:inline-block;background:#ffffff;color:${branding.secondary};text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:999px;border:2px solid ${branding.primary};letter-spacing:0.2px;font-family:${branding.bodyFontStack};">${label}</a>`;
}

function renderPsBlock(ctx: SchoolContext, td: Campaign['template_data']): string {
  const softOpen = ctx.isSoftOpen
    ? `<p style="margin:0 0 10px;color:${TEXT};font-size:14px;line-height:1.55;">P.S. We sent a note last week when registration opened &mdash; just a quick reminder before the year fills up.</p>`
    : '';
  const referral = `<p style="margin:0;color:${TEXT};font-size:14px;line-height:1.55;">P.S. Know another family at ${escapeHtml(ctx.displayName)} who&rsquo;d be interested? Forward this email &mdash; sometimes one share is all it takes to give a kid a great experience.</p>`;
  return softOpen + referral;
}

function buildIntro(ctx: SchoolContext, _firstName: string): string {
  const school = escapeHtml(ctx.displayName);

  if (ctx.isFallOnly) {
    return `Happy Spring! Great news &mdash; Journey to STEAM is coming to ${school} this fall! Your child can learn real coding through Minecraft &mdash; building games, solving challenges, and discovering the logic behind the game they already love.`;
  }

  const totalPrograms = ctx.programs.length;
  // "Minecraft pathway" applies whenever every program at the school is a
  // coding curriculum (Mario/Minecraft variants) with no LEGO or robotics.
  // Catches the pure-Minecraft schools (Alameda, Mabel Rush) and also schools
  // like Atfalati Ridge where the fall is Mario but winter/spring are Minecraft.
  const isMinecraftPathway =
    totalPrograms > 0 && ctx.programs.every(p => categorize(p.curriculum) === 'coding');
  if (isMinecraftPathway) {
    return `Happy Spring! Great news &mdash; we&rsquo;re already planning our next year at ${school}. Your child can follow a complete Minecraft coding pathway &mdash; block coding, interactive world design, and real Python. Same game they love, three completely different skill sets. By spring they&rsquo;re writing the same code real developers use.`;
  }

  // Robotics-heavy = majority of programs at this school are robotics curricula.
  // Counts all pathways (so Cannady's Monday + Friday both count). The activity
  // list adapts to which other domains the school actually has, so we never
  // claim a school has LEGO when it doesn't.
  const roboticsPrograms = ctx.programs.filter(p => categorize(p.curriculum) === 'robotics').length;
  if (totalPrograms > 0 && roboticsPrograms / totalPrograms > 0.5) {
    const heavyCats = new Set(ctx.programs.map(p => categorize(p.curriculum)));
    const activities: string[] = [];
    if (heavyCats.has('coding'))   activities.push('coding their own games');
    if (heavyCats.has('robotics')) activities.push('programming real robots');
    if (heavyCats.has('lego'))     activities.push('engineering real LEGO structures');
    return `Happy Spring! Great news &mdash; we&rsquo;re already planning our next year at ${school}. Your child can explore a different STEAM challenge each term &mdash; ${joinWithAnd(activities)}. Three terms, three totally different skill sets, one amazing year.`;
  }

  // Variety intro — adapts to which STEAM domains the school actually offers
  // so we never promise robotics to a school that has no robotics, etc.
  const cats = new Set(ctx.programs.map(p => categorize(p.curriculum)));
  const domains: string[] = [];
  const accomplishments: string[] = [];
  if (cats.has('coding')) { domains.push('coding'); accomplishments.push('designed games'); }
  if (cats.has('lego'))   { domains.push('engineering'); accomplishments.push('engineered structures'); }
  if (cats.has('robotics')) { domains.push('robotics'); accomplishments.push('programmed robots'); }
  const domainList = joinWithAnd(domains);
  const accomplishmentList = joinWithAnd(accomplishments);

  return `Happy Spring! Great news &mdash; we&rsquo;re already planning our next year at ${school}. Your child can explore a different side of STEAM each term &mdash; ${domainList}. Each term builds different skills, so by the end of the year they&rsquo;ve ${accomplishmentList}. It&rsquo;s a full year of STEAM, not just one class.`;
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function categorize(name: string): 'coding' | 'lego' | 'robotics' | 'other' {
  if (!name) return 'other';
  if (name.includes('Robotics')) return 'robotics';
  if (name.includes('LEGO') || name.includes('Pokémon')) return 'lego';
  if (name.includes('Minecraft') || name.includes('Mario') || name.includes('Coders')) return 'coding';
  return 'other';
}

function parseFirstName(r: Recipient): string {
  const name = r.parent_name?.trim();
  if (!name) return 'there';
  const parts = name.split(/\s+/);
  return parts[0] || 'there';
}

function dollars(cents: number): string {
  if (cents % 100 === 0) return String(Math.round(cents / 100));
  return (cents / 100).toFixed(2);
}

function formatDate(iso: string): string {
  // Expect 'YYYY-MM-DD'. Parse explicitly to avoid TZ shifts.
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}`;
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Belt-and-suspenders: rewrite every non-ASCII codepoint in the final HTML to
// a numeric HTML entity. This makes the body pure ASCII so it renders
// correctly even in email clients or viewers that misinterpret the charset.
function asciiSafeHtml(html: string): string {
  let out = '';
  for (let i = 0; i < html.length; i++) {
    const code = html.charCodeAt(i);
    out += code >= 128 ? '&#' + code + ';' : html[i];
  }
  return out;
}

async function sendViaResend(
  to: string,
  subject: string,
  html: string,
  unsubscribeUrl: string,
): Promise<string> {
  // List-Unsubscribe + List-Unsubscribe-Post: List-Unsubscribe=One-Click is the
  // RFC 8058 pair Gmail and Yahoo require for bulk senders. Including a mailto
  // fallback ensures clients that don't speak HTTPS one-click still get a
  // working unsubscribe path.
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      reply_to: REPLY_TO,
      subject,
      html,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:${REPLY_TO}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.id ?? '';
}

// Builds the per-recipient unsubscribe URL with an HMAC-signed token. The
// marketing-unsubscribe edge function verifies the token before inserting a
// suppression row, which prevents a leaked URL pattern from being used to
// unsubscribe arbitrary addresses.
async function computeUnsubscribeUrl(email: string, orgId: string): Promise<string> {
  const lowered = email.toLowerCase();
  const token = await hmacToken(lowered, orgId);
  const params = new URLSearchParams({ email: lowered, org: orgId, t: token });
  return `${UNSUBSCRIBE_ENDPOINT}?${params.toString()}`;
}

async function hmacToken(email: string, orgId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(UNSUBSCRIBE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${email}:${orgId}`),
  );
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Loads a tenant's branding row + resolves the two chosen fonts to full CSS
// stacks plus a single Google Fonts <link> URL. Falls back to platform
// defaults for any field that is null or for an org with no branding row.
async function loadBranding(supabase: any, orgId: string): Promise<Branding> {
  const { data: b } = await supabase
    .from('org_branding')
    .select('primary_color, secondary_color, accent_color, extra_color, page_bg_color, heading_font, body_font')
    .eq('organization_id', orgId)
    .maybeSingle();

  let headingStack = DEFAULT_FONT_STACK;
  let bodyStack = DEFAULT_FONT_STACK;
  const fontParams: string[] = [];

  const fontNames = [b?.heading_font, b?.body_font].filter(Boolean) as string[];
  if (fontNames.length > 0) {
    const { data: fonts } = await supabase
      .from('available_fonts')
      .select('name, google_fonts_param, fallback_stack')
      .in('name', fontNames);
    const byName = new Map<string, { name: string; google_fonts_param: string; fallback_stack: string }>(
      (fonts ?? []).map((f: any) => [f.name, f]),
    );
    if (b?.heading_font && byName.has(b.heading_font)) {
      const f = byName.get(b.heading_font)!;
      headingStack = `'${f.name}',${f.fallback_stack}`;
      fontParams.push(f.google_fonts_param);
    }
    if (b?.body_font && byName.has(b.body_font)) {
      const f = byName.get(b.body_font)!;
      bodyStack = `'${f.name}',${f.fallback_stack}`;
      fontParams.push(f.google_fonts_param);
    }
  }

  return {
    primary: b?.primary_color ?? DEFAULT_PRIMARY,
    secondary: b?.secondary_color ?? DEFAULT_SECONDARY,
    accent: b?.accent_color ?? DEFAULT_ACCENT,
    extra: b?.extra_color ?? null,
    pageBg: b?.page_bg_color ?? DEFAULT_PAGE_BG,
    bodyFontStack: bodyStack,
    headingFontStack: headingStack,
    googleFontsUrl: fontParams.length > 0
      ? `https://fonts.googleapis.com/css2?${fontParams.map(p => `family=${p}`).join('&')}&display=swap`
      : null,
  };
}
