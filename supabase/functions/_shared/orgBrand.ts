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
}

interface BrandingRow {
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  page_bg_color: string | null;
  email_from_name: string | null;
  email_reply_to: string | null;
  logo_url: string | null;
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
    .select('id, slug, name, email, default_sender_name, default_sender_email, sending_domain, alert_email, logo_email_url');
  if (where.id)    q = q.eq('id', where.id);
  if (where.slug)  q = q.eq('slug', where.slug);
  const { data } = await q.maybeSingle();
  return data as OrgRow | null;
}

async function fetchBranding(supabase: SupabaseClient, orgId: string): Promise<BrandingRow | null> {
  const { data } = await supabase
    .from('org_branding')
    .select('primary_color, secondary_color, accent_color, page_bg_color, email_from_name, email_reply_to, logo_url')
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
