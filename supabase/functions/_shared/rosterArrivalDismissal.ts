// Arrival and dismissal on the rosters we email to schools and partners.
//
// Jessica, 2026-10-22: "i need arrival/dismissal info on all the rosters we send
// to schools and partners." She chose BOTH: a per-child Dismissal column, and the
// site's arrival and dismissal instructions above the table. Imported by
// email-program-roster (classes, and camps built as programs) and
// email-camp-roster (legacy camp_sessions), so the two PDFs cannot disagree.
//
// THE PARENT-FACING SITE TEXT, NEVER THE INSTRUCTOR ONE. program_locations holds
// two pairs: arrival_/dismissal_instructions are written FOR INSTRUCTORS and carry
// things like a building badge code (Happy Valley Library's does, verified on
// prod 2026-10-22), while parent_arrival_/parent_dismissal_instructions are
// written to be read by families. A school or PTA inbox is a family-grade
// audience, so only the parent pair may be printed.
//
// THE CHILD'S METHOD, NEVER THE PEOPLE. The column says how a child leaves
// (aftercare and which one, released to an authorized adult, walks or bikes
// home). Who is authorized to collect them stays off: those are adults' names
// and the partner roster has never carried them (FORBIDDEN_ROSTER_KEYS).

// ── Deno twin of src/lib/dismissal.js ─────────────────────────────────────
// Same vocabulary, same labels, same summary. Guarded by
// _shared/tests/dismissalTwinParity.test.ts, which executes both copies.
// If they disagree, the PDF a school holds names a child's dismissal
// differently from the instructor's screen.
const CHOICES: ReadonlyArray<{ value: string; short: string }> = [
  { value: 'released_to_authorized_adult', short: 'Released to an authorized adult' },
  { value: 'walks_or_bikes_home', short: 'Walks or bikes home' },
  { value: 'bus', short: 'Bus' },
  { value: 'aftercare', short: 'Aftercare' },
  { value: 'other', short: 'Other' },
];

export function dismissalLabel(value: unknown): string | null {
  if (!value) return null;
  const found = CHOICES.find((c) => c.value === value);
  return found ? found.short : String(value);
}

export function needsAftercareProvider(value: unknown): boolean {
  return value === 'aftercare';
}

export function dismissalSummary(
  { dismissal_method, aftercare_provider }: { dismissal_method?: unknown; aftercare_provider?: unknown } = {},
): string | null {
  const label = dismissalLabel(dismissal_method);
  if (!label) return null;
  if (!needsAftercareProvider(dismissal_method)) return label;
  const who = String(aftercare_provider ?? '').trim();
  return who ? `${label}: ${who}` : `${label} (provider not stated)`;
}

/** The roster cell. A blank answer is printed, never left empty: on a dismissal
 *  list an empty cell reads as "nothing to worry about". */
export function dismissalCell(student: { dismissal_method?: unknown; aftercare_provider?: unknown } | null | undefined): string {
  return dismissalSummary(student ?? {}) ?? 'Not stated';
}

// ── Does this business ask the dismissal question? ─────────────────────────
// The same rule the instructor portal uses (an active custom_reg_fields row with
// standard_key 'dismissal_method'), read through the same RPC. A business that
// never asks would otherwise get a whole column of "Not stated".
//
// enrollment_type rows come back UNRESOLVED from the RPC (applies_to_value is
// 'afterschool' or 'camp'), so they are matched to the roster's kind here.
//
// FAILS TOWARD SHOWING THE COLUMN. If the read errors, printing "Not stated"
// for a business that does not ask is a cosmetic cost; hiding real dismissal
// answers from a school is the one this change exists to stop.
export async function orgAsksDismissal(
  supabase: any,
  orgId: string,
  opts: { programId?: string | null; kind: 'afterschool' | 'camp' },
): Promise<boolean> {
  const { data, error } = await supabase.rpc('get_active_registration_fields', {
    p_org_id: orgId,
    p_program_id: opts.programId ?? null,
  });
  if (error) {
    console.error('[roster] could not read registration questions; showing dismissal column:', error.message);
    return true;
  }
  return (data ?? []).some((f: any) =>
    f?.standard_key === 'dismissal_method' &&
    f?.is_active !== false &&
    (f?.applies_to !== 'enrollment_type' || f?.applies_to_value === opts.kind)
  );
}

// ── The site's instructions, as the roster prints them ─────────────────────
export function siteInstructionLines(
  location: { parent_arrival_instructions?: unknown; parent_dismissal_instructions?: unknown } | null | undefined,
): Array<{ label: 'Arrival' | 'Dismissal'; text: string }> {
  const out: Array<{ label: 'Arrival' | 'Dismissal'; text: string }> = [];
  const arrival = String(location?.parent_arrival_instructions ?? '').trim();
  const dismissal = String(location?.parent_dismissal_instructions ?? '').trim();
  if (arrival) out.push({ label: 'Arrival', text: arrival });
  if (dismissal) out.push({ label: 'Dismissal', text: dismissal });
  return out;
}

// ── PDF text safety ────────────────────────────────────────────────────────
// pdf-lib's standard fonts encode WinAnsi only, and drawText THROWS on anything
// else (an emoji, an arrow), which would fail the whole roster send. These
// fields are free text typed by operators and families, so every character the
// font cannot encode is dropped rather than trusted. Line breaks and tabs become
// spaces here; wrapPdfText decides where lines break.
export function pdfSafe(text: string, font: any): string {
  let out = '';
  for (const ch of String(text ?? '').replace(/[\r\n\t]+/g, ' ')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      // not drawable in this font: leave it out
    }
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** Word-wrap to a width, capped at maxLines with an ellipsis on the last. */
export function wrapPdfText(text: string, font: any, size: number, width: number, maxLines: number): string[] {
  const words = text.split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    // A single word wider than the line (a long URL) is cut, not overflowed.
    while (font.widthOfTextAtSize(cur, size) > width && cur.length > 1) {
      let cut = cur.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(cur.slice(0, cut), size) > width) cut--;
      lines.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && font.widthOfTextAtSize(`${last}…`, size) > width) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/**
 * Draw the Arrival / Dismissal block at y, returning the y below it. Nothing is
 * drawn (and y is returned unchanged) when the site has neither instruction.
 */
export function drawSiteInstructions(
  page: any,
  opts: { location: any; x: number; y: number; width: number; font: any; bold: any; color: any; size?: number },
): number {
  const size = opts.size ?? 9.5;
  const lineH = size + 3.5;
  let y = opts.y;
  for (const { label, text } of siteInstructionLines(opts.location)) {
    const lead = `${label}: `;
    const leadW = opts.bold.widthOfTextAtSize(lead, size);
    const lines = wrapPdfText(pdfSafe(text, opts.font), opts.font, size, opts.width - leadW, 4);
    if (lines.length === 0) continue;
    page.drawText(lead, { x: opts.x, y, size, font: opts.bold, color: opts.color });
    for (const line of lines) {
      page.drawText(line, { x: opts.x + leadW, y, size, font: opts.font, color: opts.color });
      y -= lineH;
    }
    y -= 2;
  }
  return y;
}
