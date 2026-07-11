// Central RBAC permission helper — single source of truth for the UI layer.
// Mirrors the DB helpers (can_edit_org / can_admin_org / can_handle_money /
// is_org_owner) and the edge-function tiers so all three layers agree.
//
// Roles: owner / admin / staff / viewer  (decisions 2026-06-24, money = Admin+).
//   owner  — everything, incl. transfer/delete org
//   admin  — everything except transfer/delete org (money + settings + team)
//   staff  — run programs/rosters/schedule/families/sends; NO money, NO settings/team
//   viewer — read-only; money-blind (no revenue/payouts/Stripe)
//
// Usage:
//   import { usePermissions } from "../../lib/permissions";
//   const perm = usePermissions();        // reads orgMember.role from AdminLayout context
//   if (perm.canHandleMoney) { ... }
// or, when you already have a role string:
//   import { getPermissions } from "../../lib/permissions";
//   const perm = getPermissions(role);

import { useOutletContext } from "react-router-dom";

const EDIT_ROLES = ["owner", "admin", "staff"];
const ADMIN_ROLES = ["owner", "admin"];

// Build the capability object from a role string. Unknown/null role = no access
// (default-deny), matching the DB helpers.
export function getPermissions(role) {
  const r = role ?? null;
  const isOwner = r === "owner";
  const canAdmin = ADMIN_ROLES.includes(r);   // settings, team, branding, Stripe
  const canEdit = EDIT_ROLES.includes(r);     // programs, rosters, schedule, families, sends
  const canHandleMoney = canAdmin;            // refunds, payroll/payouts (kept separate for future loosening)
  return {
    role: r,
    isOwner,
    isViewer: r === "viewer",
    isStaff: r === "staff",
    // capabilities
    canEdit,                 // create/edit operational data
    canSend: canEdit,        // marketing / family emails
    canHandleMoney,          // issue refunds, run payroll
    canViewMoney: canHandleMoney, // see Receivables/revenue, Payouts/Stripe
    canManageTeam: canAdmin, // invite/change/remove members
    canManageSettings: canAdmin, // org settings, branding, sending domain, Stripe/fees
    canTransferOrg: isOwner, // transfer ownership / delete org
    // generic gate
    can(action) {
      switch (action) {
        case "edit":
        case "send":
        case "reports":          // Class Reports = safety/compliance surface (staff+)
          return canEdit;
        case "money":
        case "refund":
        case "payroll":
        case "viewMoney":
          return canHandleMoney;
        case "settings":
        case "team":
        case "branding":
        case "stripe":
          return canAdmin;
        case "transferOrg":
          return isOwner;
        default:
          return false;
      }
    },
  };
}

// Hook: reads the signed-in member's role from AdminLayout's Outlet context.
export function usePermissions() {
  const ctx = useOutletContext() ?? {};
  return getPermissions(ctx.orgMember?.role);
}
