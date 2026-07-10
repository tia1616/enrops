// attachments — shared comms-attachment resolver.
//
// One chokepoint for BOTH send paths (lifecycle-automations-cron +
// marketing-touchpoint-send) so attachment logic is never forked (mirrors the
// orgBrand.ts "one shared branding loader" pattern).
//
// Two independent things an email can do with a library file:
//   1. LINK  — operator drops a {{attachment:<id>}} marker in the body; it
//              renders to a branded "Download" button pointing at the file's
//              PUBLIC url (comms-attachments is a public bucket; the random uuid
//              in the path makes it unguessable, matching Mailchimp/HubSpot).
//              This is the default, and the only P0 mode surfaced in the UI.
//   2. ATTACH — the raw file rides in the Resend `attachments` array (base64).
//              Opt-in per file via a row's attachment_ids[]. Kept for the P1
//              per-recipient (invoice) case; size-capped for deliverability.
//
// Tenant safety: every load is filtered by organization_id, so a body that
// references another org's attachment id resolves to nothing (dropped), never
// leaks. Archived files (archived_at) are excluded.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import type { OrgBrand } from './orgBrand.ts';

const BUCKET = 'comms-attachments';

// Deliverability safety cap for TRUE attachments (base64 in the email itself).
// Gmail/Outlook reject ~25MB; keep the raw total well under that. Files over the
// cap are skipped from the attachments array (the download LINK still works).
const MAX_ATTACH_TOTAL_BYTES = 15 * 1024 * 1024; // 15 MB

// {{attachment:<uuid>}} — tolerant of surrounding whitespace, case-insensitive.
const ATTACHMENT_TOKEN_RE =
  /\{\{\s*attachment:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*\}\}/g;

export interface CommsAttachment {
  id: string;
  organization_id: string;
  file_name: string;
  storage_path: string;
  byte_size: number;
  content_type: string;
  title: string | null;
}

/** All distinct attachment ids referenced by {{attachment:<id>}} markers across the given texts. */
export function extractAttachmentIds(...texts: (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(ATTACHMENT_TOKEN_RE)) ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

/**
 * Load attachment rows for this org, keyed by id. ALWAYS scoped to orgId so a
 * body can never pull a file from another tenant. Missing/archived ids simply
 * won't appear in the map (callers treat absence as "drop the marker").
 */
export async function loadCommsAttachments(
  supabase: SupabaseClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, CommsAttachment>> {
  const map = new Map<string, CommsAttachment>();
  const unique = [...new Set(ids.filter(Boolean).map((s) => s.toLowerCase()))];
  if (!unique.length) return map;
  const { data, error } = await supabase
    .from('comms_attachments')
    .select('id, organization_id, file_name, storage_path, byte_size, content_type, title')
    .eq('organization_id', orgId)
    .is('archived_at', null)
    .in('id', unique);
  if (error) throw new Error(`loadCommsAttachments: ${error.message}`);
  for (const row of (data ?? []) as CommsAttachment[]) map.set(row.id.toLowerCase(), row);
  return map;
}

/** Permanent public URL for a file in the comms-attachments bucket. */
export function publicUrlFor(supabase: SupabaseClient, storagePath: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A branded Download button for one attachment, as a single INLINE-BLOCK <a>.
 * Deliberately not a <table> button: the operator drops the {{attachment:<id>}}
 * marker anywhere in the body, and the editor wraps a bare-line token in <p>…</p>
 * (block-token isolation only applies to a fixed name set, not attachment ids).
 * A <table> nested in <p> is invalid HTML and breaks spacing; an inline-block
 * <a> is valid inside <p> or between paragraphs and renders as a colored button
 * in every major client (Outlook desktop drops the radius/padding but still shows
 * a clickable colored link — acceptable).
 */
function downloadButtonHtml(att: CommsAttachment, url: string, brand: OrgBrand): string {
  const bg = escapeHtml(brand.primary_color || '#1C004F');
  const label = escapeHtml((att.title?.trim() || att.file_name));
  return (
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" ` +
    `style="display:inline-block;margin:8px 0;padding:12px 22px;background:${bg};` +
    `font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;` +
    `color:#ffffff;text-decoration:none;border-radius:8px;">` +
    `&#11015;&nbsp;Download ${label}</a>`
  );
}

/**
 * Replace every {{attachment:<id>}} marker in `content` with the Download button
 * (html mode) or a "Download name: url" line (plaintext mode). Unknown/archived
 * ids (incl. any pointing at another org) are dropped to empty string.
 */
export function expandAttachmentTokens(
  content: string,
  byId: Map<string, CommsAttachment>,
  supabase: SupabaseClient,
  brand: OrgBrand,
  opts: { html: boolean },
): string {
  if (!content) return content;
  return content.replace(ATTACHMENT_TOKEN_RE, (_full, rawId: string) => {
    const att = byId.get(String(rawId).toLowerCase());
    if (!att) return '';
    const url = publicUrlFor(supabase, att.storage_path);
    if (opts.html) return downloadButtonHtml(att, url, brand);
    const label = att.title?.trim() || att.file_name;
    return `Download ${label}: ${url}`;
  });
}

/** Chunked base64 of raw bytes (btoa on a huge binary string can blow the stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Build the Resend `attachments` array (base64) for the TRUE-attach files.
 * Downloads each file's bytes from storage. Files that push the running total
 * over MAX_ATTACH_TOTAL_BYTES, or fail to download, are skipped (reported) — the
 * email still sends, and any download LINK for that file is unaffected.
 */
export async function buildResendAttachments(
  supabase: SupabaseClient,
  atts: CommsAttachment[],
): Promise<{ attachments: { filename: string; content: string }[]; skipped: string[] }> {
  const attachments: { filename: string; content: string }[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const a of atts) {
    const { data, error } = await supabase.storage.from(BUCKET).download(a.storage_path);
    if (error || !data) {
      skipped.push(a.file_name);
      continue;
    }
    const buf = new Uint8Array(await data.arrayBuffer());
    // Gate on the ACTUAL bytes, not the client-declared byte_size (which could be
    // understated), so the deliverability cap is a real guarantee.
    if (total + buf.byteLength > MAX_ATTACH_TOTAL_BYTES) {
      skipped.push(a.file_name);
      continue;
    }
    total += buf.byteLength;
    attachments.push({ filename: a.file_name, content: bytesToBase64(buf) });
  }
  return { attachments, skipped };
}
