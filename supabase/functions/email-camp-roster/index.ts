// email-camp-roster: sends a branded PDF roster for a camp to the partner
// organisation's logistics contacts.
//
// Input:
//   {
//     camp_session_id: string,           // required
//     recipient_contact_ids?: string[],  // partner_contacts.id rows to include
//     include_location_contact?: boolean,// also email program_locations.contact_email if set
//     cc?: string[],                     // ad-hoc CC emails (validated, deduped)
//     message?: string,                  // optional operator note in email body
//     mode?: 'preview' | 'send'          // preview returns recipients + camper count without sending
//   }
//
// Multi-tenant: caller must be owner/admin of the org that owns the camp.
// Recipients are intersected with the camp's org's partner_contacts. PDF
// embeds the tenant's logo + primary colour.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { loadOrgBrand, renderSignatureBlock, encodeDisplayName } from '../_shared/orgBrand.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DEFAULT_PRIMARY = '#1C004F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e2dfd5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const campSessionId: string | undefined = body.camp_session_id;
    const recipientContactIds: string[] = Array.isArray(body.recipient_contact_ids) ? body.recipient_contact_ids : [];
    const includeLocationContact: boolean = !!body.include_location_contact;
    const ccRaw: string[] = Array.isArray(body.cc) ? body.cc : [];
    const message: string = typeof body.message === 'string' ? body.message.trim() : '';
    const mode: 'preview' | 'send' = body.mode === 'send' ? 'send' : 'preview';

    if (!campSessionId) return json({ error: 'camp_session_id is required' }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    // ── Load camp + location + partner ─────────────────────────────────────
    const { data: camp, error: campErr } = await supabase
      .from('camp_sessions')
      .select(`
        id, organization_id, location_id,
        curriculum_name, location_name, week_num, session_type,
        starts_on, ends_on, start_time, end_time, ages_min, ages_max,
        current_enrollment
      `)
      .eq('id', campSessionId)
      .maybeSingle();
    if (campErr || !camp) return json({ error: 'camp not found' }, 404);

    const { data: memberRow } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', camp.organization_id)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, slug, sending_domain, default_sender_email, default_sender_name, logo_email_url, logo_url')
      .eq('id', camp.organization_id)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);

    const { data: branding } = await supabase
      .from('org_branding')
      .select('primary_color, logo_url, email_from_name, email_reply_to')
      .eq('organization_id', camp.organization_id)
      .maybeSingle();
    const primaryColor = branding?.primary_color ?? DEFAULT_PRIMARY;
    const fromName = branding?.email_from_name ?? org.default_sender_name ?? org.name;
    const replyTo = branding?.email_reply_to ?? null;

    const brand = await loadOrgBrand(supabase, camp.organization_id);

    let location: any = null;
    let partner: any = null;
    if (camp.location_id) {
      const { data: locRow } = await supabase
        .from('program_locations')
        .select('id, name, district, address, room_number, contact_name, contact_email, contact_phone, partner_id, organization_id')
        .eq('id', camp.location_id)
        .maybeSingle();
      location = locRow ?? null;
      if (location?.partner_id) {
        const { data: partnerRow } = await supabase
          .from('partners')
          .select('id, partner_name, partner_type, organization_id, inactive')
          .eq('id', location.partner_id)
          .maybeSingle();
        partner = partnerRow ?? null;
      }
    }

    // ── Resolve recipients ─────────────────────────────────────────────────
    type Recipient = { name: string; email: string; role: string | null; source: 'partner_contact' | 'location_contact' | 'ad_hoc_cc' };
    const recipients: Recipient[] = [];
    const seen = new Set<string>();

    if (recipientContactIds.length > 0) {
      const { data: contacts } = await supabase
        .from('partner_contacts')
        .select('id, contact_name, contact_email, contact_role, partner_id, organization_id')
        .in('id', recipientContactIds)
        .eq('organization_id', camp.organization_id);
      for (const c of contacts ?? []) {
        const email = (c.contact_email ?? '').trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        recipients.push({
          name: c.contact_name ?? '',
          email,
          role: c.contact_role ?? null,
          source: 'partner_contact',
        });
      }
    }

    if (includeLocationContact && location?.contact_email) {
      const email = location.contact_email.trim().toLowerCase();
      if (email && !seen.has(email)) {
        seen.add(email);
        recipients.push({
          name: location.contact_name ?? location.name ?? '',
          email,
          role: 'location_contact',
          source: 'location_contact',
        });
      }
    }

    for (const raw of ccRaw) {
      const email = (raw ?? '').trim().toLowerCase();
      if (!email) continue;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      recipients.push({ name: '', email, role: null, source: 'ad_hoc_cc' });
    }

    if (recipients.length === 0 && mode === 'send') {
      return json({ error: 'no valid recipients selected' }, 400);
    }

    // ── Load registrations + students + parents ────────────────────────────
    const { data: regs, error: regErr } = await supabase
      .from('registrations')
      .select(`
        id, status, authorized_pickup_contacts, registered_at,
        student:students ( id, first_name, last_name, grade, birthdate, pronouns,
                           emergency_contact_name, emergency_contact_phone ),
        parent:parents ( id, first_name, last_name, email, phone )
      `)
      .eq('camp_session_id', camp.id)
      .order('registered_at', { ascending: true });
    if (regErr) return json({ error: `roster query: ${regErr.message}` }, 500);
    const campers = (regs ?? []).filter((r: any) => r.student && r.status !== 'cancelled');

    // ── Load instructor(s) on this camp ────────────────────────────────────
    const { data: asgs } = await supabase
      .from('camp_assignments')
      .select('id, role, status, instructor:instructors ( id, first_name, last_name, email, phone )')
      .eq('camp_session_id', camp.id)
      .in('status', ['confirmed', 'published'])
      .order('role', { ascending: true });
    const instructors = (asgs ?? [])
      .filter((a: any) => a.instructor)
      .map((a: any) => ({
        name: `${a.instructor.first_name ?? ''} ${a.instructor.last_name ?? ''}`.trim(),
        phone: a.instructor.phone ?? '',
        email: a.instructor.email ?? '',
        role: a.role,
      }));

    if (mode === 'preview') {
      return json({
        recipients,
        camper_count: campers.length,
        instructor_count: instructors.length,
        instructors,
        partner: partner ? { id: partner.id, name: partner.partner_name } : null,
        location: location ? { id: location.id, name: location.name, has_contact_email: !!location.contact_email } : null,
      });
    }

    // ── Build the PDF ──────────────────────────────────────────────────────
    const pdfBytes = await buildRosterPdf({
      orgName: org.name,
      primaryColor,
      // Canonical logo: the email-safe PNG (works in pdf-lib) first, then the
      // source logo, then the legacy org_branding field. Tracks logo changes.
      logoUrl: org.logo_email_url ?? org.logo_url ?? branding?.logo_url ?? null,
      camp,
      location,
      partner,
      instructors,
      campers,
    });

    // Base64 for Resend's attachment field
    const pdfBase64 = bytesToBase64(pdfBytes);
    const pdfFilename = makePdfFilename({ campName: camp.curriculum_name, startsOn: camp.starts_on, locationName: camp.location_name });

    // ── Compose email ──────────────────────────────────────────────────────
    // Sender is tenant-driven — never hardcode one tenant's domain. Prefer the
    // org's configured sender email; else hello@ on its verified sending domain.
    // A tenant with neither configured returns a clear error instead of
    // misbranding as another tenant.
    const senderEmail = org.default_sender_email
      || (org.sending_domain ? `hello@${org.sending_domain}` : null);
    if (!senderEmail) {
      return json({ error: 'no_sender_configured', detail: 'Add a sending email or verified domain in Settings before emailing rosters.' }, 400);
    }
    const fromEmail = `${encodeDisplayName(fromName)} <${senderEmail}>`;
    const subjectPartner = partner?.partner_name ?? location?.name ?? camp.location_name;
    const subject = `Roster: ${camp.curriculum_name} — ${fmtDateRange(camp.starts_on, camp.ends_on)}${subjectPartner ? ` @ ${subjectPartner}` : ''}`;

    const html = renderEmailHtml({
      orgName: org.name,
      primaryColor,
      camp,
      location,
      partner,
      instructors,
      camperCount: campers.length,
      message,
      signatureHtml: renderSignatureBlock(brand),
    });
    const text = renderEmailText({
      orgName: org.name,
      camp,
      location,
      partner,
      instructors,
      camperCount: campers.length,
      message,
    });

    // Send one email per recipient so each only sees themselves (most
    // partners are competitor-adjacent — no cross-disclosure of who else
    // got the roster).
    const sent: Array<{ email: string; message_id: string | null }> = [];
    const failed: Array<{ email: string; reason: string }> = [];
    for (const r of recipients) {
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: fromEmail,
            to: r.email,
            reply_to: replyTo ?? undefined,
            subject,
            html,
            text,
            attachments: [
              { filename: pdfFilename, content: pdfBase64 },
            ],
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          failed.push({ email: r.email, reason: `resend ${resp.status}: ${errText.slice(0, 200)}` });
          continue;
        }
        const data = await resp.json().catch(() => ({}));
        sent.push({ email: r.email, message_id: data?.id ?? null });
      } catch (err) {
        failed.push({ email: r.email, reason: (err as Error).message });
      }
    }

    // ── Audit row ──────────────────────────────────────────────────────────
    const status = failed.length === 0 ? 'sent' : (sent.length === 0 ? 'failed' : 'sent');
    const failureReason = failed.length === 0 ? null : failed.map((f) => `${f.email}: ${f.reason}`).join('; ');
    const resendMessageId = sent.length > 0 ? sent[0].message_id : null;
    await supabase.from('roster_email_sends').insert({
      organization_id: camp.organization_id,
      camp_session_id: camp.id,
      partner_id: partner?.id ?? null,
      sent_by_user_id: userData.user.id,
      recipients,
      message: message || null,
      resend_message_id: resendMessageId,
      status,
      failure_reason: failureReason,
      roster_camper_count: campers.length,
    });

    return json({
      sent: sent.length,
      failed,
      camper_count: campers.length,
      partner: partner ? { id: partner.id, name: partner.partner_name } : null,
    });
  } catch (err) {
    console.error('[email-camp-roster] unexpected', err);
    return json({ error: (err as Error).message ?? 'unexpected error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── PDF generation ───────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 0.11, g: 0, b: 0.31 };
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateRange(a: string | null, b: string | null): string {
  if (!a) return '';
  const A = new Date(`${a}T00:00:00`);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (!b || b === a) return A.toLocaleDateString('en-US', opts);
  const B = new Date(`${b}T00:00:00`);
  if (A.getMonth() === B.getMonth()) {
    return `${A.toLocaleDateString('en-US', opts)}–${B.getDate()}`;
  }
  return `${A.toLocaleDateString('en-US', opts)}–${B.toLocaleDateString('en-US', opts)}`;
}

function fmtTime(t: string | null | undefined): string {
  if (!t) return '';
  const [hh, mm] = t.split(':');
  const h = parseInt(hh, 10);
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${mm}${period}`;
}

function makePdfFilename(p: { campName: string; startsOn: string; locationName: string }): string {
  const safe = (s: string) => (s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `Roster-${safe(p.campName)}-${safe(p.locationName)}-${p.startsOn || 'unknown'}.pdf`.slice(0, 120);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function buildRosterPdf(params: {
  orgName: string;
  primaryColor: string;
  logoUrl: string | null;
  camp: any;
  location: any;
  partner: any;
  instructors: Array<{ name: string; phone: string; email: string; role: string }>;
  campers: any[];
}): Promise<Uint8Array> {
  const { orgName, primaryColor, logoUrl, camp, location, partner, instructors, campers } = params;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const primary = hexToRgb(primaryColor);
  const ink = hexToRgb(INK);
  const muted = hexToRgb(MUTED);
  const border = hexToRgb(BORDER);

  // Page geometry: letter, LANDSCAPE (792 x 612). Roster tables are
  // naturally wider than tall and we have 6 columns including emergency
  // contact, so portrait clips the right-hand column.
  const PAGE_W = 792;
  const PAGE_H = 612;
  const MARGIN_X = 40;
  const HEADER_H = 72;
  const FOOTER_H = 24;

  // Embed logo (best-effort; skip on failure)
  let logoImage: any = null;
  let logoDims: { width: number; height: number } | null = null;
  if (logoUrl) {
    try {
      const r = await fetch(logoUrl);
      if (r.ok) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('png') || logoUrl.toLowerCase().endsWith('.png')) {
          logoImage = await doc.embedPng(bytes);
        } else if (ct.includes('jpeg') || ct.includes('jpg') || /\.jpe?g$/i.test(logoUrl)) {
          logoImage = await doc.embedJpg(bytes);
        }
        if (logoImage) {
          const targetH = 36;
          const scale = targetH / logoImage.height;
          logoDims = { width: logoImage.width * scale, height: targetH };
        }
      }
    } catch (_e) {
      // Silently fall back to text-only header.
    }
  }

  // Columns
  const COLS = [
    { key: 'name', label: 'Camper', width: 130 },
    { key: 'grade', label: 'Grade', width: 40 },
    { key: 'parent', label: 'Parent', width: 110 },
    { key: 'parent_phone', label: 'Parent phone', width: 90 },
    { key: 'parent_email', label: 'Parent email', width: 130 },
    { key: 'ec', label: 'Emergency contact', width: 122 },
  ];
  const TABLE_W = COLS.reduce((s, c) => s + c.width, 0);
  const ROW_H = 28;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let yCursor = drawHeaderAndInfo(page);
  let pageNum = 1;

  // Header band drawer (also used for new pages — but on continuation
  // pages we draw a smaller header).
  function drawHeaderAndInfo(p: any): number {
    // Coloured top band
    p.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: rgb(primary.r, primary.g, primary.b) });
    // Logo or org name in band
    if (logoImage && logoDims) {
      p.drawImage(logoImage, { x: MARGIN_X, y: PAGE_H - HEADER_H + (HEADER_H - logoDims.height) / 2, width: logoDims.width, height: logoDims.height });
    } else {
      p.drawText(orgName, { x: MARGIN_X, y: PAGE_H - HEADER_H + 40, size: 16, font: bold, color: rgb(1, 1, 1) });
    }
    p.drawText('Camp roster', { x: MARGIN_X, y: PAGE_H - HEADER_H + 18, size: 11, font, color: rgb(1, 1, 1) });

    let y = PAGE_H - HEADER_H - 22;
    // Camp title
    p.drawText(camp.curriculum_name ?? 'Camp', { x: MARGIN_X, y, size: 16, font: bold, color: rgb(ink.r, ink.g, ink.b) });
    y -= 18;
    const subParts: string[] = [];
    subParts.push(fmtDateRange(camp.starts_on, camp.ends_on));
    if (camp.start_time && camp.end_time) subParts.push(`${fmtTime(camp.start_time)}–${fmtTime(camp.end_time)}`);
    if (camp.session_type) subParts.push(camp.session_type.replace(/_/g, ' '));
    if (camp.ages_min || camp.ages_max) subParts.push(`Ages ${camp.ages_min ?? '?'}–${camp.ages_max ?? '?'}`);
    p.drawText(subParts.filter(Boolean).join('  ·  '), { x: MARGIN_X, y, size: 10, font, color: rgb(muted.r, muted.g, muted.b) });
    y -= 18;

    // Two-column block: Location on left, instructor on right
    const leftLines: string[] = [];
    if (partner?.partner_name) leftLines.push(`Partner: ${partner.partner_name}`);
    if (location?.name) leftLines.push(`Location: ${location.name}${location.room_number ? ` (Room ${location.room_number})` : ''}`);
    if (camp.location_name && !location?.name) leftLines.push(`Location: ${camp.location_name}`);
    if (location?.address) leftLines.push(location.address);

    const rightLines: string[] = [];
    if (instructors.length === 0) {
      rightLines.push('Instructor: not yet assigned');
    } else {
      for (const inst of instructors) {
        const label = inst.role === 'lead' ? 'Instructor' : (inst.role || 'Instructor');
        rightLines.push(`${label}: ${inst.name || '—'}`);
        const c: string[] = [];
        if (inst.phone) c.push(inst.phone);
        if (inst.email) c.push(inst.email);
        if (c.length) rightLines.push(`  ${c.join(' · ')}`);
      }
    }

    const blockTop = y;
    let yLeft = blockTop;
    for (const line of leftLines) {
      p.drawText(line, { x: MARGIN_X, y: yLeft, size: 10, font, color: rgb(ink.r, ink.g, ink.b) });
      yLeft -= 13;
    }
    let yRight = blockTop;
    const rightX = MARGIN_X + 280;
    for (const line of rightLines) {
      p.drawText(line, { x: rightX, y: yRight, size: 10, font, color: rgb(ink.r, ink.g, ink.b) });
      yRight -= 13;
    }
    const blockBottom = Math.min(yLeft, yRight);

    // Roster count line
    let yCount = blockBottom - 4;
    p.drawText(`${campers.length} camper${campers.length === 1 ? '' : 's'} on this roster`,
      { x: MARGIN_X, y: yCount, size: 10, font: bold, color: rgb(primary.r, primary.g, primary.b) });
    yCount -= 14;

    // Table header row
    let xc = MARGIN_X;
    const headerY = yCount - 12;
    p.drawRectangle({ x: MARGIN_X, y: headerY - 6, width: TABLE_W, height: 20, color: rgb(0.96, 0.96, 0.94) });
    for (const col of COLS) {
      p.drawText(col.label, { x: xc + 4, y: headerY, size: 9, font: bold, color: rgb(muted.r, muted.g, muted.b) });
      xc += col.width;
    }
    return headerY - 6; // y where row drawing should start (top of next row)
  }

  function drawContinuationHeader(p: any): number {
    p.drawRectangle({ x: 0, y: PAGE_H - 36, width: PAGE_W, height: 36, color: rgb(primary.r, primary.g, primary.b) });
    if (logoImage && logoDims) {
      const h = 18;
      const s = h / logoImage.height;
      p.drawImage(logoImage, { x: MARGIN_X, y: PAGE_H - 28, width: logoImage.width * s, height: h });
    } else {
      p.drawText(orgName, { x: MARGIN_X, y: PAGE_H - 24, size: 11, font: bold, color: rgb(1, 1, 1) });
    }
    p.drawText(`${camp.curriculum_name ?? 'Roster'} — continued`, { x: PAGE_W - MARGIN_X - 180, y: PAGE_H - 24, size: 10, font, color: rgb(1, 1, 1) });

    const headerY = PAGE_H - 60;
    let xc = MARGIN_X;
    p.drawRectangle({ x: MARGIN_X, y: headerY - 6, width: TABLE_W, height: 20, color: rgb(0.96, 0.96, 0.94) });
    for (const col of COLS) {
      p.drawText(col.label, { x: xc + 4, y: headerY, size: 9, font: bold, color: rgb(muted.r, muted.g, muted.b) });
      xc += col.width;
    }
    return headerY - 6;
  }

  function drawFooter(p: any, pNum: number, pTotal: number | null) {
    const text = `${orgName}  ·  Generated ${new Date().toLocaleDateString('en-US')}  ·  Page ${pNum}${pTotal ? ` of ${pTotal}` : ''}`;
    p.drawText(text, { x: MARGIN_X, y: FOOTER_H, size: 8, font, color: rgb(muted.r, muted.g, muted.b) });
  }

  // ── Draw rows ──────────────────────────────────────────────────────────────
  let y = yCursor;
  const pages: any[] = [page];
  if (campers.length === 0) {
    page.drawText('No campers are currently on this roster.', { x: MARGIN_X, y: y - 18, size: 11, font, color: rgb(muted.r, muted.g, muted.b) });
  } else {
    for (const reg of campers) {
      if (y - ROW_H < FOOTER_H + 16) {
        // start new page
        page = doc.addPage([PAGE_W, PAGE_H]);
        pages.push(page);
        y = drawContinuationHeader(page);
      }
      const s = reg.student ?? {};
      const p2 = reg.parent ?? {};
      const camperName = `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || 'Unnamed';
      const dobLine = s.birthdate ? `DOB ${s.birthdate}` : '';
      const parentName = `${p2.first_name ?? ''} ${p2.last_name ?? ''}`.trim() || '—';
      const ec = s.emergency_contact_name
        ? `${s.emergency_contact_name}${s.emergency_contact_phone ? ` · ${s.emergency_contact_phone}` : ''}`
        : '—';

      // Row separator
      page.drawLine({ start: { x: MARGIN_X, y: y - 0.5 }, end: { x: MARGIN_X + TABLE_W, y: y - 0.5 }, thickness: 0.5, color: rgb(border.r, border.g, border.b) });

      const values: Record<string, string> = {
        name: camperName,
        grade: s.grade ?? '',
        parent: parentName,
        parent_phone: p2.phone ?? '',
        parent_email: p2.email ?? '',
        ec,
      };
      let xc = MARGIN_X;
      for (const col of COLS) {
        const text = truncate(values[col.key] ?? '', col.width, font, 9);
        page.drawText(text, { x: xc + 4, y: y - 14, size: 9, font, color: rgb(ink.r, ink.g, ink.b) });
        if (col.key === 'name' && dobLine) {
          page.drawText(dobLine, { x: xc + 4, y: y - 24, size: 7, font, color: rgb(muted.r, muted.g, muted.b) });
        }
        xc += col.width;
      }
      y -= ROW_H;
    }
  }

  // Footer on every page
  for (let i = 0; i < pages.length; i++) {
    drawFooter(pages[i], i + 1, pages.length);
  }

  return await doc.save();
}

function truncate(s: string, widthPts: number, font: any, size: number): string {
  if (!s) return '';
  const limit = widthPts - 8;
  if (font.widthOfTextAtSize(s, size) <= limit) return s;
  const ellipsis = '…';
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (font.widthOfTextAtSize(s.slice(0, mid) + ellipsis, size) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + ellipsis;
}

// ── Email body ───────────────────────────────────────────────────────────────

function renderEmailHtml(params: {
  orgName: string;
  primaryColor: string;
  camp: any;
  location: any;
  partner: any;
  instructors: Array<{ name: string; phone: string; email: string; role: string }>;
  camperCount: number;
  message: string;
  signatureHtml: string;
}): string {
  const { orgName, primaryColor, camp, location, partner, instructors, camperCount, message, signatureHtml } = params;
  const greeting = partner?.partner_name ? `Hello ${escapeHtml(partner.partner_name)} team,` : 'Hello,';
  const where = location?.name || camp.location_name || '';
  const dateRange = fmtDateRange(camp.starts_on, camp.ends_on);
  const timeRange = (camp.start_time && camp.end_time) ? `${fmtTime(camp.start_time)}–${fmtTime(camp.end_time)}` : '';
  const instructorBlock = instructors.length === 0
    ? '<p style="margin:8px 0;font-size:13px;color:#6b6b6b;"><em>Instructor not yet assigned — we\'ll follow up once confirmed.</em></p>'
    : instructors.map((i) => {
        const contactBits: string[] = [];
        if (i.phone) contactBits.push(`<a href="tel:${escapeAttr(i.phone)}" style="color:${primaryColor};">${escapeHtml(i.phone)}</a>`);
        if (i.email) contactBits.push(`<a href="mailto:${escapeAttr(i.email)}" style="color:${primaryColor};">${escapeHtml(i.email)}</a>`);
        return `<p style="margin:4px 0;font-size:13px;color:#1a1a1a;"><strong>${escapeHtml(i.role === 'lead' ? 'Instructor' : (i.role || 'Instructor'))}:</strong> ${escapeHtml(i.name || '—')}${contactBits.length ? ` · ${contactBits.join(' · ')}` : ''}</p>`;
      }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="margin:0;padding:24px;background:#f5f4ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;">
    <div style="background:${primaryColor};color:#fff;padding:18px 24px;">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Camp roster</div>
      <div style="font-size:18px;font-weight:700;margin-top:4px;">${escapeHtml(camp.curriculum_name ?? 'Camp')}</div>
    </div>
    <div style="padding:22px 24px;">
      <p style="margin:0 0 12px;font-size:14px;">${greeting}</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.5;">
        Please find attached the roster for <strong>${escapeHtml(camp.curriculum_name ?? '')}</strong>${where ? ` at <strong>${escapeHtml(where)}</strong>` : ''}, running <strong>${escapeHtml(dateRange)}</strong>${timeRange ? ` (${escapeHtml(timeRange)})` : ''}.
      </p>
      <p style="margin:0 0 14px;font-size:14px;">Camper count: <strong>${camperCount}</strong></p>
      <div style="margin:14px 0;padding:12px 14px;background:#FBFBFB;border:1px solid ${BORDER};border-radius:6px;">
        ${instructorBlock}
      </div>
      ${message ? `<div style="margin:14px 0;padding:12px 14px;background:#FBFBFB;border-left:3px solid ${primaryColor};border-radius:4px;font-size:13px;line-height:1.5;color:#1a1a1a;white-space:pre-wrap;">${escapeHtml(message)}</div>` : ''}
      <p style="margin:18px 0 0;font-size:13px;color:${MUTED};line-height:1.5;">
        If anything looks off — names missing, dates wrong — just reply and we'll sort it.
      </p>
      ${signatureHtml || `<p style="margin:14px 0 0;font-size:13px;color:${INK};">— ${escapeHtml(orgName)}</p>`}
    </div>
  </div>
</body></html>`;
}

function renderEmailText(params: {
  orgName: string;
  camp: any;
  location: any;
  partner: any;
  instructors: Array<{ name: string; phone: string; email: string; role: string }>;
  camperCount: number;
  message: string;
}): string {
  const { orgName, camp, location, partner, instructors, camperCount, message } = params;
  const where = location?.name || camp.location_name || '';
  const greeting = partner?.partner_name ? `Hello ${partner.partner_name} team,` : 'Hello,';
  const dateRange = fmtDateRange(camp.starts_on, camp.ends_on);
  const timeRange = (camp.start_time && camp.end_time) ? `${fmtTime(camp.start_time)}–${fmtTime(camp.end_time)}` : '';
  const instructorLines = instructors.length === 0
    ? 'Instructor: not yet assigned'
    : instructors.map((i) => `${i.role === 'lead' ? 'Instructor' : (i.role || 'Instructor')}: ${i.name || '—'}${i.phone ? ` · ${i.phone}` : ''}${i.email ? ` · ${i.email}` : ''}`).join('\n');
  return [
    greeting,
    '',
    `Please find attached the roster for ${camp.curriculum_name ?? ''}${where ? ` at ${where}` : ''}, running ${dateRange}${timeRange ? ` (${timeRange})` : ''}.`,
    '',
    `Camper count: ${camperCount}`,
    '',
    instructorLines,
    '',
    message ? `Note: ${message}` : '',
    '',
    `If anything looks off, just reply and we'll sort it.`,
    '',
    `— ${orgName}`,
  ].filter((l) => l !== undefined).join('\n');
}

function escapeHtml(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
