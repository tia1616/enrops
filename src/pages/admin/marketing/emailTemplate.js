// src/pages/admin/marketing/emailTemplate.js
// Branded HTML email wrapper matching existing J2S registration emails.
// Provider writes plain text → we wrap it in this template before sending.
// Multi-tenant: accepts org name, accent color, contact email.

const DEFAULT_ACCENT = "#674EE8";
const DEFAULT_ACCENT_DARK = "#4430AC";
const DEFAULT_HIGHLIGHT = "#F8A638";
const DEFAULT_INK = "#1A1530";
const DEFAULT_MUTED = "#6b6880";
const DEFAULT_FOOTER_BG = "#1A1530";

/**
 * Wraps plain-text email body in branded HTML.
 * @param {object} opts
 * @param {string} opts.subject - Email subject line
 * @param {string} opts.body - Plain text body (newlines preserved, placeholders already resolved)
 * @param {string} opts.orgName - Organization display name
 * @param {string} opts.contactEmail - Support/contact email
 * @param {string} opts.accentColor - Primary brand color (hex)
 * @param {string} opts.tagline - Footer tagline
 * @returns {string} Complete HTML email
 */
export function wrapEmailHtml({
  subject = "",
  body = "",
  orgName = "Journey to STEAM",
  contactEmail = "info@journeytosteam.com",
  accentColor = DEFAULT_ACCENT,
  tagline = "Big adventures after the last bell.",
} = {}) {
  const accentDark = darkenHex(accentColor, 0.25);
  const bodyHtml = textToHtml(body);
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:'Nunito Sans',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,${accentColor},${accentDark});padding:36px 30px;text-align:center;">
    <div style="color:${DEFAULT_HIGHLIGHT};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${escHtml(orgName)}</div>
    <h1 style="color:#ffffff;margin:10px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;line-height:1.3;">${escHtml(subject)}</h1>
  </div>

  <!-- Body -->
  <div style="padding:32px 30px;">
    <div style="font-size:16px;color:${DEFAULT_INK};line-height:1.65;">
      ${bodyHtml}
    </div>

    <!-- Tagline -->
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e8e6f0;">
      <p style="margin:0;font-size:14px;color:${DEFAULT_MUTED};font-style:italic;">${escHtml(tagline)}</p>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:${DEFAULT_FOOTER_BG};padding:20px 30px;text-align:center;">
    <p style="margin:0 0 6px;font-size:12px;color:#ffffff;opacity:0.6;">${escHtml(orgName)} &middot; Powered by Enrops &middot; ${year}</p>
    <p style="margin:0;font-size:12px;color:#ffffff;opacity:0.45;">Questions? <a href="mailto:${escHtml(contactEmail)}" style="color:#ffffff;text-decoration:underline;">${escHtml(contactEmail)}</a></p>
  </div>
</div>
</body></html>`;
}

/**
 * Converts plain text to email-safe HTML.
 * Preserves paragraphs (double newlines) and line breaks (single newlines).
 */
function textToHtml(text) {
  if (!text) return "";
  return escHtml(text)
    .split(/\n\n+/)
    .map(para =>
      `<p style="margin:0 0 16px;">${para.replace(/\n/g, "<br>")}</p>`
    )
    .join("");
}

function escHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Darken a hex color by a fraction (0–1).
 */
function darkenHex(hex, amount) {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.floor(((num >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.floor(((num >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.floor((num & 0xff) * (1 - amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * Sample data for preview rendering.
 */
export const PREVIEW_SAMPLE_DATA = {
  parent_first_name: "Maria",
  student_first_name: "Sage",
  school_name: "Cannady Elementary",
  curriculum_name: "Minecraft Coders",
  first_session_date: "September 17",
  day_of_week: "Tuesday",
  start_time: "3:30 PM",
  instructor_first_name: "Anjelique",
  registration_link: "https://enrops.com/j2s",
  organization_name: "Journey to STEAM",
  mid_term_skills: "[curriculum skills — requires DB migration]",
  final_skills: "[curriculum skills — requires DB migration]",
};

/**
 * Replaces all {{placeholder}} tags with sample or real values.
 */
export function resolvePlaceholders(text, data = PREVIEW_SAMPLE_DATA) {
  let result = text;
  for (const [key, val] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
  }
  return result;
}
