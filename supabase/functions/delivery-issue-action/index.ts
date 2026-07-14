// delivery-issue-action — operator actions on a failed lifecycle send from the
// "Didn't send" surfaces (Automations panel).
//
// Two actions, both gated to an owner/admin/staff of the failed row's org:
//   resend       — re-send the email that failed. We reuse the render pipeline
//                  that OWNS this email (lifecycle-automations-cron event mode)
//                  rather than duplicating it: map the recipient's context_key
//                  back to its confirmed registration, clear the retry cap so the
//                  cron treats it as un-sent, then invoke event mode for that one
//                  registration. If the program is still inside the welcome
//                  window it sends (and the recipient row flips to 'sent' via the
//                  cron's own upsert); if the program already started, event mode
//                  resolves an empty audience and we report not_in_window and
//                  leave the row untouched. This means NO edit to the hot
//                  lifecycle-cron file.
//   mark_handled — the operator dealt with it out of band (fixed the address,
//                  contacted the family). Stamp resolved_at/resolved_by so it
//                  drops off the panel, the homescreen card, and the alert email.
//                  The row stays status='failed' for the audit trail.
//
// Multi-tenant: the recipient row is loaded server-side by id; the caller must be
// an accepted org_member of THAT row's organization. No org id is trusted from
// the client beyond the recipient_id, and every downstream query is scoped to the
// row's organization_id.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders, json, adminClient } from "../_shared/instructor.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Body {
  action?: "resend" | "mark_handled";
  recipient_id?: string;
}

// context_key: camp:<csid>:parent:<pid>:student:<sid> | program:<pid>:parent:<pid>:student:<sid>[:suffix]
function parseContextKey(ck: string): { kind: "camp" | "program" | null; refId: string | null; studentId: string | null } {
  const p = (ck || "").split(":");
  if ((p[0] === "camp" || p[0] === "program") && p[2] === "parent" && p[4] === "student") {
    return { kind: p[0] as "camp" | "program", refId: p[1], studentId: p[5] };
  }
  return { kind: null, refId: null, studentId: null };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // ── auth: verify caller JWT ─────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "auth_required" }, 401);

    const supabase = adminClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "invalid_auth" }, 401);
    const callerAuthId = userData.user.id;

    // ── input ───────────────────────────────────────────────────────────────
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const action = body.action;
    const recipientId = body.recipient_id?.trim();
    if (action !== "resend" && action !== "mark_handled") return json({ error: "invalid_action" }, 400);
    if (!recipientId) return json({ error: "recipient_id_required" }, 400);

    // ── load the failed recipient row (authoritative, server-side) ──────────
    const { data: rec, error: recErr } = await supabase
      .from("automation_run_recipients")
      .select("id, organization_id, context_key, parent_id, status, attempts, resolved_at")
      .eq("id", recipientId)
      .maybeSingle();
    if (recErr) {
      console.error("[delivery-issue-action] recipient lookup failed:", recErr);
      return json({ error: "lookup_failed" }, 500);
    }
    if (!rec) return json({ error: "recipient_not_found" }, 404);
    if (rec.status !== "failed") return json({ error: "not_a_failed_send" }, 409);

    // ── auth scope: caller is owner/admin/staff on THIS row's org ───────────
    const { data: cm } = await supabase
      .from("org_members")
      .select("role")
      .eq("auth_user_id", callerAuthId)
      .eq("organization_id", rec.organization_id)
      .in("role", ["owner", "admin", "staff"])
      .not("accepted_at", "is", null)
      .maybeSingle();
    if (!cm) return json({ error: "forbidden" }, 403);

    // ── mark handled ────────────────────────────────────────────────────────
    if (action === "mark_handled") {
      if (rec.resolved_at) return json({ ok: true, action, already: true }); // idempotent
      const { error: updErr } = await supabase
        .from("automation_run_recipients")
        .update({ resolved_at: new Date().toISOString(), resolved_by: callerAuthId })
        .eq("id", recipientId);
      if (updErr) {
        console.error("[delivery-issue-action] mark_handled update failed:", updErr);
        return json({ error: "update_failed" }, 500);
      }
      return json({ ok: true, action });
    }

    // ── resend ──────────────────────────────────────────────────────────────
    // Map the recipient back to its confirmed registration.
    const pk = parseContextKey(rec.context_key);
    if (!pk.kind || !pk.refId || !pk.studentId) {
      return json({ ok: false, action, reason: "unsupported_context" });
    }
    const { data: reg } = await supabase
      .from("registrations")
      .select("id")
      .eq(pk.kind === "camp" ? "camp_session_id" : "program_id", pk.refId)
      .eq("student_id", pk.studentId)
      .eq("parent_id", rec.parent_id)
      .eq("organization_id", rec.organization_id)
      .eq("status", "confirmed")
      .maybeSingle();
    if (!reg) return json({ ok: false, action, reason: "registration_not_found" });

    // Claim the send by clearing the retry cap — but ONLY if this row is still an
    // un-resent failure. The conditional update is atomic, so a concurrent resend
    // (another admin, or the nightly cron) that already claimed it fails the
    // WHERE and we bail as in_progress instead of firing a duplicate welcome.
    const prevAttempts = rec.attempts ?? 0;
    const { data: claimed } = await supabase
      .from("automation_run_recipients")
      .update({ attempts: 0 })
      .eq("id", recipientId)
      .eq("status", "failed")
      .gt("attempts", 0)
      .select("id");
    if (!claimed || claimed.length === 0) {
      return json({ ok: false, action, reason: "in_progress" });
    }

    // Fire event mode for just this registration. The cron's own send + upsert
    // flips the row to 'sent' when it goes out.
    let sent = 0;
    let audience = 0;
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/lifecycle-automations-cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ registration_id: reg.id }),
      });
      const data = await resp.json().catch(() => null);
      for (const a of data?.summary?.automations ?? []) {
        sent += Number(a?.sent ?? 0);
        audience += Number(a?.audience ?? 0);
      }
    } catch (e) {
      console.error("[delivery-issue-action] event-mode invoke failed:", e);
    }

    if (sent >= 1) {
      return json({ ok: true, action, status: "sent" });
    }
    // Nothing sent. Restore the prior cap (honest state), and tell the operator
    // WHY: audience empty = the program is out of the welcome window; audience
    // present but sent=0 = the send was attempted and failed again (e.g. the
    // address is still bad).
    await supabase
      .from("automation_run_recipients")
      .update({ attempts: prevAttempts })
      .eq("id", recipientId)
      .eq("status", "failed");
    return json({ ok: false, action, reason: audience >= 1 ? "send_failed" : "not_in_window" });
  } catch (e) {
    console.error("[delivery-issue-action] unhandled:", e);
    return json({ error: "internal_error" }, 500);
  }
});
