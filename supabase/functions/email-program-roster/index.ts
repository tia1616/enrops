// email-program-roster: sends a branded PDF roster for an AFTERSCHOOL PROGRAM to
// the partner organisation's logistics contacts. Mirror of email-camp-roster,
// but reads from `programs` + native registrations (program_id) instead of camps.
//
// Input:
//   {
//     program_id: string,                // required
//     recipient_contact_ids?: string[],  // partner_contacts.id rows to include
//     include_location_contact?: boolean,// also email program_locations.contact_email if set
//     cc?: string[],                     // ad-hoc CC emails
//     message?: string,                  // optional operator note
//     mode?: 'preview' | 'send'
//   }
//
// Multi-tenant: caller must be owner/admin of the org that owns the program.
// "Enrolled" matches ProgramsCalendar / the roster view exactly: un-cancelled
// registrations where payment_status='paid' OR status='confirmed'.

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

const DAY_LABELS: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const programId: string | undefined = body.program_id;
    const recipientContactIds: string[] = Array.isArray(body.recipient_contact_ids) ? body.recipient_contact_ids : [];
    const includeLocationContact: boolean = !!body.include_location_contact;
    const ccRaw: string[] = Array.isArray(body.cc) ? body.cc : [];
    const message: string = typeof body.message === 'string' ? body.message.trim() : '';
    const mode: 'preview' | 'send' = body.mode === 'send' ? 'send' : 'preview';

    if (!programId) return json({ error: 'program_id is required' }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const isSystemAuth = token === SUPABASE_SERVICE_ROLE_KEY;
    let callerUserId: string | null = null;

    if (!isSystemAuth) {
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);
      callerUserId = userData.user.id;
    }

    // ── Load program + location + partner ──────────────────────────────────
    const { data: program, error: progErr } = await supabase
      .from('programs')
      .select(`
        id, organization_id, program_location_id,
        curriculum, term, day_of_week, start_time, end_time, room,
        first_session_date, session_count, instructor_name, max_capacity
      `)
      .eq('id', programId)
      .maybeSingle();
    if (progErr || !program) return json({ error: 'program not found' }, 404);

    if (!isSystemAuth) {
      const { data: memberRow } = await supabase
        .from('org_members')
        .select('role')
        .eq('auth_user_id', callerUserId!)
        .eq('organization_id', program.organization_id)
        .maybeSingle();
      if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
        return json({ error: 'forbidden' }, 403);
      }
    }

    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, slug, sending_domain, default_sender_email, default_sender_name, logo_email_url, logo_url')
      .eq('id', program.organization_id)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);

    const { data: branding } = await supabase
      .from('org_branding')
      .select('primary_color, logo_url, email_from_name, email_reply_to')
      .eq('organization_id', program.organization_id)
      .maybeSingle();
    const primaryColor = branding?.primary_color ?? DEFAULT_PRIMARY;
    const fromName = branding?.email_from_name ?? org.default_sender_name ?? org.name;
    const replyTo = branding?.email_reply_to ?? null;

    const brand = await loadOrgBrand(supabase, program.organization_id);

    let location: any = null;
    let partner: any = null;
    if (program.program_location_id) {
      const { data: locRow } = await supabase
        .from('program_locations')
        .select('id, name, district, address, room_number, contact_name, contact_email, contact_phone, partner_id, organization_id')
        .eq('id', program.program_location_id)
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
    type Recipient = { name: string; email: string; role: string | null; source: 'partner_contact' | 'location_contact' | 'ad_hoc_cc'; partner_contact_id?: string | null };
    const recipients: Recipient[] = [];
    const seen = new Set<string>();

    if (recipientContactIds.length > 0) {
      const { data: contacts } = await supabase
        .from('partner_contacts')
        .select('id, contact_name, contact_email, contact_role, partner_id, organization_id')
        .in('id', recipientContactIds)
        .eq('organization_id', program.organization_id);
      for (const c of contacts ?? []) {
        const email = (c.contact_email ?? '').trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        // partner_contact_id keys this recipient back to the partner_contacts row
        // so the Comms per-contact timeline can find every roster send to them.
        recipients.push({ name: c.contact_name ?? '', email, role: c.contact_role ?? null, source: 'partner_contact', partner_contact_id: c.id });
      }
    }

    if (includeLocationContact && location?.contact_email) {
      const email = location.contact_email.trim().toLowerCase();
      if (email && !seen.has(email)) {
        seen.add(email);
        recipients.push({ name: location.contact_name ?? location.name ?? '', email, role: 'location_contact', source: 'location_contact' });
      }
    }

    for (const raw of ccRaw) {
      const email = (raw ?? '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      seen.add(email);
      recipients.push({ name: '', email, role: null, source: 'ad_hoc_cc' });
    }

    if (recipients.length === 0 && mode === 'send') {
      return json({ error: 'no valid recipients selected' }, 400);
    }

    // ── Load ENROLLED registrations (matches the roster view) ──────────────
    const { data: regs, error: regErr } = await supabase
      .from('registrations')
      .select(`
        id, status, payment_status, authorized_pickup_contacts, registered_at,
        student:students ( id, first_name, last_name, grade, birthdate, pronouns,
                           allergies, epipen_required,
                           emergency_contact_name, emergency_contact_phone ),
        parent:parents ( id, first_name, last_name, email, phone )
      `)
      .eq('program_id', program.id)
      .is('cancelled_at', null)
      .order('registered_at', { ascending: true });
    if (regErr) return json({ error: `roster query: ${regErr.message}` }, 500);
    const students = (regs ?? [])
      .filter((r: any) => r.student && (r.payment_status === 'paid' || r.status === 'confirmed'))
      .sort((a: any, b: any) => {
        const an = `${a.student?.last_name ?? ''} ${a.student?.first_name ?? ''}`.toLowerCase();
        const bn = `${b.student?.last_name ?? ''} ${b.student?.first_name ?? ''}`.toLowerCase();
        return an.localeCompare(bn);
      });

    // Instructor(s): mirror the camp pattern (camp_assignments) — afterschool
    // scheduling writes program_assignments. Fall back to the denormalized
    // program.instructor_name text only if no assignment row exists yet.
    // (program_assignments status enum: proposed/confirmed/change_requested/
    //  published/withdrawn/declined — "on it" = confirmed or published.)
    const { data: pasgs } = await supabase
      .from('program_assignments')
      .select('role, status, instructor:instructors ( first_name, last_name, email, phone )')
      .eq('program_id', program.id)
      .in('status', ['confirmed', 'published'])
      .order('role', { ascending: true });
    let instructors = (pasgs ?? [])
      .filter((a: any) => a.instructor)
      .map((a: any) => ({
        name: `${a.instructor.first_name ?? ''} ${a.instructor.last_name ?? ''}`.trim(),
        phone: a.instructor.phone ?? '',
        email: a.instructor.email ?? '',
        role: a.role,
      }));
    if (instructors.length === 0 && program.instructor_name) {
      instructors = [{ name: program.instructor_name, phone: '', email: '', role: 'lead' }];
    }

    if (mode === 'preview') {
      return json({
        recipients,
        camper_count: students.length, // keep field name for modal compat
        instructor_count: instructors.length,
        instructors,
        partner: partner ? { id: partner.id, name: partner.partner_name } : null,
        location: location ? { id: location.id, name: location.name, has_contact_email: !!location.contact_email } : null,
      });
    }

    // ── Build the PDF ──────────────────────────────────────────────────────
    const pdfBytes = await buildRosterPdf({
      orgName: org.name, primaryColor,
      // Canonical logo: email-safe PNG first, then source, then legacy field.
      logoUrl: org.logo_email_url ?? org.logo_url ?? branding?.logo_url ?? null,
      program, location, partner, instructors, students,
    });
    const pdfBase64 = bytesToBase64(pdfBytes);
    const pdfFilename = makePdfFilename({ name: program.curriculum, locationName: location?.name ?? '', term: program.term });

    // ── Compose email ──────────────────────────────────────────────────────
    // Sender is tenant-driven — never hardcode one tenant's domain. Prefer the
    // org's configured sender email; else hello@ on its verified sending domain.
    // A tenant with neither gets a clear error instead of sending from (and
    // misbranding as) another tenant's domain.
    const senderEmail = org.default_sender_email
      || (org.sending_domain ? `hello@${org.sending_domain}` : null);
    if (!senderEmail) {
      return json({ error: 'no_sender_configured', detail: 'Add a sending email or verified domain in Settings before emailing rosters.' }, 400);
    }
    const fromEmail = `${encodeDisplayName(fromName)} <${senderEmail}>`;
    const subjectWhere = partner?.partner_name ?? location?.name ?? '';
    const subject = `Roster: ${program.curriculum} — ${scheduleLabel(program)}${subjectWhere ? ` @ ${subjectWhere}` : ''}`;

    const html = renderEmailHtml({ orgName: org.name, primaryColor, program, location, partner, instructors, count: students.length, message, signatureHtml: renderSignatureBlock(brand) });
    const text = renderEmailText({ orgName: org.name, program, location, partner, instructors, count: students.length, message });

    // One email per recipient — partners never see each other.
    const sent: Array<{ email: string; message_id: string | null }> = [];
    const failed: Array<{ email: string; reason: string }> = [];
    for (const r of recipients) {
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: fromEmail, to: r.email, reply_to: replyTo ?? undefined,
            subject, html, text,
            attachments: [{ filename: pdfFilename, content: pdfBase64 }],
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

    const status = sent.length > 0 ? 'sent' : 'failed';
    const failureReason = failed.length === 0 ? null : failed.map((f) => `${f.email}: ${f.reason}`).join('; ');
    await supabase.from('roster_email_sends').insert({
      organization_id: program.organization_id,
      program_id: program.id,
      partner_id: partner?.id ?? null,
      sent_by_user_id: callerUserId,
      recipients,
      message: message || null,
      resend_message_id: sent.length > 0 ? sent[0].message_id : null,
      status,
      failure_reason: failureReason,
      roster_camper_count: students.length,
    });

    return json({
      sent: sent.length, failed, camper_count: students.length,
      partner: partner ? { id: partner.id, name: partner.partner_name } : null,
    });
  } catch (err) {
    console.error('[email-program-roster] unexpected', err);
    return json({ error: (err as Error).message ?? 'unexpected error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 0.11, g: 0, b: 0.31 };
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTime(t: string | null | undefined): string {
  if (!t) return '';
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, '');
  const [hh, mm] = t.split(':');
  const h = parseInt(hh, 10);
  if (Number.isNaN(h)) return t as string;
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${mm}${period}`;
}
function dayPlural(d: string | null | undefined): string {
  if (!d) return '';
  const l = DAY_LABELS[d.toLowerCase()];
  return l ? `${l}s` : '';
}
function scheduleLabel(program: any): string {
  const parts: string[] = [];
  if (program.day_of_week) parts.push(dayPlural(program.day_of_week));
  if (program.first_session_date) parts.push(`from ${fmtDate(program.first_session_date)}`);
  return parts.filter(Boolean).join(' ');
}
function makePdfFilename(p: { name: string; locationName: string; term: string }): string {
  const safe = (s: string) => (s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `Roster-${safe(p.name)}-${safe(p.locationName)}-${p.term || ''}.pdf`.slice(0, 120);
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function truncate(s: string, widthPts: number, font: any, size: number): string {
  if (!s) return '';
  const limit = widthPts - 8;
  if (font.widthOfTextAtSize(s, size) <= limit) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (font.widthOfTextAtSize(s.slice(0, mid) + '…', size) <= limit) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}
function escapeHtml(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function buildRosterPdf(params: {
  orgName: string; primaryColor: string; logoUrl: string | null;
  program: any; location: any; partner: any;
  instructors: Array<{ name: string; phone: string; email: string; role: string }>;
  students: any[];
}): Promise<Uint8Array> {
  const { orgName, primaryColor, logoUrl, program, location, partner, instructors, students } = params;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const primary = hexToRgb(primaryColor);
  const ink = hexToRgb(INK);
  const muted = hexToRgb(MUTED);
  const border = hexToRgb(BORDER);

  const PAGE_W = 792, PAGE_H = 612, MARGIN_X = 40, HEADER_H = 72, FOOTER_H = 24;

  let logoImage: any = null;
  let logoDims: { width: number; height: number } | null = null;
  if (logoUrl) {
    try {
      const r = await fetch(logoUrl);
      if (r.ok) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('png') || logoUrl.toLowerCase().endsWith('.png')) logoImage = await doc.embedPng(bytes);
        else if (ct.includes('jpeg') || ct.includes('jpg') || /\.jpe?g$/i.test(logoUrl)) logoImage = await doc.embedJpg(bytes);
        if (logoImage) { const targetH = 36; const scale = targetH / logoImage.height; logoDims = { width: logoImage.width * scale, height: targetH }; }
      }
    } catch (_e) { /* text-only header */ }
  }

  const COLS = [
    { key: 'name', label: 'Student', width: 120 },
    { key: 'grade', label: 'Grade', width: 40 },
    { key: 'allergy', label: 'Allergy / EpiPen', width: 110 },
    { key: 'parent', label: 'Parent', width: 100 },
    { key: 'parent_phone', label: 'Parent phone', width: 88 },
    { key: 'parent_email', label: 'Parent email', width: 122 },
    { key: 'ec', label: 'Emergency contact', width: 112 },
  ];
  const TABLE_W = COLS.reduce((s, c) => s + c.width, 0);
  const ROW_H = 26;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  const pages: any[] = [page];

  function drawHeader(p: any): number {
    p.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: rgb(primary.r, primary.g, primary.b) });
    if (logoImage && logoDims) p.drawImage(logoImage, { x: MARGIN_X, y: PAGE_H - HEADER_H + (HEADER_H - logoDims.height) / 2, width: logoDims.width, height: logoDims.height });
    else p.drawText(orgName, { x: MARGIN_X, y: PAGE_H - HEADER_H + 40, size: 16, font: bold, color: rgb(1, 1, 1) });
    p.drawText('Afterschool roster', { x: MARGIN_X, y: PAGE_H - HEADER_H + 18, size: 11, font, color: rgb(1, 1, 1) });

    let y = PAGE_H - HEADER_H - 22;
    p.drawText(program.curriculum ?? 'Program', { x: MARGIN_X, y, size: 16, font: bold, color: rgb(ink.r, ink.g, ink.b) });
    y -= 18;
    const subParts: string[] = [];
    if (program.day_of_week) subParts.push(dayPlural(program.day_of_week));
    if (program.start_time && program.end_time) subParts.push(`${fmtTime(program.start_time)}–${fmtTime(program.end_time)}`);
    if (program.first_session_date) subParts.push(`from ${fmtDate(program.first_session_date)}`);
    if (program.session_count) subParts.push(`${program.session_count} sessions`);
    if (program.term) subParts.push(program.term);
    p.drawText(subParts.filter(Boolean).join('  ·  '), { x: MARGIN_X, y, size: 10, font, color: rgb(muted.r, muted.g, muted.b) });
    y -= 18;

    const leftLines: string[] = [];
    if (partner?.partner_name) leftLines.push(`Partner: ${partner.partner_name}`);
    if (location?.name) leftLines.push(`Location: ${location.name}${program.room ? ` (Room ${program.room})` : (location.room_number ? ` (Room ${location.room_number})` : '')}`);
    if (location?.address) leftLines.push(location.address);

    const rightLines: string[] = [];
    if (instructors.length === 0) rightLines.push('Instructor: not yet assigned');
    else for (const inst of instructors) rightLines.push(`Instructor: ${inst.name || '—'}`);

    const blockTop = y;
    let yLeft = blockTop;
    for (const line of leftLines) { p.drawText(line, { x: MARGIN_X, y: yLeft, size: 10, font, color: rgb(ink.r, ink.g, ink.b) }); yLeft -= 13; }
    let yRight = blockTop;
    for (const line of rightLines) { p.drawText(line, { x: MARGIN_X + 280, y: yRight, size: 10, font, color: rgb(ink.r, ink.g, ink.b) }); yRight -= 13; }
    let yCount = Math.min(yLeft, yRight) - 4;
    p.drawText(`${students.length} student${students.length === 1 ? '' : 's'} on this roster`, { x: MARGIN_X, y: yCount, size: 10, font: bold, color: rgb(primary.r, primary.g, primary.b) });
    yCount -= 14;

    let xc = MARGIN_X;
    const headerY = yCount - 12;
    p.drawRectangle({ x: MARGIN_X, y: headerY - 6, width: TABLE_W, height: 20, color: rgb(0.96, 0.96, 0.94) });
    for (const col of COLS) { p.drawText(col.label, { x: xc + 4, y: headerY, size: 9, font: bold, color: rgb(muted.r, muted.g, muted.b) }); xc += col.width; }
    return headerY - 6;
  }

  function drawContinuationHeader(p: any): number {
    p.drawRectangle({ x: 0, y: PAGE_H - 36, width: PAGE_W, height: 36, color: rgb(primary.r, primary.g, primary.b) });
    p.drawText(orgName, { x: MARGIN_X, y: PAGE_H - 24, size: 11, font: bold, color: rgb(1, 1, 1) });
    p.drawText(`${program.curriculum ?? 'Roster'} — continued`, { x: PAGE_W - MARGIN_X - 200, y: PAGE_H - 24, size: 10, font, color: rgb(1, 1, 1) });
    const headerY = PAGE_H - 60;
    let xc = MARGIN_X;
    p.drawRectangle({ x: MARGIN_X, y: headerY - 6, width: TABLE_W, height: 20, color: rgb(0.96, 0.96, 0.94) });
    for (const col of COLS) { p.drawText(col.label, { x: xc + 4, y: headerY, size: 9, font: bold, color: rgb(muted.r, muted.g, muted.b) }); xc += col.width; }
    return headerY - 6;
  }

  let y = drawHeader(page);
  if (students.length === 0) {
    page.drawText('No students are currently enrolled in this program.', { x: MARGIN_X, y: y - 18, size: 11, font, color: rgb(muted.r, muted.g, muted.b) });
  } else {
    for (const reg of students) {
      if (y - ROW_H < FOOTER_H + 16) { page = doc.addPage([PAGE_W, PAGE_H]); pages.push(page); y = drawContinuationHeader(page); }
      const s = reg.student ?? {};
      const p2 = reg.parent ?? {};
      const name = `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || 'Unnamed';
      const grade = s.grade == null ? '' : (s.grade === 0 ? 'K' : String(s.grade));
      const allergyBits: string[] = [];
      if ((s.allergies ?? '').trim()) allergyBits.push(s.allergies);
      if (s.epipen_required) allergyBits.push('EpiPen');
      const allergy = allergyBits.join(' · ') || '—';
      const parentName = `${p2.first_name ?? ''} ${p2.last_name ?? ''}`.trim() || '—';
      const ec = s.emergency_contact_name ? `${s.emergency_contact_name}${s.emergency_contact_phone ? ` · ${s.emergency_contact_phone}` : ''}` : '—';

      page.drawLine({ start: { x: MARGIN_X, y: y - 0.5 }, end: { x: MARGIN_X + TABLE_W, y: y - 0.5 }, thickness: 0.5, color: rgb(border.r, border.g, border.b) });
      const values: Record<string, string> = { name, grade, allergy, parent: parentName, parent_phone: p2.phone ?? '', parent_email: p2.email ?? '', ec };
      let xc = MARGIN_X;
      for (const col of COLS) {
        const isAllergy = col.key === 'allergy' && allergy !== '—';
        page.drawText(truncate(values[col.key] ?? '', col.width, font, 9), { x: xc + 4, y: y - 13, size: 9, font: isAllergy ? bold : font, color: isAllergy ? rgb(0.71, 0.22, 0.22) : rgb(ink.r, ink.g, ink.b) });
        xc += col.width;
      }
      y -= ROW_H;
    }
  }
  for (let i = 0; i < pages.length; i++) {
    pages[i].drawText(`${orgName}  ·  Generated ${new Date().toLocaleDateString('en-US')}  ·  Page ${i + 1} of ${pages.length}`, { x: MARGIN_X, y: FOOTER_H, size: 8, font, color: rgb(muted.r, muted.g, muted.b) });
  }
  return await doc.save();
}

function renderEmailHtml(params: { orgName: string; primaryColor: string; program: any; location: any; partner: any; instructors: any[]; count: number; message: string; signatureHtml: string }): string {
  const { orgName, primaryColor, program, location, partner, instructors, count, message, signatureHtml } = params;
  const greeting = partner?.partner_name ? `Hello ${escapeHtml(partner.partner_name)} team,` : 'Hello,';
  const where = location?.name || '';
  const sched = escapeHtml(scheduleLabel(program));
  const timeRange = (program.start_time && program.end_time) ? `${fmtTime(program.start_time)}–${fmtTime(program.end_time)}` : '';
  const instructorBlock = instructors.length === 0
    ? '<p style="margin:8px 0;font-size:13px;color:#6b6b6b;"><em>Instructor not yet assigned — we\'ll follow up once confirmed.</em></p>'
    : instructors.map((i: any) => `<p style="margin:4px 0;font-size:13px;color:#1a1a1a;"><strong>Instructor:</strong> ${escapeHtml(i.name || '—')}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8" /></head>
<body style="margin:0;padding:24px;background:#f5f4ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;">
    <div style="background:${primaryColor};color:#fff;padding:18px 24px;">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Afterschool roster</div>
      <div style="font-size:18px;font-weight:700;margin-top:4px;">${escapeHtml(program.curriculum ?? 'Program')}</div>
    </div>
    <div style="padding:22px 24px;">
      <p style="margin:0 0 12px;font-size:14px;">${greeting}</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.5;">Please find attached the roster for <strong>${escapeHtml(program.curriculum ?? '')}</strong>${where ? ` at <strong>${escapeHtml(where)}</strong>` : ''}, ${sched}${timeRange ? ` (${escapeHtml(timeRange)})` : ''}.</p>
      <p style="margin:0 0 14px;font-size:14px;">Enrolled: <strong>${count}</strong></p>
      <div style="margin:14px 0;padding:12px 14px;background:#FBFBFB;border:1px solid ${BORDER};border-radius:6px;">${instructorBlock}</div>
      ${message ? `<div style="margin:14px 0;padding:12px 14px;background:#FBFBFB;border-left:3px solid ${primaryColor};border-radius:4px;font-size:13px;line-height:1.5;color:#1a1a1a;white-space:pre-wrap;">${escapeHtml(message)}</div>` : ''}
      <p style="margin:18px 0 0;font-size:13px;color:${MUTED};line-height:1.5;">If anything looks off — names missing, dates wrong — just reply and we'll sort it.</p>
      ${signatureHtml || `<p style="margin:14px 0 0;font-size:13px;color:${INK};">— ${escapeHtml(orgName)}</p>`}
    </div>
  </div>
</body></html>`;
}

function renderEmailText(params: { orgName: string; program: any; location: any; partner: any; instructors: any[]; count: number; message: string }): string {
  const { orgName, program, location, partner, instructors, count, message } = params;
  const where = location?.name || '';
  const greeting = partner?.partner_name ? `Hello ${partner.partner_name} team,` : 'Hello,';
  const timeRange = (program.start_time && program.end_time) ? `${fmtTime(program.start_time)}–${fmtTime(program.end_time)}` : '';
  const instructorLines = instructors.length === 0 ? 'Instructor: not yet assigned' : instructors.map((i: any) => `Instructor: ${i.name || '—'}`).join('\n');
  return [
    greeting, '',
    `Please find attached the roster for ${program.curriculum ?? ''}${where ? ` at ${where}` : ''}, ${scheduleLabel(program)}${timeRange ? ` (${timeRange})` : ''}.`, '',
    `Enrolled: ${count}`, '', instructorLines, '',
    message ? `Note: ${message}` : '', '',
    `If anything looks off, just reply and we'll sort it.`, '', `— ${orgName}`,
  ].filter((l) => l !== undefined).join('\n');
}
