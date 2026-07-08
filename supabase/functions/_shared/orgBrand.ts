// orgBrand — shared tenant-branding loader.
//
// Loads everything an outgoing email needs to identify itself as the tenant:
// FROM display name, FROM address, reply-to, logo, brand colors, support
// email. Falls back to Enrops platform defaults so the platform "self" is
// the catch-all instead of the first tenant.
//
// Cascade for each field:
//   1. The tenant's own org_branding / organizations row (when populated)
//   2. The Enrops org_branding / organizations row (looked up by slug='enrops')
//   3. Hardcoded Enrops defaults (last resort — required because Enrops's
//      sending domain may not be Resend-verified yet)
//
// Out of scope for this helper: hero copy, fonts, custom_css, favicon. Those
// are public-facing site branding, not email branding. Marketing-send has its
// own (older, J2S-colored) loader we don't touch in this pass.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export interface OrgBrand {
  org_id: string;
  org_name: string;
  // FROM line components — Resend takes them combined as `Name <email>`.
  sender_name: string;
  sender_email: string;
  // Reply-to override (operator-facing email a parent should respond to).
  reply_to: string;
  // Where alerts to the operator go (e.g. card decline summaries).
  alert_email: string;
  // Branding for email HTML.
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  page_bg_color: string;
  // Per-tenant email signature, shown above the footer of every outgoing email.
  // Tenant-specific ONLY — never cascades to the Enrops org (a tenant that hasn't
  // set a signature simply gets none; it must not inherit Enrops's).
  email_signature: string | null;      // HTML (safe subset from the friendly editor)
  email_signature_image_url: string | null; // custom logo/headshot URL (used when mode = 'custom')
  email_signature_image_mode: 'logo' | 'custom' | 'none' | null; // null = legacy (fall back to url)
  // Tenant's physical postal address (CAN-SPAM). Rendered in the footer of
  // MARKETING sends only. Tenant-only — never cascades to Enrops (a tenant that
  // hasn't set one simply gets no address block, matching the campaign path).
  mailing_address: string | null;
  // Whether the FROM line is the tenant's own verified domain, a per-tenant
  // address on the shared platform domain, or a fallback. Useful for logging.
  sender_source: 'tenant' | 'platform_shared' | 'platform' | 'hardcoded';
}

// Hardcoded Enrops defaults. Used as the ultimate fallback when even
// Enrops's own org row is missing fields. Email-safe colors.
const ENROPS_DEFAULTS = {
  name: 'Enrops',
  sender_name: 'Enrops',
  // Note: hello@enrops.com must be Resend-verified before this path actually
  // ships email. Until then, expect Resend to reject and the email to fail
  // gracefully (logged, not retried). Configure in Resend dashboard.
  sender_email: 'hello@enrops.com',
  reply_to: 'hello@enrops.com',
  alert_email: 'alerts@enrops.com',
  primary_color: '#1C004F',   // Enrops dark purple
  secondary_color: '#8C88FF', // Enrops violet
  accent_color: '#F8A638',    // warm gold
  page_bg_color: '#FBFBFB',   // Enrops cream
};

interface OrgRow {
  id: string;
  slug: string | null;
  name: string | null;
  email: string | null;
  default_sender_name: string | null;
  default_sender_email: string | null;
  sending_domain: string | null;
  alert_email: string | null;
  logo_email_url: string | null;
  mailing_address: string | null;
}

interface BrandingRow {
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  page_bg_color: string | null;
  email_from_name: string | null;
  email_reply_to: string | null;
  logo_url: string | null;
  email_signature: string | null;
  email_signature_image_url: string | null;
  email_signature_image_mode: string | null;
}

/** The domain part of an email address (after the @), trimmed, or null. */
function domainOf(email: string | null | undefined): string | null {
  const at = (email ?? '').indexOf('@');
  if (at < 0) return null;
  return email!.slice(at + 1).trim() || null;
}

async function fetchOrg(supabase: SupabaseClient, where: { id?: string; slug?: string }): Promise<OrgRow | null> {
  let q = supabase
    .from('organizations')
    .select('id, slug, name, email, default_sender_name, default_sender_email, sending_domain, alert_email, logo_email_url, mailing_address');
  if (where.id)    q = q.eq('id', where.id);
  if (where.slug)  q = q.eq('slug', where.slug);
  const { data } = await q.maybeSingle();
  return data as OrgRow | null;
}

async function fetchBranding(supabase: SupabaseClient, orgId: string): Promise<BrandingRow | null> {
  const { data } = await supabase
    .from('org_branding')
    .select('primary_color, secondary_color, accent_color, page_bg_color, email_from_name, email_reply_to, logo_url, email_signature, email_signature_image_url, email_signature_image_mode')
    .eq('organization_id', orgId)
    .maybeSingle();
  return data as BrandingRow | null;
}

/**
 * Load the full brand context for an org, with cascade to Enrops defaults.
 *
 * @param supabase  Service-role Supabase client.
 * @param orgId     The org we want to "speak as". If null/empty, returns Enrops defaults.
 */
export async function loadOrgBrand(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
): Promise<OrgBrand> {
  const enropsOrg     = await fetchOrg(supabase, { slug: 'enrops' });
  const enropsBranding = enropsOrg ? await fetchBranding(supabase, enropsOrg.id) : null;

  const tenantOrg      = orgId ? await fetchOrg(supabase, { id: orgId }) : null;
  const tenantBranding = tenantOrg ? await fetchBranding(supabase, tenantOrg.id) : null;

  // Helper: first non-empty string in a list.
  const pick = (...vals: (string | null | undefined)[]): string | null => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    return null;
  };

  // Platform sending domain: one Resend-verified domain (e.g. mail.enrops.com)
  // that every tenant WITHOUT its own verified domain sends under, each with a
  // per-tenant local part ({slug}@platformDomain). This removes per-tenant DNS
  // setup and the silent-failure risk of an unverified tenant domain. Derived
  // from the Enrops org's sending_domain (or the domain of its default sender).
  const platformDomain =
    pick(enropsOrg?.sending_domain, domainOf(enropsOrg?.default_sender_email)) ??
    domainOf(ENROPS_DEFAULTS.sender_email)!;
  const tenantSlug = (tenantOrg?.slug ?? '').trim() || null;

  // A tenant's OWN From address is safe ONLY if its domain is the tenant's
  // VERIFIED sending domain (org.sending_domain). Sending from an unauthenticated
  // domain makes Resend reject the message and the email silently fails — so when
  // it isn't verified we fall back to the always-verified shared platform domain.
  // This makes a "won't-send" sender state impossible: a tenant cannot break
  // delivery by setting a custom From. Their own address is still used as the
  // reply_to below, so replies reach them. (Matches how Mailchimp/Klaviyo/HubSpot
  // gate custom sending domains behind DNS verification.)
  const tenantCustomSender = pick(tenantOrg?.default_sender_email);
  const tenantSenderVerified = !!(
    tenantCustomSender &&
    tenantOrg?.sending_domain &&
    domainOf(tenantCustomSender)?.toLowerCase() === tenantOrg.sending_domain.trim().toLowerCase()
  );

  const senderEmail =
    // 1. Tenant's own domain, but ONLY when it is their verified sending domain.
    (tenantSenderVerified ? tenantCustomSender : null) ??
    // 2. Default for every other tenant: a per-tenant address on the shared verified platform domain.
    (tenantSlug ? `${tenantSlug}@${platformDomain}` : null) ??
    // 3. Platform itself (no tenant) → Enrops sender, then hardcoded last resort.
    pick(enropsOrg?.default_sender_email) ??
    ENROPS_DEFAULTS.sender_email;
  const senderName =
    pick(
      tenantOrg?.default_sender_name,
      tenantBranding?.email_from_name,
      tenantOrg?.name, // a tenant on the shared domain still sends as ITSELF, not "Enrops"
      enropsOrg?.default_sender_name,
      enropsBranding?.email_from_name,
    ) ?? ENROPS_DEFAULTS.sender_name;

  const senderSource: OrgBrand['sender_source'] = tenantOrg?.default_sender_email
    ? 'tenant'
    : tenantSlug
      ? 'platform_shared'
      : enropsOrg?.default_sender_email
        ? 'platform'
        : 'hardcoded';

  return {
    org_id: tenantOrg?.id ?? enropsOrg?.id ?? '',
    org_name: pick(tenantOrg?.name, enropsOrg?.name) ?? ENROPS_DEFAULTS.name,

    sender_name: senderName,
    sender_email: senderEmail,
    sender_source: senderSource,

    reply_to:
      pick(
        tenantBranding?.email_reply_to,
        tenantOrg?.email,
        enropsBranding?.email_reply_to,
        enropsOrg?.email,
      ) ?? ENROPS_DEFAULTS.reply_to,

    alert_email:
      pick(tenantOrg?.alert_email, enropsOrg?.alert_email) ?? ENROPS_DEFAULTS.alert_email,

    logo_url:
      pick(
        tenantOrg?.logo_email_url,
        tenantBranding?.logo_url,
        enropsOrg?.logo_email_url,
        enropsBranding?.logo_url,
      ),

    // Signature is tenant-only: no cascade to Enrops (a tenant must never inherit
    // the platform's signature). Absent → null → no block renders.
    email_signature: pick(tenantBranding?.email_signature),
    email_signature_image_url: pick(tenantBranding?.email_signature_image_url),
    email_signature_image_mode: (pick(tenantBranding?.email_signature_image_mode) as OrgBrand['email_signature_image_mode']),

    // CAN-SPAM postal address — tenant-only (no Enrops cascade), rendered in the
    // marketing footer when set. Empty for tenants who haven't added one yet.
    mailing_address: pick(tenantOrg?.mailing_address),

    primary_color:
      pick(tenantBranding?.primary_color, enropsBranding?.primary_color) ?? ENROPS_DEFAULTS.primary_color,
    secondary_color:
      pick(tenantBranding?.secondary_color, enropsBranding?.secondary_color) ?? ENROPS_DEFAULTS.secondary_color,
    accent_color:
      pick(tenantBranding?.accent_color, enropsBranding?.accent_color) ?? ENROPS_DEFAULTS.accent_color,
    page_bg_color:
      pick(tenantBranding?.page_bg_color, enropsBranding?.page_bg_color) ?? ENROPS_DEFAULTS.page_bg_color,
  };
}

/**
 * Build the Resend "from" string: `Name <email>`.
 * Resend requires the email's domain to be verified.
 */
export function formatFromAddress(brand: OrgBrand): string {
  return `${brand.sender_name} <${brand.sender_email}>`;
}

/** Escape a string for safe use inside a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the tenant's email signature block (image + text) for injection above
 * the footer of every outgoing email. Returns '' when the tenant has set no
 * signature — so orgs without one are byte-for-byte unchanged (backward compat).
 *
 * `email_signature` is HTML from the friendly Comms editor (the same safe subset
 * as body_override: <p>/<strong>/<em>/<a>/<br>), so it is emitted as-is. The
 * image is our own <img> tag with the URL attribute-escaped. Used by BOTH send
 * shells (lifecycle-automations-cron + marketing-touchpoint-send) so the
 * signature is identical across automated and campaign email.
 */
export function renderSignatureBlock(brand: OrgBrand): string {
  const text = (brand.email_signature ?? '').trim();
  // Resolve the signature image by its stored mode. 'logo' tracks the org's
  // CURRENT logo (not a snapshot), 'custom' uses the uploaded image, 'none' shows
  // nothing. null = legacy rows (saved before the mode column) → fall back to the
  // stored URL so existing signatures render unchanged.
  const mode = brand.email_signature_image_mode;
  const img = (
    mode === 'logo'   ? (brand.logo_url ?? '')
    : mode === 'custom' ? (brand.email_signature_image_url ?? '')
    : mode === 'none'   ? ''
    : (brand.email_signature_image_url ?? '') // legacy
  ).trim();
  if (!text && !img) return '';
  const textBlock = text ? `<div>${text}</div>` : '';
  const imgBlock = img
    ? `<img src="${escapeAttr(img)}" alt="${escapeAttr(brand.org_name)}" style="max-height:64px;max-width:220px;height:auto;display:block;margin:${text ? '12px' : '0'} 0 0;" />`
    : '';
  return `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;color:#555;font-size:14px;line-height:1.5;">${textBlock}${imgBlock}</div>`;
}
