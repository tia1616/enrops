// ennie-recommend
//
// Picks Ennie's "next clear action" for a curriculum the operator just
// published. Returns one of a small set of recommendation variants based on
// the tenant's data state. Used by Phase 2 of the celebration screen.
//
// Variants:
//   1. schedule_first      -- org has 0 programs scheduled at all
//   2. copy_from_other     -- this curriculum has 0 programs, but the org
//                             has OTHER curricula already scheduled
//   3. marketing_email     -- this curriculum has programs scheduled AND
//                             there are paid registrations on OTHER programs
//   4. schedule_this       -- default fallback: schedule this curriculum
//
// Body: { curriculum_id }
// Auth: caller is platform_admin OR own/admin the curriculum's org.
// Response: { variant, headline, body, primary_cta, primary_cta_to, data? }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonOk(data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Caller = { userId: string; isPlatformAdmin: boolean; adminOrgIds: Set<string> };

async function verifyCaller(
  authHeader: string | null,
): Promise<
  | { ok: true; caller: Caller; userClient: SupabaseClient }
  | { ok: false; reason: string; status: number }
> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "Missing Authorization header", status: 401 };
  }
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResp, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userResp?.user) {
    return { ok: false, reason: "Invalid session", status: 401 };
  }
  const userId = userResp.user.id;

  const { data: paRow } = await userClient
    .from("platform_admins")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const isPlatformAdmin = !!paRow;

  const { data: orgRows } = await userClient
    .from("org_members")
    .select("organization_id, role, accepted_at")
    .eq("auth_user_id", userId)
    .in("role", ["owner", "admin"]);
  const adminOrgIds = new Set(
    (orgRows ?? [])
      .filter((r: { accepted_at: string | null }) => r.accepted_at)
      .map((r: { organization_id: string }) => r.organization_id),
  );

  return { ok: true, caller: { userId, isPlatformAdmin, adminOrgIds }, userClient };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  const auth = await verifyCaller(req.headers.get("Authorization"));
  if (!auth.ok) return jsonError(auth.reason, auth.status);
  const { caller } = auth;

  let body: { curriculum_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }
  if (!body.curriculum_id) return jsonError("curriculum_id is required");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: curr, error: curErr } = await admin
    .from("curricula")
    .select("id, name, organization_id, format")
    .eq("id", body.curriculum_id)
    .maybeSingle();
  if (curErr) return jsonError(`Couldn't load curriculum: ${curErr.message}`, 500);
  if (!curr) return jsonError("Curriculum not found", 404);

  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(curr.organization_id)) {
    return jsonError("You need admin/owner access to this organization", 403);
  }

  // Data state queries (all org-scoped):
  // - this_progs / this_camps: how many scheduled instances point to THIS curriculum
  // - other_progs / other_camps: how many scheduled instances are on OTHER curricula
  //   (used both for the "schedule first" check and the "copy from other" logic)
  // - other_curricula_with_schedule: names of OTHER curricula that have at least
  //   one scheduled program -- used to pick the example name in "copy from other"
  const [
    { count: thisProgs },
    { count: thisCamps },
    { count: otherProgs },
    { count: otherCamps },
    { count: unlinkedProgs },
    { count: unlinkedCamps },
    { data: otherCurriculaSample },
  ] = await Promise.all([
    admin.from("programs").select("id", { count: "exact", head: true })
      .eq("organization_id", curr.organization_id)
      .eq("curriculum_id", curr.id),
    admin.from("camp_sessions").select("id", { count: "exact", head: true })
      .eq("organization_id", curr.organization_id)
      .eq("curriculum_id", curr.id),
    admin.from("programs").select("id", { count: "exact", head: true })
      .eq("organization_id", curr.organization_id)
      .neq("curriculum_id", curr.id)
      .not("curriculum_id", "is", null),
    admin.from("camp_sessions").select("id", { count: "exact", head: true })
      .eq("organization_id", curr.organization_id)
      .neq("curriculum_id", curr.id)
      .not("curriculum_id", "is", null),
    admin.from("programs").select("id", { count: "exact", head: true })
      .eq("organization_id", curr.organization_id)
      .is("curriculum_id", null),
    admin.from("camp_sessions").select("id", { count: "exact", head: true })
      .eq("organization_id", curr.organization_id)
      .is("curriculum_id", null),
    admin.from("curricula").select("id, name")
      .eq("organization_id", curr.organization_id)
      .eq("status", "published")
      .neq("id", curr.id)
      .order("updated_at", { ascending: false })
      .limit(3),
  ]);

  const thisHasSchedule = (thisProgs ?? 0) + (thisCamps ?? 0) > 0;
  const orgHasOtherSchedule = (otherProgs ?? 0) + (otherCamps ?? 0) > 0;
  const unlinkedTotal = (unlinkedProgs ?? 0) + (unlinkedCamps ?? 0);
  const anchor = (otherCurriculaSample ?? [])[0];

  // Priority: when this curriculum has no linked schedule yet BUT the org has
  // unlinked programs/camp_sessions sitting in the library, the right next
  // action is almost always to LINK them rather than schedule fresh. The
  // title-match step misses cases like "LEGO Engineers: Superhero Edition"
  // vs "LEGO Superheroes" where the doc name differs from the offering name.
  if (!thisHasSchedule && unlinkedTotal > 0) {
    const parts: string[] = [];
    if ((unlinkedProgs ?? 0) > 0) parts.push(`${unlinkedProgs} unlinked program${unlinkedProgs === 1 ? "" : "s"}`);
    if ((unlinkedCamps ?? 0) > 0) parts.push(`${unlinkedCamps} unlinked camp session${unlinkedCamps === 1 ? "" : "s"}`);
    return jsonOk({
      variant: "link_existing",
      headline: `Already scheduled ${curr.name} somewhere?`,
      body: `Your library has ${parts.join(" and ")} that aren't linked to a curriculum yet. If ${curr.name} is one of them (maybe under a different name), open Schedule to update the curriculum on those rows. Otherwise, schedule it fresh.`,
      primary_cta: "Open schedule →",
      primary_cta_to: "/admin/schedule",
      data: { unlinked_programs: unlinkedProgs ?? 0, unlinked_camp_sessions: unlinkedCamps ?? 0 },
    });
  }

  if (!thisHasSchedule && !orgHasOtherSchedule) {
    return jsonOk({
      variant: "schedule_first",
      headline: "Let's schedule your first program.",
      body: `Most providers' next move after publishing ${curr.name} is to schedule it into a term. I'll have your registration page ready as soon as you do.`,
      primary_cta: "Schedule a program →",
      primary_cta_to: "/admin/schedule",
    });
  }

  if (!thisHasSchedule && orgHasOtherSchedule && anchor) {
    return jsonOk({
      variant: "copy_from_other",
      headline: `Schedule at the same locations as ${anchor.name}?`,
      body: `Most providers schedule new curricula at the same locations they're already running others. Want to copy a schedule from ${anchor.name}?`,
      primary_cta: "Copy schedule →",
      primary_cta_to: `/admin/schedule?copy_from=${anchor.id}&curriculum_id=${curr.id}`,
      data: { anchor_curriculum_id: anchor.id, anchor_curriculum_name: anchor.name },
    });
  }

  if (thisHasSchedule) {
    // If the org already has paid registrations on OTHER programs, marketing-
    // email variant. Otherwise default to scheduling more of this curriculum.
    const { count: paidRegs } = await admin
      .from("registrations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", curr.organization_id)
      .eq("status", "paid")
      .limit(1);

    if ((paidRegs ?? 0) > 0) {
      return jsonOk({
        variant: "marketing_email",
        headline: "Draft a marketing email about this curriculum?",
        body: `You've got paying families on other programs. Want me to draft a "we just added ${curr.name} to the lineup" email so they hear about it first?`,
        primary_cta: "Draft the email →",
        primary_cta_to: `/admin/marketing?new_campaign=1&curriculum_id=${curr.id}`,
      });
    }
  }

  // Default: this curriculum is published and the org is mid-stride. Encourage
  // scheduling this curriculum specifically.
  return jsonOk({
    variant: "schedule_this",
    headline: `Schedule ${curr.name} into a term?`,
    body: `One more step to register parents: schedule ${curr.name} at a location for an upcoming term.`,
    primary_cta: "Schedule it →",
    primary_cta_to: `/admin/schedule?curriculum_id=${curr.id}`,
  });
});
