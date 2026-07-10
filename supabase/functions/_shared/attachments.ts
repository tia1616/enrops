// attachments — shared comms-attachment resolver.
//
// One chokepoint for BOTH send paths (lifecycle-automations-cron +
// marketing-touchpoint-send) so attachment logic is never forked.
//
// Model: each email row carries `email_attachments jsonb` =
//   [ { "id": "<comms_attachments.id>", "attach": <bool> } ]
// Every entry renders as a branded **Download button** appended to the BOTTOM of
// the email body (above the signature) — NOT a token the operator places, so the
// body stays clean prose and the preview shows the real button. `attach: true`
// ALSO rides the raw file along as a base64 Resend attachment (automations only;
// campaigns are link-only because Resend's /emails/batch can't take attachments).
//
// Tenant safety: every load is filtered by organization_id, so a row that
// references another org's file id resolves to nothing (dropped), never leaks.
// Archived files (archived_at) are excluded.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import type { OrgBrand } from './orgBrand.ts';

const BUCKET = 'comms-attachments';

// Deliverability safety cap for TRUE attachments (base64 in the email itself).
const MAX_ATTACH_TOTAL_BYTES = 15 * 1024 * 1024; // 15 MB

export interface CommsAttachment {
  id: string;
  organization_id: string;
  file_name: string;
  storage_path: string;
  byte_size: number;
  content_type: string;
  title: string | null;
}

export interface EmailAttachmentRef {
  id: string;
  attach: boolean;
}

/** Normalize the `email_attachments` jsonb into a typed list (defensive against bad shapes). */
export function parseEmailAttachments(raw: unknown): EmailAttachmentRef[] {
  if (!Array.isArray(raw)) return [];
  const out: EmailAttachmentRef[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      out.push({ id: (item as { id: string }).id.toLowerCase(), attach: !!(item as { attach?: unknown }).attach });
    }
  }
  return out;
}

/**
 * Load attachment rows for this org, keyed by id. ALWAYS scoped to orgId so an
 * email can never pull a file from another tenant. Missing/archived ids won't
 * appear (callers treat absence as "skip").
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

/** One inline-block branded Download button for a file. */
function downloadButtonHtml(att: CommsAttachment, url: string, brand: OrgBrand): string {
  const bg = escapeHtml(brand.primary_color || '#1C004F');
  const label = escapeHtml(att.title?.trim() || att.file_name);
  return (
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" ` +
    `style="display:inline-block;margin:6px 0;padding:12px 22px;background:${bg};` +
    `font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;` +
    `color:#ffffff;text-decoration:none;border-radius:8px;">` +
    `&#11015;&nbsp;Download ${label}</a>`
  );
}

/**
 * Render the Download-buttons block appended to the bottom of the email body
 * (above the signature). Returns '' when there are no files so orgs without
 * attachments are byte-for-byte unchanged.
 */
export function renderDownloadButtonsHtml(
  atts: CommsAttachment[],
  supabase: SupabaseClient,
  brand: OrgBrand,
): string {
  if (!atts.length) return '';
  const buttons = atts
    .map((a) => `<div style="margin:0;">${downloadButtonHtml(a, publicUrlFor(supabase, a.storage_path), brand)}</div>`)
    .join('');
  return `<div style="margin:24px 0 0;">${buttons}</div>`;
}

/** Plain-text form of the Download-buttons block ("Download name: url" lines). */
export function renderDownloadButtonsText(atts: CommsAttachment[], supabase: SupabaseClient): string {
  if (!atts.length) return '';
  const lines = atts.map((a) => `Download ${a.title?.trim() || a.file_name}: ${publicUrlFor(supabase, a.storage_path)}`);
  return `\n\n${lines.join('\n')}`;
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
 * Build the Resend `attachments` array (base64) for files flagged attach:true.
 * Downloads each file's bytes; skips (reports) any that push the running total
 * over MAX_ATTACH_TOTAL_BYTES or fail to download — the email still sends.
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
    if (total + buf.byteLength > MAX_ATTACH_TOTAL_BYTES) {
      skipped.push(a.file_name);
      continue;
    }
    total += buf.byteLength;
    attachments.push({ filename: a.file_name, content: bytesToBase64(buf) });
  }
  return { attachments, skipped };
}
