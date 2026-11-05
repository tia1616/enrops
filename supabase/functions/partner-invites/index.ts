// partner-invites - a host (partner) invites outside providers (spec v3 H4),
// and the daily reminders (day 3, day 7) and 30-day expiry.
//
// OFF until platform_settings 'partner_invites' is enabled (Arielle
// 2026-10-28: invites stay off for partners until end of winter). Every action
// refuses while it is off.
//
// Actions:
//   save | send  (a host_admin, signed in): POST { action, partner_id,
//                 emails: "one per line", business_name, message? }
//                 save = on the host's list only (state saved); send = email
//                 each address. Or { action: "send", invitation_id } to send
//                 one already saved.
//   remind       (daily cron, x-cron-secret = INVITES_SECRET): reminders on
//                 day 3 and day 7, expire after 30 days.
//
// The link carries a random token; only its SHA-256 is stored. The email is
// "{Host name} via enrops" from enrops's verified sender, replies to the
// inviting host admin (spec v3 H4).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { loadOrgBrand, encodeDisplayName } from "../_shared/orgBrand.ts";
import { renderInvite, reminderDue, parseEmails, type InviteKind } from "./inviteEmail.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUBLIC_SITE_URL = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://enrops.com").replace(/\/+$/, "");
const EXPIRES_DAYS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));

  const { data: enabled } = await supabase.rpc("partner_invites_enabled");
  if (enabled !== true) return json({ error: "Invitations are not open yet." }, 403);

  if (body?.action === "remind") {
    const secret = Deno.env.get("INVITES_SECRET");
    if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);
    return json(await remind(supabase), 200);
  }

  // Host actions: the caller must be a host_admin login of that partner.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await supabase.auth.getUser(jwt);
  const uid = userData?.user?.id;
  if (!uid) return json({ error: "Sign in first." }, 401);

  if (body?.action === "send" && typeof body?.invitation_id === "string") {
    const { data: inv } = await supabase.from("partner_invitations").select("*").eq("id", body.invitation_id).maybeSingle();
    if (!inv || inv.state !== "saved") return json({ error: "That invitation can't be sent." }, 400);
    const access = await hostAdmin(supabase, uid, inv.partner_id);
    if (!access) return json({ error: "Only a host admin can invite providers." }, 403);
    const sent = await sendOne(supabase, inv, "invite");
    return json({ ok: sent, sent: sent ? 1 : 0 }, sent ? 200 : 502);
  }

  // The email exactly as it would go, without sending (the admin email-preview
  // pattern: server-rendered subject + HTML). Host admin of that partner only.
  if (body?.action === "preview") {
    const pid = typeof body?.partner_id === "string" ? body.partner_id : null;
    const access = pid ? await hostAdmin(supabase, uid, pid) : null;
    if (!access) return json({ error: "Only a host admin can invite providers." }, 403);
    const brand = await loadOrgBrand(supabase, null);
    const { subject, html } = renderInvite(brand, {
      host_name: access.partner_name,
      inviter_name: access.contact_name,
      business_name_as_typed: String(body?.business_name ?? "").trim(),
      message: String(body?.message ?? "").trim() || null,
    }, `${PUBLIC_SITE_URL}/invite/preview`, "invite");
    return json({ subject, html, from: `${access.partner_name} via enrops`, reply_to: access.contact_email }, 200);
  }

  if (body?.action !== "save" && body?.action !== "send") return json({ error: "Unknown action." }, 400);
  const partnerId = typeof body?.partner_id === "string" ? body.partner_id : null;
  const emails = parseEmails(body?.emails);
  const name = String(body?.business_name ?? "").trim();
  const message = String(body?.message ?? "").trim() || null;
  if (!partnerId || !emails || !name || name.length > 120 || (message && message.length > 1000)) {
    return json({ error: "Add the business name and at least one valid email." }, 400);
  }
  const access = await hostAdmin(supabase, uid, partnerId);
  if (!access) return json({ error: "Only a host admin can invite providers." }, 403);

  const results: unknown[] = [];
  for (const email of emails) {
    const row = {
      partner_id: partnerId,
      from_organization_id: access.organization_id,
      invited_by_access_id: access.id,
      invited_by_user_id: uid,
      host_name: access.partner_name,
      inviter_name: access.contact_name,
      inviter_email: access.contact_email,
      invited_email: email,
      business_name_as_typed: name,
      message,
      state: "saved",
    };
    const { data: inv, error } = await supabase.from("partner_invitations").insert(row).select("*").single();
    if (error) { results.push({ email, error: error.message }); continue; }
    if (body.action === "save") { results.push({ email, state: "saved" }); continue; }
    const ok = await sendOne(supabase, inv, "invite");
    results.push({ email, state: ok ? "sent" : "saved", ...(ok ? {} : { error: "Couldn't send; it's saved on your list." }) });
  }
  await supabase.from("audit_events").insert({
    organization_id: access.organization_id, partner_id: partnerId, actor_user_id: uid, actor_role: "host_admin",
    action: body.action === "send" ? "invitation_sent" : "invitation_saved", subject_type: "partner_invitation",
    after: { business_name: name, emails },
  });
  return json({ ok: true, results }, 200);
});

async function hostAdmin(supabase: SupabaseClient, uid: string, partnerId: string) {
  const { data } = await supabase
    .from("partner_portal_access")
    .select("id, organization_id, role, partner:partners(partner_name, inactive), contact:partner_contacts(contact_name, contact_email)")
    .eq("auth_user_id", uid)
    .eq("partner_id", partnerId)
    .eq("role", "host_admin")
    .maybeSingle();
  if (!data || (data as any).partner?.inactive) return null;
  const d = data as any;
  return { id: d.id, organization_id: d.organization_id, partner_name: d.partner?.partner_name, contact_name: d.contact?.contact_name ?? null, contact_email: d.contact?.contact_email };
}

/** Email one invitation. A first send starts the 30 days. Each email carries its own link; all of them stay valid. */
async function sendOne(supabase: SupabaseClient, inv: any, kind: InviteKind, reminder?: 1 | 2): Promise<boolean> {
  const token = newToken();
  const link = `${PUBLIC_SITE_URL}/invite/${token}`;
  const brand = await loadOrgBrand(supabase, null);
  const { subject, html, text } = renderInvite(brand, inv, link, kind);
  const from = `${encodeDisplayName(`${inv.host_name} via enrops`)} <${brand.sender_email}>`;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from, to: inv.invited_email, reply_to: inv.inviter_email, subject, html, text, tags: [{ name: "type", value: "partner_invitation" }] }),
    });
    if (!resp.ok) { console.error(`[partner-invites] send failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`); return false; }
  } catch (e) {
    console.error("[partner-invites] send threw:", e);
    return false;
  }
  const now = new Date();
  // Keep every earlier link working: an older email may be the one clicked.
  const patch: Record<string, unknown> = { token_hashes: [...(inv.token_hashes ?? []), await sha256Hex(token)] };
  if (kind === "invite") {
    patch.state = "sent";
    patch.sent_at = now.toISOString();
    patch.expires_at = new Date(now.getTime() + EXPIRES_DAYS * 86_400_000).toISOString();
  }
  if (reminder === 1) patch.reminder_1_at = now.toISOString();
  if (reminder === 2) patch.reminder_2_at = now.toISOString();
  const { error } = await supabase.from("partner_invitations").update(patch).eq("id", inv.id);
  if (error) console.error(`[partner-invites] ${inv.id} sent but not recorded: ${error.message}`);
  return true;
}

async function remind(supabase: SupabaseClient) {
  const now = new Date();
  const { data: open } = await supabase.from("partner_invitations").select("*").in("state", ["sent", "opened"]);
  let reminded = 0, expired = 0;
  for (const inv of open ?? []) {
    if (inv.expires_at && new Date(inv.expires_at) < now) {
      await supabase.from("partner_invitations").update({ state: "expired" }).eq("id", inv.id);
      expired++;
      continue;
    }
    const due = inv.sent_at ? reminderDue(inv.sent_at, inv.reminder_1_at, inv.reminder_2_at, now) : null;
    if (due && await sendOne(supabase, inv, "reminder", due)) reminded++;
  }
  return { ok: true, reminded, expired };
}
