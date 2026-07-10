// AutomationEditor — per-template editor drawer.
//
// Opens from the right side. Operator can:
//   - Edit subject (default = template.default_subject, override = automations.subject_override)
//   - Edit body  (HTML textarea — operators see the same markup the engine renders)
//   - See live preview with sample tokens substituted, in a sandboxed iframe
//   - Send a test email to themselves (uses POST {mode:"test_send"} on lifecycle cron)
//   - Reset overrides → revert to template defaults
//
// Token chip row is informational (read-only) for v1 — clickable insertion is
// a v2 polish if operators ask for it. The displayed token list is per-template
// since different workflows have different tokens available.
//
// Preview iframe uses sandbox="allow-popups allow-popups-to-escape-sandbox" +
// server-injected <base target="_blank"> per guardrails section 6C — keeps
// clicks safe AND opens links in a new tab instead of blanking the iframe.

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, BRIGHT, INK, MUTED, RULE, OK, WARN } from "../marketing/tokens.jsx";
import { editableToHtml, highlightTokens, htmlToEditable } from "./bodyEditorUtils.js";
import AttachmentPicker from "./AttachmentPicker.jsx";
import { buildRegUrl, PUBLIC_SITE } from "../../../lib/regLinks.js";

// Decode the common HTML entities operators might type or paste into a
// plain-text input. The big one is &mdash; in subjects — subjects don't
// render HTML, so the literal 7-char string would land in parents' inboxes.
// Catches the same bug Jessica caught 2026-06-03.
function decodeCommonEntities(s) {
  if (typeof s !== "string" || !s) return s;
  return s
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&larr;/g, "←")
    .replace(/&middot;/g, "·")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    // &amp; last — otherwise we'd un-double-escape any literal &amp; the
    // operator put in deliberately (e.g. inside a real URL query string).
    .replace(/&amp;/g, "&");
}

// Per-template token availability. Mirrors what the cron's buildTokens emits
// for each trigger type. Keep in sync with lifecycle-automations-cron/index.ts.
// {{sender_name}} = the person who sends (stripped of " @ Org" suffix);
// useful in sign-offs for a personal touch.
const TOKENS_BY_TEMPLATE_KEY = {
  thank_you:              ["first_name", "child_first_name", "org_name", "sender_name", "registration_summary_block"],
  welcome_camp:           ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "program_start_date", "location_name", "arrival_dismissal_block", "final_showcase_block", "next_term_link_block", "register_url"],
  welcome_afterschool:    ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "program_start_date", "location_name", "arrival_dismissal_block", "session_dates_block", "next_term_link_block", "register_url"],
  check_in:               ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "register_url"],
  mid_recap:              ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "mid_term_skills_block", "register_url"],
  final_recap:            ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "program_end_date", "final_showcase_block", "final_recap_skills_block", "next_term_link_block", "register_url"],
  birthday:               ["first_name", "child_first_name", "org_name", "sender_name", "age_turning"],
  abandoned_registration: ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "abandoned_resume_url"],
  survey_nudge:           ["first_name", "child_first_name", "org_name", "sender_name", "program_name"],
  // review_request reaches enrolled families AND bare contacts, so it only
  // exposes tokens that resolve for both. Program-specific tokens are omitted:
  // a contact has no program, so {{program_name}} would render empty. The review
  // link itself is a plain URL the operator pastes into the body (not a token).
  review_request:         ["first_name", "child_first_name", "org_name", "sender_name"],
  // no_school_day: program-centric (no child name — a parent may have several
  // kids in one class). {{no_school_dates}} = the affected class day(s);
  // {{no_school_reason}} = why (falls back to "a no-school day" if blank).
  no_school_day:          ["first_name", "no_school_dates", "no_school_reason", "program_name", "location_name", "org_name", "sender_name"],
};

// HTML-pre-rendered tokens — preview passes their sample HTML through verbatim.
const PRE_RENDERED_HTML_TOKENS = new Set(["final_showcase_block", "mid_term_skills_block", "final_recap_skills_block", "arrival_dismissal_block", "session_dates_block", "registration_summary_block", "next_term_link_block"]);

// Which templates support a real-data test send, and which source(s) to offer
// in the picker. These pull real curriculum/dates/location/skills so the test
// email is a true preview. The other templates (thank_you, birthday,
// abandoned_registration) don't key off a single program — their tests use
// sample data. Keep in sync with applies_to_program_type in the cron.
const TEST_SOURCE_BY_TEMPLATE_KEY = {
  welcome_camp: "camps",
  welcome_afterschool: "afterschool",
  check_in: "afterschool",
  mid_recap: "both",
  final_recap: "both",
};

// Short, friendly date for picker labels (e.g. "Jun 17, 2026"). Falls back to
// the raw value if it isn't a parseable ISO date.
function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Sample values for the live preview. Tenant-aware — pre-rendered blocks
// use the org's actual primary_color so what operators see matches what
// parents receive. {{sender_name}} sample is intentionally just a first name
// to demonstrate the stripped form that lands in sign-offs.
function sampleTokens(orgName, senderName, primaryColor, orgSlug) {
  const color = primaryColor || "#1C004F";
  // Real tenant registration URL so the preview matches the live send. Cron
  // builds the same `${site}/${slug}/register` from the org's slug.
  // Absolute prod URL (PUBLIC_SITE) — this lands in an email sent later by the
  // cron, so it must never inherit a staging origin. Same string the cron builds.
  const registerUrl = orgSlug ? buildRegUrl(orgSlug, null, PUBLIC_SITE) : `${PUBLIC_SITE}/your-org`;
  return {
    first_name: "Sarah",
    child_first_name: "Mia",
    org_name: orgName || "Your organization",
    sender_name: (senderName?.split(" @ ")[0]?.trim()) || "You",
    program_name: "Mini Robotics",
    program_start_date: "Monday, June 17",
    program_end_date: "Friday, June 21",
    location_name: "Beaverton STEAM Hub",
    age_turning: "8",
    abandoned_resume_url: "#",
    no_school_dates: "Monday, September 7",
    no_school_reason: "Labor Day",
    register_url: registerUrl,
    final_showcase_block:
      `<div style="background:#f5f4ee;border-left:3px solid ${color};padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;"><strong>On the final day:</strong> Campers host a Playtest Arcade where every kid loads their finished platformer onto a Chromebook and the whole group rotates through playing each other's games.</div>`,
    registration_summary_block:
      '<div style="background:#f5f4ee;padding:16px;margin:16px 0;border-radius:6px;color:#6b6880;font-style:italic;">[Auto-generated registration details will appear here in the real send — program rows, location, day/time, payment summary.]</div>',
    next_term_link_block:
      `<p style="margin-top:24px;padding-top:16px;border-top:1px solid #ede9fe;font-size:14px;color:#1A1530;">Looking ahead? <a href="${registerUrl}" style="color:${color};font-weight:600;text-decoration:none;">See what's coming next &rarr;</a></p>`,
    mid_term_skills_block:
      `<div style="background:#f5f4ee;padding:16px 20px;margin:16px 0;border-radius:6px;border-left:3px solid ${color};"><p style="margin:0 0 10px;font-weight:700;color:#1A1530;">What they have been working on:</p><ul style="margin:0;padding-left:20px;color:#1A1530;line-height:1.6;"><li>Physics simulation: coding velocity, gravity, and friction with variables</li><li>Collision detection: triggering game events when sprites touch</li><li>Platformer level design: sketching and building jumpable layouts</li><li>Game logic with conditional statements and loops</li></ul></div>`,
    final_recap_skills_block:
      `<div style="background:#f5f4ee;padding:16px 20px;margin:16px 0;border-radius:6px;border-left:3px solid ${color};"><p style="margin:0 0 10px;font-weight:700;color:#1A1530;">What they covered:</p><ul style="margin:0;padding-left:20px;color:#1A1530;line-height:1.6;"><li>Physics simulation: velocity, gravity, and friction using variables</li><li>Event-driven programming with broadcasts and receivers across multiple sprites</li><li>Variable management for score, lives, and game state</li><li>Multi-scene architecture: warp pipes and backdrop switching for multiple levels</li><li>Game design process: sketch, build, playtest, and iterate</li></ul></div>`,
    arrival_dismissal_block:
      `<div style="background:#f5f4ee;padding:14px 18px;margin:16px 0;border-radius:6px;border-left:3px solid ${color};"><p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${color};">Arrival</p><p style="margin:0;color:#1A1530;font-size:14px;line-height:1.55;margin-bottom:12px;">Doors open at 8:45am. Drop off at the lobby — instructors will check kids in and walk them to the room. Please park in the visitor lot, not the loading zone.</p><p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${color};">Dismissal</p><p style="margin:0;color:#1A1530;font-size:14px;line-height:1.55;">Pickup is at the lobby at 12:30pm sharp. Please be on time — instructors need to leave for the afternoon session.</p></div>`,
    session_dates_block:
      `<div style="background:#f5f4ee;padding:14px 18px;margin:16px 0;border-radius:6px;border-left:3px solid ${color};"><p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${color};">Schedule</p><p style="margin:0;color:#1A1530;font-size:14px;line-height:1.55;">12 weekly sessions, starting Monday, September 7 and ending Monday, December 7.</p></div>`,
  };
}

function escapeHtmlSafe(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTokens(template, tokens) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const v = tokens[key];
    if (v == null) return match;
    return PRE_RENDERED_HTML_TOKENS.has(key) ? v : escapeHtmlSafe(v);
  });
}

function buildPreviewHtml(subject, body, orgName, senderName, logoUrl, primaryColor, orgSlug, isMarketing = false) {
  const tokens = sampleTokens(orgName, senderName, primaryColor, orgSlug);
  const renderedSubject = renderTokens(subject, tokens);
  const renderedBody = renderTokens(body, tokens);
  // Shell matches the cron's wrapInShell — tenant logo on white, no generic
  // platform gradient. Wordmark fallback when no logo is set.
  const safeName = escapeHtmlSafe(orgName || "Your organization");
  const color = primaryColor || "#1C004F";
  const logoBlock = logoUrl
    ? `<img src="${escapeHtmlSafe(logoUrl)}" alt="${safeName}" style="max-height:56px;display:block;margin:0 auto;" />`
    : `<div style="color:${color};font-size:18px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;text-align:center;">${safeName}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><base target="_blank"><title>${escapeHtmlSafe(renderedSubject)}</title></head>
<body style="margin:0;padding:0;background:#fbfaf6;font-family:'Nunito Sans',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#fff;">
  <div style="padding:8px 30px 12px;color:#6b6880;font-size:12px;background:#fbfaf6;"><strong>Subject:</strong> ${escapeHtmlSafe(renderedSubject)}</div>
  <div style="padding:32px 30px 8px;text-align:center;">${logoBlock}</div>
  <div style="padding:16px 30px 32px;color:#1A1530;font-size:16px;line-height:1.6;">${renderedBody}</div>
  <div style="padding:18px 30px;text-align:center;color:#888;font-size:11px;border-top:1px solid #eee;">${safeName} &middot; Powered by Enrops &middot; ${new Date().getFullYear()}${isMarketing ? '<br><a href="#" style="color:#888;text-decoration:underline;">Unsubscribe</a>' : ''}</div>
</div>
</body></html>`;
}

// review_request ships with a placeholder review link the operator must replace.
// Rather than make a non-dev hand-edit HTML/markdown, review_request shows a
// dedicated "Your review link" field that reads/writes the single <a> in the body.
// (The unsubscribe link is added by the email shell at send, never in the body,
// so the body's only <a> is always the review link.)
const REVIEW_LINK_PLACEHOLDER_HREF = "your-review-link-here";

// Normalize a pasted review URL into a safe https link. We STRIP characters that
// can't legitimately be in a URL and that would break out of the href attribute
// (", ', <, >, backtick, whitespace, backslash) — we can't rely on HTML-escaping
// them because the save path (decodeCommonEntities) would undo the escaping. Any
// non-http(s) scheme (javascript:, data:, mailto:, …) is stripped and forced to
// https://, yielding an inert web link rather than a live dangerous scheme. A
// bare domain also gets https://.
function normalizeReviewUrl(raw) {
  const s = (raw || "").trim().replace(/["'<>`\s\\]/g, "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^[a-z][a-z0-9+.-]*:\/*/i, "").replace(/^\/+/, "")}`;
}

// Pull the review URL out of the body's anchor — "" when it's still the
// placeholder or there is no anchor.
function extractReviewUrl(body) {
  const m = (body || "").match(/<a\s+[^>]*href="([^"]*)"/i);
  if (!m) return "";
  return m[1].includes(REVIEW_LINK_PLACEHOLDER_HREF) ? "" : m[1];
}

// Write the operator's URL into the body's review anchor (rebuilding the whole
// <a>…</a> so the visible text is always sensible). Empty url restores the
// placeholder anchor, so the enable-guard re-blocks and no dead link can ship.
function setReviewUrlInBody(body, url) {
  const clean = normalizeReviewUrl(url);
  const anchor = clean
    ? `<a href="${escapeHtmlSafe(clean)}" style="color:#674EE8;font-weight:600;">Leave a quick review</a>`
    : `<a href="https://${REVIEW_LINK_PLACEHOLDER_HREF}" style="color:#674EE8;font-weight:600;">Add your review link here</a>`;
  const src = body || "";
  if (/<a\s+[^>]*>.*?<\/a>/is.test(src)) {
    // Function replacer (not a string) so a URL containing "$" isn't mangled by
    // String.replace's $-substitution ($&, $1, $$ …).
    return src.replace(/<a\s+[^>]*>.*?<\/a>/is, () => anchor);
  }
  // Operator deleted the anchor entirely — append a paragraph with the link back.
  return `${src}\n<p style="margin:0 0 16px;">${anchor}</p>`;
}

export default function AutomationEditor({ template, automation, orgId, orgName, orgSlug, orgLogoUrl, orgSenderName, orgPrimaryColor, userEmail, onClose, onSaved }) {
  const [subject, setSubject] = useState(automation?.subject_override ?? template.default_subject);
  const [body, setBody] = useState(automation?.body_override ?? template.default_body);
  // Toggle: false = render the HTML with token pills; true = textarea with
  // markdown-ish editable text. body stays canonical HTML throughout.
  const [editingBody, setEditingBody] = useState(false);
  const [editableText, setEditableText] = useState("");
  // Files true-attached to this automation (ride in the email). Download-button
  // LINKS live as {{attachment:<id>}} markers in the body, tracked separately.
  const [attachmentIds, setAttachmentIds] = useState(automation?.attachment_ids ?? []);
  const bodyTextareaRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [testEmail, setTestEmail] = useState(userEmail || "");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Operator-editable send timing. EXPLICIT per-template allowlist — which
  // templates expose the control, which key it writes, and what the delay is
  // measured from. Explicit (not "any template with a numeric timing key") so
  // generalizing the control never silently pulls another template into scope:
  // welcome_camp/welcome_afterschool also carry default_timing.days_before, but
  // their send-timing was never operator-editable and this PR keeps it that way.
  // The value writes automations.timing_override[timingKey]; equal-to-default
  // clears the override. Held as a string so the input can be transiently empty.
  const TIMING_CONTROLS = {
    check_in:       { key: "days_after",  anchor: "the first session" },
    review_request: { key: "days_after",  anchor: "a family joins" },
    no_school_day:  { key: "days_before", anchor: "the no-school day" },
  };
  const timingCfg = TIMING_CONTROLS[template.key] ?? null;
  const timingKey = timingCfg?.key ?? null;
  const hasTiming = !!timingCfg && typeof template?.default_timing?.[timingKey] === "number";
  const timingIsBefore = timingKey === "days_before";
  const defaultTiming = hasTiming ? template.default_timing[timingKey] : null;
  const savedTiming = hasTiming ? (automation?.timing_override?.[timingKey] ?? defaultTiming) : null;
  const [timingValue, setTimingValue] = useState(savedTiming != null ? String(savedTiming) : "");
  const timingAnchorLabel = timingCfg?.anchor ?? "";

  // review_request: a dedicated "Your review link" field so the operator never
  // hand-edits HTML to set the link. It reads/writes the single <a> in the body.
  const isReviewLink = template.key === "review_request";
  const [reviewLink, setReviewLink] = useState(
    isReviewLink ? extractReviewUrl(automation?.body_override ?? template.default_body) : "",
  );
  function handleReviewLinkChange(value) {
    setReviewLink(value);
    setBody((prev) => setReviewUrlInBody(prev, value));
  }

  // Real-data test picker. testSources holds the org's camps/programs eligible
  // for this template; selectedSource is "camp:<id>" / "program:<id>" / "" (sample).
  const sourceType = TEST_SOURCE_BY_TEMPLATE_KEY[template.key] ?? null;
  const [testSources, setTestSources] = useState([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [selectedSource, setSelectedSource] = useState("");

  // Server-rendered real-data preview (mirrors marketing's mode:"preview").
  // When a real camp/program is selected, the preview pane shows the SAME HTML
  // a real send produces — not local sample tokens. null = fall back to sample.
  const [serverPreview, setServerPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const realSourceSelected = !!sourceType && !!selectedSource;

  // no_school_day is a two-audience automation: the editable subject/body is the
  // PARENT email; the instructor gets fixed tailored copy. This toggle previews +
  // test-sends either variant. For no_school_day we always use the server preview
  // (it renders sample data through the real pipeline, and knows the instructor
  // copy) so the pane switches with the toggle. Other templates ignore audience.
  const isTwoAudience = template.key === "no_school_day";
  const [audience, setAudience] = useState("parent"); // "parent" | "instructor"
  const audienceParam = audience === "instructor" ? "instructor" : undefined;
  const wantsServerPreview = realSourceSelected || isTwoAudience;

  useEffect(() => {
    if (!sourceType || !orgId) return;
    let cancelled = false;
    setLoadingSources(true);
    (async () => {
      const sources = [];
      try {
        if (sourceType === "camps" || sourceType === "both") {
          const { data: camps } = await supabase
            .from("camp_sessions")
            .select("id, curriculum_name, location_name, starts_on")
            .eq("organization_id", orgId)
            .order("starts_on", { ascending: false });
          for (const c of camps ?? []) {
            sources.push({
              value: `camp:${c.id}`,
              label: `Camp · ${c.curriculum_name ?? "Untitled"}${c.location_name ? ` — ${c.location_name}` : ""}${c.starts_on ? ` (${shortDate(c.starts_on)})` : ""}`,
            });
          }
        }
        if (sourceType === "afterschool" || sourceType === "both") {
          const { data: progs } = await supabase
            .from("programs")
            .select("id, curriculum, first_session_date, program_locations ( name )")
            .eq("organization_id", orgId)
            .order("first_session_date", { ascending: false });
          for (const p of progs ?? []) {
            sources.push({
              value: `program:${p.id}`,
              label: `After-school · ${p.curriculum ?? "Untitled"}${p.program_locations?.name ? ` — ${p.program_locations.name}` : ""}${p.first_session_date ? ` (${shortDate(p.first_session_date)})` : ""}`,
            });
          }
        }
      } catch {
        // Non-fatal — picker just falls back to sample data.
      }
      if (cancelled) return;
      setTestSources(sources);
      // Default to the first real source so the test is a true preview by
      // default; if the org has none, stay on sample data.
      setSelectedSource(sources.length > 0 ? sources[0].value : "");
      setLoadingSources(false);
    })();
    return () => { cancelled = true; };
  }, [sourceType, orgId]);

  // Server-rendered preview. When a real camp/program is picked, ask the cron to
  // render the SAME pipeline a real send uses (mode:"preview" — no email leaves
  // the system) so the pane shows true resolved content, not sample tokens.
  // Debounced so every keystroke in subject/body doesn't hammer the function.
  useEffect(() => {
    if (!wantsServerPreview) {
      setServerPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const [srcType, srcId] = (selectedSource || "").split(":");
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const t = setTimeout(async () => {
      try {
        const { data, error: fnErr } = await supabase.functions.invoke(
          "lifecycle-automations-cron",
          {
            body: {
              mode: "preview",
              organization_id: orgId,
              template_key: template.key,
              preview_subject: subject,
              preview_body: body,
              test_camp_session_id: srcType === "camp" ? srcId : null,
              test_program_id: srcType === "program" ? srcId : null,
              audience: audienceParam,
            },
          },
        );
        if (cancelled) return;
        if (fnErr) throw fnErr;
        if (data?.ok === false) throw new Error(data?.error ?? "Preview failed");
        setServerPreview({ body_html: data?.body_html ?? "", subject: data?.subject ?? "", used_real_data: !!data?.used_real_data });
      } catch (e) {
        if (cancelled) return;
        setServerPreview(null);
        setPreviewError(e?.message ?? "Couldn't load real-data preview");
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [wantsServerPreview, realSourceSelected, selectedSource, subject, body, orgId, template.key, audienceParam]);

  function toggleBodyEdit() {
    if (editingBody) {
      // Done editing — already pushed each keystroke into body via editableToHtml.
      setEditingBody(false);
    } else {
      setEditableText(htmlToEditable(body));
      setEditingBody(true);
    }
  }

  function handleEditableChange(newText) {
    setEditableText(newText);
    setBody(editableToHtml(newText));
  }

  // Insert an {{attachment:<id>}} Download-button marker. If the body is in
  // rendered (non-edit) mode, switch to edit mode and append; otherwise splice
  // it in at the cursor and keep the caret after it.
  function insertAttachmentToken(token) {
    if (!editingBody) {
      const base = htmlToEditable(body);
      const next = base.trim() ? `${base}\n\n${token}` : token;
      setEditableText(next);
      setBody(editableToHtml(next));
      setEditingBody(true);
      return;
    }
    const ta = bodyTextareaRef.current;
    if (!ta) {
      const next = editableText.trim() ? `${editableText}\n\n${token}` : token;
      handleEditableChange(next);
      return;
    }
    const start = ta.selectionStart ?? editableText.length;
    const end = ta.selectionEnd ?? start;
    const next = editableText.slice(0, start) + token + editableText.slice(end);
    handleEditableChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  // Reset success/error after a few seconds
  useEffect(() => {
    if (!success && !error) return;
    const t = setTimeout(() => { setSuccess(null); setError(null); }, 6000);
    return () => clearTimeout(t);
  }, [success, error]);

  const previewHtml = useMemo(
    () => buildPreviewHtml(subject, body, orgName, orgSenderName, orgLogoUrl, orgPrimaryColor, orgSlug, template.mailing_type === "marketing"),
    [subject, body, orgName, orgSenderName, orgLogoUrl, orgPrimaryColor, orgSlug, template.mailing_type],
  );

  // What the iframe actually shows. When a real source is picked AND the server
  // returned HTML, render that (true resolved content). The cron's wrapInShell
  // doc has no <base target="_blank">, so inject one — keeps in-iframe link
  // clicks opening a new tab instead of blanking the sandbox. Otherwise fall
  // back to the local sample render (also used while the server call is loading).
  const showingServerPreview = wantsServerPreview && !!serverPreview?.body_html;
  const displayedPreviewHtml = useMemo(() => {
    if (!showingServerPreview) return previewHtml;
    const html = serverPreview.body_html;
    return /<head[^>]*>/i.test(html)
      ? html.replace(/<head([^>]*)>/i, '<head$1><base target="_blank">')
      : `<base target="_blank">${html}`;
  }, [showingServerPreview, serverPreview, previewHtml]);

  const tokens = TOKENS_BY_TEMPLATE_KEY[template.key] ?? [];
  const hasOverride = (automation?.subject_override != null) || (automation?.body_override != null) || (automation?.timing_override != null) || ((automation?.attachment_ids?.length ?? 0) > 0);
  const subjectDirty = subject !== (automation?.subject_override ?? template.default_subject);
  const bodyDirty = body !== (automation?.body_override ?? template.default_body);
  // Clamp ≥1; empty/invalid falls back to the template default. Mirrors the cron.
  const parsedTiming = hasTiming
    ? Math.max(1, parseInt(timingValue, 10) || defaultTiming || 1)
    : null;
  const timingDirty = hasTiming && parsedTiming !== savedTiming;
  const attachmentsDirty =
    JSON.stringify([...(attachmentIds ?? [])].sort()) !==
    JSON.stringify([...(automation?.attachment_ids ?? [])].sort());
  const dirty = subjectDirty || bodyDirty || timingDirty || attachmentsDirty;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      // Decode any HTML entities the operator pasted in. Subjects are
      // plain text — &mdash; would render as 7 literal chars. Bodies are
      // HTML and entities render correctly there, but decoded chars look
      // cleaner in the editor next time they open it.
      const cleanedSubject = decodeCommonEntities(subject);
      const cleanedBody = decodeCommonEntities(body);
      // Only set overrides for fields that actually differ from defaults —
      // keeps the table clean and makes "Reset" semantically simple.
      const subjectOverride = cleanedSubject !== template.default_subject ? cleanedSubject : null;
      const bodyOverride = cleanedBody !== template.default_body ? cleanedBody : null;
      // Timing override: only for templates with the control, and only when it
      // differs from the default (equal-to-default clears it, like subject/body).
      const patch = { subject_override: subjectOverride, body_override: bodyOverride, attachment_ids: attachmentIds ?? [] };
      if (hasTiming) {
        patch.timing_override = parsedTiming !== defaultTiming
          ? { ...(automation?.timing_override ?? {}), [timingKey]: parsedTiming }
          : null;
      }
      // Capture prior values BEFORE the upsert so we can append edit history.
      const prevSubject = automation?.subject_override ?? null;
      const prevBody = automation?.body_override ?? null;
      let result;
      if (automation?.id) {
        const { data, error: upErr } = await supabase
          .from("automations")
          .update(patch)
          .eq("id", automation.id)
          .select()
          .single();
        if (upErr) throw upErr;
        result = data;
      } else {
        const { data, error: insErr } = await supabase
          .from("automations")
          .insert({
            organization_id: orgId,
            template_id: template.id,
            enabled: false,
            ...patch,
          })
          .select()
          .single();
        if (insErr) throw insErr;
        result = data;
      }
      // Append voice-signal rows for any field that actually changed. Foundation
      // for Ennie learning operator voice over time — phrases added/dropped,
      // structural changes per save. Failure here is non-fatal (the save
      // already succeeded); just log so the editor doesn't roll back a real save.
      await appendEditHistory({
        orgId,
        templateId: template.id,
        userId: result?.last_edited_by ?? null,
        deltas: [
          subjectOverride !== prevSubject
            ? { field: "subject_override", previous_value: prevSubject, new_value: subjectOverride }
            : null,
          bodyOverride !== prevBody
            ? { field: "body_override", previous_value: prevBody, new_value: bodyOverride }
            : null,
        ].filter(Boolean),
      });
      setSuccess("Saved.");
      if (onSaved) onSaved(result);
    } catch (e) {
      setError(e?.message ?? "Save failed — try again");
    } finally {
      setSaving(false);
    }
  }

  // Foundation for Ennie voice-learning. Appends a row to automation_edits
  // per changed field. RLS allows org members to INSERT; nothing reads this
  // table today — turned on when Ennie integration ships for lifecycle
  // drafts or when marketing-draft-campaign reads lifecycle edits as voice
  // signal. Non-fatal: a failed history write doesn't fail the user's save.
  async function appendEditHistory({ orgId: oid, templateId, userId, deltas }) {
    if (!Array.isArray(deltas) || deltas.length === 0) return;
    try {
      const rows = deltas.map((d) => ({
        organization_id: oid,
        template_id: templateId,
        field: d.field,
        previous_value: d.previous_value,
        new_value: d.new_value,
        edited_by: userId,
      }));
      const { error: histErr } = await supabase.from("automation_edits").insert(rows);
      if (histErr) {
        // eslint-disable-next-line no-console
        console.warn("[AutomationEditor] history append failed:", histErr.message);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[AutomationEditor] history append threw:", e?.message);
    }
  }

  async function handleReset() {
    if (!automation?.id) {
      // No row to reset — just revert local editor state.
      setSubject(template.default_subject);
      setBody(template.default_body);
      setAttachmentIds([]);
      if (hasTiming) setTimingValue(String(defaultTiming));
      if (isReviewLink) setReviewLink("");
      return;
    }
    setResetting(true);
    setError(null);
    setSuccess(null);
    try {
      const prevSubject = automation?.subject_override ?? null;
      const prevBody = automation?.body_override ?? null;
      const resetPatch = { subject_override: null, body_override: null, attachment_ids: [] };
      if (hasTiming) resetPatch.timing_override = null;
      const { data, error: upErr } = await supabase
        .from("automations")
        .update(resetPatch)
        .eq("id", automation.id)
        .select()
        .single();
      if (upErr) throw upErr;
      setSubject(template.default_subject);
      setBody(template.default_body);
      setAttachmentIds([]);
      if (hasTiming) setTimingValue(String(defaultTiming));
      if (isReviewLink) setReviewLink("");
      // Reset is ALSO a voice signal — operator decided their custom version
      // wasn't right. Append rows for any field that had a non-null override.
      await appendEditHistory({
        orgId,
        templateId: template.id,
        userId: null,
        deltas: [
          prevSubject !== null ? { field: "subject_override", previous_value: prevSubject, new_value: null } : null,
          prevBody !== null ? { field: "body_override", previous_value: prevBody, new_value: null } : null,
        ].filter(Boolean),
      });
      setSuccess("Reset to template defaults.");
      if (onSaved) onSaved(data);
    } catch (e) {
      setError(e?.message ?? "Reset failed — try again");
    } finally {
      setResetting(false);
    }
  }

  async function handleSendTest() {
    if (!testEmail || !testEmail.includes("@")) {
      setError("Enter a valid email to send a test.");
      return;
    }
    setSendingTest(true);
    setError(null);
    setSuccess(null);
    try {
      // When a real camp/program is selected, send its id so the test resolves
      // real content. "" = sample data (or templates without a picker).
      const [srcType, srcId] = selectedSource ? selectedSource.split(":") : ["", ""];
      const { data, error: fnErr } = await supabase.functions.invoke(
        "lifecycle-automations-cron",
        {
          body: {
            mode: "test_send",
            organization_id: orgId,
            template_key: template.key,
            test_to_email: testEmail,
            // Use current editor state (not saved values) so the operator
            // tests what they're looking at right now.
            preview_subject: subject,
            preview_body: body,
            test_camp_session_id: srcType === "camp" ? srcId : null,
            test_program_id: srcType === "program" ? srcId : null,
            audience: audienceParam,
          },
        },
      );
      if (fnErr) throw fnErr;
      if (data?.ok === false) {
        throw new Error(data?.error ?? "Send failed");
      }
      setSuccess(`Test sent to ${testEmail}${isTwoAudience ? ` (${audience === "instructor" ? "instructor" : "families"} version)` : ""}. Check your inbox.`);
    } catch (e) {
      setError(e?.message ?? "Test send failed — try again");
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <div
      role="region"
      aria-label={`Edit ${template.display_name}`}
      style={{
        marginTop: 12, borderTop: `1px dashed ${RULE}`, paddingTop: 16,
      }}
    >
      {/* Body — inline expansion within the parent row. No drawer, no
          backdrop. The Edit button on the row owns the open/close toggle. */}
      <div style={{ padding: 0 }}>
          {/* Two-audience toggle (no_school_day) — preview + test either the
              family or the instructor version. Editable fields below are always
              the family copy; the instructor copy is a fixed tailored template. */}
          {isTwoAudience && (
            <div style={{ marginBottom: 16 }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Preview &amp; test as
              </span>
              <div style={{ display: "inline-flex", border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
                {[["parent", "Families"], ["instructor", "Instructor"]].map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setAudience(val)}
                    style={{
                      padding: "8px 16px", fontSize: 13, fontWeight: 600, border: "none",
                      cursor: "pointer", background: audience === val ? PURPLE : "#fff",
                      color: audience === val ? "#fff" : MUTED,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.4 }}>
                {audience === "instructor"
                  ? "Instructors get a fixed, tailored heads-up (not editable here). The preview and test below show that version."
                  : "The subject and message below are the family version. Instructors get a matching heads-up — flip the toggle to preview it."}
              </p>
            </div>
          )}
          {/* Subject */}
          <div style={{ marginBottom: 16 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
              Subject
            </span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{
                width: "100%", padding: "10px 12px", fontSize: 14, color: INK,
                border: `1px solid ${(subject || "").length > 78 ? WARN : RULE}`,
                borderRadius: 6, outline: "none", background: "#fff",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4, fontSize: 11, color: MUTED, lineHeight: 1.4 }}>
              <span style={{ flexShrink: 0, color: (subject || "").length > 78 ? WARN : (subject || "").length > 60 ? "#b8770b" : MUTED, fontWeight: (subject || "").length > 60 ? 600 : 400 }}>
                {(subject || "").length}{(subject || "").length > 78 ? " characters, most clients truncate at 78" : (subject || "").length > 60 ? " characters, Gmail truncates at ~60" : " characters"}
              </span>
            </div>
          </div>

          {/* Your review link — review_request only. The operator pastes their
              review URL here; we splice it into the body's link so they never
              touch HTML. Empty = the automation stays blocked from turning on. */}
          {isReviewLink && (
            <div style={{ marginBottom: 16 }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Your review link
              </span>
              <input
                type="url"
                value={reviewLink}
                onChange={(e) => handleReviewLinkChange(e.target.value)}
                placeholder="Paste your Google, Yelp, or Facebook review link"
                style={{
                  width: "100%", padding: "10px 12px", fontSize: 14, color: INK,
                  border: `1px solid ${reviewLink.trim() ? RULE : WARN}`,
                  borderRadius: 6, outline: "none", background: "#fff", boxSizing: "border-box",
                }}
              />
              <p style={{ margin: "4px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.4 }}>
                {reviewLink.trim()
                  ? <>We drop this into the message as a clickable link. Click <strong>Save</strong> below, then you can turn the automation on.</>
                  : <>Paste the link where families leave you a review. Until you add it, this automation can&apos;t be turned on.</>}
              </p>
            </div>
          )}

          {/* Body — toggle between rendered display (default) and markdown-ish
              edit mode. Operators never see raw HTML tags. Pattern mirrors
              the campaign BodyEditor in TouchpointCard.jsx. */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1 }}>
                Body
              </span>
              <button
                type="button"
                onClick={toggleBodyEdit}
                style={{
                  background: "transparent", border: "none", color: PURPLE,
                  cursor: "pointer", fontSize: 13, fontWeight: 600,
                }}
              >
                {editingBody ? "Done editing" : "Edit"}
              </button>
            </div>
            {editingBody ? (
              <>
                <textarea
                  ref={bodyTextareaRef}
                  value={editableText}
                  onChange={(e) => handleEditableChange(e.target.value)}
                  rows={14}
                  style={{
                    width: "100%", padding: "12px 14px", fontSize: 14, color: INK,
                    border: `1px solid ${RULE}`, borderRadius: 6, outline: "none",
                    background: "#fff", resize: "vertical", lineHeight: 1.55,
                    fontFamily: "inherit", boxSizing: "border-box",
                  }}
                />
                <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
                  Blank line = new paragraph. <strong>**text**</strong> = bold,
                  <em> _text_</em> = italic.
                  <span style={{ fontFamily: "ui-monospace, monospace" }}> [link text]({"{{register_url}}"})</span> = clickable link.
                </p>
              </>
            ) : (
              <div
                onClick={toggleBodyEdit}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); toggleBodyEdit(); } }}
                style={{
                  padding: "14px 16px", border: `1px solid ${RULE}`, borderRadius: 6,
                  background: "#fff", fontSize: 14, color: INK, lineHeight: 1.55,
                  cursor: "text",
                }}
                dangerouslySetInnerHTML={{ __html: highlightTokens(body) }}
              />
            )}
          </div>

          {/* Attachments — upload/pick files, insert a Download button, or attach the file */}
          <div style={{ marginBottom: 16 }}>
            <AttachmentPicker
              orgId={orgId}
              attachmentIds={attachmentIds}
              onChangeAttachmentIds={setAttachmentIds}
              onInsertToken={insertAttachmentToken}
              primaryColor={orgPrimaryColor || PURPLE}
            />
          </div>

          {/* Available tokens */}
          <div style={{ marginBottom: 24 }}>
            <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              Available tokens
            </span>
            {tokens.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: MUTED }}>None for this message.</p>
            ) : (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {tokens.map((t) => (
                    <code
                      key={t}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", `{{${t}}}`);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => {
                        // Click fallback: copy to clipboard so operators on touch
                        // devices or who don't realize chips drag can still grab
                        // the token.
                        if (typeof navigator !== "undefined" && navigator.clipboard) {
                          navigator.clipboard.writeText(`{{${t}}}`).catch(() => {});
                        }
                      }}
                      style={{
                        background: "#f5f4ee", color: PURPLE, padding: "3px 8px", borderRadius: 4,
                        fontSize: 12, fontFamily: "monospace", cursor: "grab",
                        userSelect: "none",
                      }}
                      title={`${PRE_RENDERED_HTML_TOKENS.has(t) ? "Pre-rendered HTML — drop into body where you want the block." : "Plain text — safe in body or attributes."} Drag into the body, or click to copy.`}
                    >
                      {`{{${t}}}`}
                    </code>
                  ))}
                </div>
                <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED }}>
                  Drag any token into the body where you want it, or click to copy.
                </p>
              </>
            )}
          </div>

          {/* Timing — for templates with an editable days_after or days_before offset */}
          {hasTiming && (
            <div style={{ marginBottom: 24 }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Timing
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, color: INK }}>Send this</span>
                <input
                  type="number"
                  min={1}
                  value={timingValue}
                  onChange={(e) => setTimingValue(e.target.value)}
                  onBlur={() => { if (timingValue === "" || Number(timingValue) < 1) setTimingValue(String(defaultTiming)); }}
                  style={{
                    width: 72, padding: "8px 10px", fontSize: 14, color: INK,
                    border: `1px solid ${RULE}`, borderRadius: 6, outline: "none",
                    background: "#fff", textAlign: "center",
                  }}
                />
                <span style={{ fontSize: 14, color: INK }}>days {timingIsBefore ? "before" : "after"} {timingAnchorLabel}.</span>
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED }}>
                {timingIsBefore
                  ? <>Default is {defaultTiming} days. Enough notice for families to plan, without being so early they forget.</>
                  : <>Default is {defaultTiming} days. Pick the point where families have felt the value but it&apos;s still fresh.</>}
              </p>
            </div>
          )}

          {/* Live preview */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 1 }}>
                Live preview · {showingServerPreview ? "real data" : "sample data"}
              </span>
              {previewLoading && (
                <span style={{ fontSize: 11, color: MUTED }}>Loading real data…</span>
              )}
              {previewError && !previewLoading && (
                <span style={{ fontSize: 11, color: WARN }}>Showing sample — {previewError}</span>
              )}
            </div>
            <iframe
              title="email preview"
              srcDoc={displayedPreviewHtml}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              style={{
                width: "100%", height: 480, border: `1px solid ${RULE}`, borderRadius: 12,
                background: "#fff",
              }}
            />
          </div>

          {/* Status banner */}
          {(error || success) && (
            <div
              role="alert"
              style={{
                marginTop: 12,
                padding: "10px 14px",
                borderRadius: 6,
                fontSize: 13,
                background: error ? "#fef2f2" : "#ecf6ec",
                color: error ? "#7c2d12" : OK,
                border: `1px solid ${error ? WARN : OK}`,
              }}
            >
              {error || success}
            </div>
          )}
        </div>

        {/* Action bar — sits below the editor content, no longer a fixed footer */}
        <div style={{ marginTop: 16, padding: "16px", borderTop: `1px solid ${RULE}`, background: "#fbfaf6", borderRadius: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Real-data test source picker — only for program-based templates */}
          {sourceType && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>
                Preview with real data from
              </label>
              {loadingSources ? (
                <span style={{ fontSize: 13, color: MUTED }}>Loading your camps & programs…</span>
              ) : testSources.length === 0 ? (
                <span style={{ fontSize: 13, color: MUTED }}>
                  No camps or programs yet — the test will use sample data.
                </span>
              ) : (
                <select
                  value={selectedSource}
                  onChange={(e) => setSelectedSource(e.target.value)}
                  style={{
                    padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`,
                    borderRadius: 6, outline: "none", background: "#fff", color: INK,
                  }}
                >
                  {testSources.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                  <option value="">Sample data (placeholder)</option>
                </select>
              )}
            </div>
          )}
          {!sourceType && (
            <div style={{ fontSize: 12, color: MUTED }}>
              This test uses sample data — its content isn't tied to one camp or program.
            </div>
          )}
          {/* Send test row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="test@example.com"
              style={{
                flex: 1, padding: "8px 12px", fontSize: 13,
                border: `1px solid ${RULE}`, borderRadius: 6, outline: "none",
                background: "#fff", color: INK,
              }}
            />
            <button
              type="button"
              onClick={handleSendTest}
              disabled={sendingTest || !testEmail}
              style={{
                background: "#fff", color: BRIGHT, border: `1px solid ${BRIGHT}`,
                padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                cursor: sendingTest || !testEmail ? "not-allowed" : "pointer",
                opacity: sendingTest || !testEmail ? 0.5 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {sendingTest ? "Sending…" : "Send test"}
            </button>
          </div>
          {/* Save / Reset row */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting || saving || !hasOverride}
              style={{
                background: "transparent", color: MUTED, border: "none",
                padding: "8px 12px", fontSize: 13, cursor: resetting || saving || !hasOverride ? "not-allowed" : "pointer",
                opacity: resetting || saving || !hasOverride ? 0.4 : 1,
              }}
              title={!hasOverride ? "No overrides to reset" : "Revert to template defaults"}
            >
              {resetting ? "Resetting…" : "Reset to default"}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              style={{
                background: dirty ? PURPLE : "#d6d3c8",
                color: "#fff", border: "none",
                padding: "8px 20px", borderRadius: 6, fontSize: 13, fontWeight: 700,
                cursor: saving || !dirty ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
    </div>
  );
}
