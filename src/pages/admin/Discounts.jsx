// /admin/discounts — Money > Discounts tab.
//
// One home for the three ways an operator gives families a price break:
//   1. Promo codes    — customer-entered codes (this table's main content)
//   2. Sibling discount — automatic % off for additional children (org config)
//   3. Early-bird      — term-wide date-based pricing, set inline here per term
//
// Mirrors the category norm (Squarespace/Shopify "Discounts"; Sawyer/Jackrabbit).
// Money surface: owner/admin only (nav gates viewMoney; promo_codes + organizations
// RLS are admin-gated too). Multi-tenant: everything scoped by org from useOutletContext;
// no hardcoded tenant.
//
// This is the operator-facing CRUD only. Authoritative validation + re-pricing +
// usage-cap enforcement live server-side in the checkout path (later chunk). The
// per-org unique index (organization_id, upper(code)) WHERE active enforces
// no-duplicate-active-code at the DB; we surface its error in plain language.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { usePermissions } from "../../lib/permissions.js";
import { useAdminNarrow } from "../../lib/adminViewport.js";
import EnnieTip from "../../components/EnnieTip.jsx";
import { skipReasonLabel } from "../../lib/earlyBird.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const LAVENDER = "#F2F0FF";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

// timestamptz <-> date-input (YYYY-MM-DD). Store as UTC day boundaries so an
// "expires July 20" includes all of that day, matching the early-bird UTC gate.
const toDateInput = (ts) => (ts ? String(ts).slice(0, 10) : "");
const startOfDayUTC = (d) => (d ? `${d}T00:00:00Z` : null);
const endOfDayUTC = (d) => (d ? `${d}T23:59:59Z` : null);

const centsToDollars = (c) =>
  c == null ? "" : Number.isInteger(c / 100) ? String(c / 100) : (c / 100).toFixed(2);
const fmtDate = (d) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// Term code -> friendly label. "FA26" -> "Fall 2026". Falls back to the raw code.
const SEASONS = { FA: "Fall", WI: "Winter", SP: "Spring", SU: "Summer" };
// Calendar order within a year so terms sort chronologically across the school
// year: Winter(Jan) < Spring(Mar) < Summer(Jun) < Fall(Sep). Combined with the
// year, FA26 (2026) correctly precedes WI27/SP27 (2027).
const SEASON_MONTH = { WI: 0, SP: 1, SU: 2, FA: 3 };
function prettyTerm(t) {
  if (!t) return "Other";
  const m = /^([A-Za-z]{2})(\d{2})$/.exec(t.trim());
  if (!m || !SEASONS[m[1].toUpperCase()]) return t;
  return `${SEASONS[m[1].toUpperCase()]} 20${m[2]}`;
}
function termSortKey(t) {
  const m = /^([A-Za-z]{2})(\d{2})$/.exec((t || "").trim());
  if (!m || SEASON_MONTH[m[1].toUpperCase()] == null) return Number.MAX_SAFE_INTEGER; // unknown -> last
  return Number(m[2]) * 100 + SEASON_MONTH[m[1].toUpperCase()];
}

// (The per-program early-bird price used to be computed here as well as in SQL.
// It is now computed once, by apply_term_early_bird, and this screen renders what
// that call reports. src/lib/earlyBird.js holds the one copy the forms need.)

// Derive the badge an operator sees from the raw row + today.
function statusOf(c, now = new Date()) {
  if (!c.active) return { label: "Off", bg: "#f3f4f6", ink: "#6b7280" };
  if (c.starts_at && now < new Date(c.starts_at)) return { label: "Scheduled", bg: "#eff6ff", ink: "#1d4ed8" };
  if (c.expires_at && now > new Date(c.expires_at)) return { label: "Expired", bg: "#f3f4f6", ink: "#6b7280" };
  if (c.max_uses != null && (c.used_count ?? 0) >= c.max_uses) return { label: "Used up", bg: "#fef2f2", ink: "#991b1b" };
  return { label: "Active", bg: GREEN_BG, ink: GREEN_INK };
}

// Early-bird term badge. Honest about four things, in order: that it doesn't
// know yet, that the deadline has passed, that the term's programs disagree about
// the discount, and only then that it is simply on. "Off" is a claim, so it is
// never the answer while the lookup is still in flight.
function ebBadge(d) {
  if (d.loading) return { text: "Checking…", background: "#f3f4f6", color: "#6b7280" };
  if (!d.hasEb) return { text: "Off", background: "#f3f4f6", color: "#6b7280" };
  if (d.ended) return { text: "Ended", background: "#fef3c7", color: "#92400e" };
  if (d.mixed) return { text: "On · varies", background: GREEN_BG, color: GREEN_INK };
  return { text: "Early-bird on", background: GREEN_BG, color: GREEN_INK };
}

function describeValue(c) {
  if (c.discount_type === "percent") {
    return Number(c.discount_value) >= 100 ? "Free (100% off)" : `${Number(c.discount_value)}% off`;
  }
  return `$${centsToDollars(Math.round(Number(c.discount_value) * 100))} off`;
}

const blankDraft = () => ({
  id: null,
  code: "",
  discount_type: "percent",
  discount_value: "",
  active: true,
  starts_at: "",
  expires_at: "",
  max_uses: "",
  per_family_limit: "",
  min_subtotal: "",
  scope: "all", // "all" | "some"
  scope_program_ids: [],
});

export default function Discounts() {
  const { user, org } = useOutletContext();
  // PHONE: the promo-code list is a five-column grid, which at 347px gave each
  // column 27-37px. Stacks below the breakpoint.
  const narrow = useAdminNarrow();
  // Registration-only operators: sibling discounts and promo codes, no
  // term-wide early-bird pricing (later tier).
  const isLean = org?.instructor_pay_model === "enrops_platform";
  const perm = usePermissions();

  const [codes, setCodes] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [siblingPct, setSiblingPct] = useState("");
  const [siblingSaved, setSiblingSaved] = useState("");
  const [savingSibling, setSavingSibling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [draft, setDraft] = useState(null); // null = drawer closed
  // term -> what that term is currently offering, read from the database rather
  // than inferred from the program rows on screen. Inferring it was wrong in a
  // way nobody could see: a term whose only remaining early bird sat on a
  // CANCELLED class still badged "Early-bird on".
  const [offers, setOffers] = useState({});

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 3000); };

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      const [{ data: codeRows, error: cErr }, { data: progRows }, { data: orgRow }] = await Promise.all([
        supabase.from("promo_codes").select("*").eq("organization_id", org.id).order("created_at", { ascending: false }),
        supabase.from("programs").select("id, curriculum, term, price_cents, early_bird_price_cents, early_bird_deadline").eq("organization_id", org.id).order("term"),
        supabase.from("organizations").select("sibling_discount_pct").eq("id", org.id).single(),
      ]);
      if (cancelled) return;
      if (cErr) { setError(cErr.message ?? "Couldn't load your discounts."); setLoading(false); return; }
      setCodes(codeRows ?? []);
      setPrograms(progRows ?? []);
      const sp = orgRow?.sibling_discount_pct == null ? "" : String(orgRow.sibling_discount_pct);
      setSiblingPct(sp);
      setSiblingSaved(sp);
      setLoading(false);

      // One lookup per term the operator can see. Lean orgs don't get the
      // early-bird section at all, so they don't pay for these.
      if (isLean) return;
      const terms = Array.from(new Set((progRows ?? []).map((p) => p.term).filter(Boolean)));
      const results = await Promise.all(terms.map(async (t) => {
        const { data, error: oErr } = await supabase.rpc("term_early_bird_offer", {
          p_org: org.id, p_term: t,
        });
        // An offer we could not read is NOT "no offer". Left undefined so the
        // badge says it doesn't know, rather than confidently saying "Off" about
        // a term that has an early bird running.
        if (oErr) return [t, undefined];
        return [t, (Array.isArray(data) ? data[0] : data) ?? null];
      }));
      if (cancelled) return;
      setOffers(Object.fromEntries(results.filter(([, v]) => v !== undefined)));
    })();
    return () => { cancelled = true; };
  }, [org?.id, isLean]);

  // Re-read one term's offer after a write. Declared as a function so it is
  // hoisted above runTermEarlyBird, which calls it.
  async function loadOffer(term) {
    const { data, error: oErr } = await supabase.rpc("term_early_bird_offer", {
      p_org: org.id, p_term: term,
    });
    if (oErr) return;
    setOffers((m) => ({ ...m, [term]: (Array.isArray(data) ? data[0] : data) ?? null }));
  }

  const programName = useMemo(() => {
    const m = new Map();
    for (const p of programs) m.set(p.id, p.curriculum);
    return (id) => m.get(id) ?? "a program";
  }, [programs]);

  async function saveSibling() {
    const raw = siblingPct.trim();
    const n = raw === "" ? null : Number(raw);
    if (raw !== "" && (!Number.isFinite(n) || n < 0 || n > 100)) {
      setError("Sibling discount must be a percent between 0 and 100 (or blank to turn it off).");
      return;
    }
    setSavingSibling(true);
    setError("");
    const { error: e } = await supabase.from("organizations").update({ sibling_discount_pct: n }).eq("id", org.id);
    setSavingSibling(false);
    if (e) { setError(e.message ?? "Couldn't save the sibling discount."); return; }
    setSiblingSaved(raw);
    flash(n == null ? "Sibling discount turned off." : `Sibling discount set to ${n}%.`);
  }

  // Term-wide early-bird. discountType/value null => clear the term.
  //
  // dryRun asks the SAME function what it WOULD do and writes nothing. The count
  // on the Apply button, the list of programs it skips, and the write itself all
  // come from this one call, so the preview cannot promise something the apply
  // then doesn't do.
  //
  // Returns the per-program rows, or null on failure. Callers must distinguish
  // those: an empty array means "this term has no programs", null means "we don't
  // know" -- and showing "Apply to 0" for a failed lookup would read as a fact.
  async function runTermEarlyBird(term, discountType, value, deadline, { dryRun }) {
    const clearing = value == null;
    const { data, error: e } = await supabase.rpc("apply_term_early_bird", {
      p_org: org.id,
      p_term: term,
      p_discount_type: clearing ? null : discountType,
      p_discount_value: clearing ? null : Number(value),
      p_deadline: clearing ? null : deadline,
      p_dry_run: !!dryRun,
    });
    if (e) {
      // A dry run is a background refresh; shouting at the top of the page about
      // one would be noise the operator can't act on. The card says so instead.
      if (!dryRun) setError(e.message ?? "Couldn't apply early-bird pricing.");
      return null;
    }
    const rows = data ?? [];
    if (!dryRun) {
      // Sync local state from what the RPC REPORTS it wrote, not from re-running
      // the arithmetic here. Two spellings of one number is how the screen and
      // the database start disagreeing.
      const byId = new Map(rows.map((r) => [r.program_id, r]));
      setPrograms((list) => list.map((p) => {
        const r = byId.get(p.id);
        if (!r) return p;
        return {
          ...p,
          early_bird_price_cents: r.early_bird_cents,
          early_bird_deadline: r.early_bird_cents == null ? null : deadline,
        };
      }));
      // The term's badge is derived from the database, so re-read it rather than
      // guessing what the write did to it.
      loadOffer(term);
    }
    return rows;
  }

  async function saveDraft() {
    const d = draft;
    const code = d.code.trim().toUpperCase();
    if (!code) { setError("Enter a code."); return; }
    const val = Number(d.discount_value);
    if (!Number.isFinite(val) || val <= 0) { setError("Enter a discount amount greater than zero."); return; }
    if (d.discount_type === "percent" && val > 100) { setError("A percentage discount can't be more than 100%."); return; }
    if (d.starts_at && d.expires_at && d.expires_at < d.starts_at) { setError("The end date can't be before the start date."); return; }
    const maxUses = d.max_uses === "" ? null : parseInt(d.max_uses, 10);
    if (d.max_uses !== "" && (!Number.isInteger(maxUses) || maxUses < 1)) { setError("Total uses must be a whole number (1 or more), or blank for unlimited."); return; }
    const perFam = d.per_family_limit === "" ? null : parseInt(d.per_family_limit, 10);
    if (d.per_family_limit !== "" && (!Number.isInteger(perFam) || perFam < 1)) { setError("Per-family limit must be a whole number (1 or more), or blank for no limit."); return; }
    const minSub = d.min_subtotal === "" ? null : Math.round(Number(d.min_subtotal) * 100);
    if (d.min_subtotal !== "" && (!Number.isFinite(minSub) || minSub < 0)) { setError("Minimum cart must be a dollar amount, or blank for no minimum."); return; }

    const row = {
      organization_id: org.id,
      code,
      discount_type: d.discount_type,
      discount_value: val, // percent: whole percent; fixed: dollars (matches pricing.js)
      active: d.active,
      starts_at: startOfDayUTC(d.starts_at),
      expires_at: endOfDayUTC(d.expires_at),
      max_uses: maxUses,
      per_family_limit: perFam,
      min_subtotal_cents: minSub,
      scope_program_ids: d.scope === "some" ? (d.scope_program_ids.length ? d.scope_program_ids : null) : null,
    };
    if (d.scope === "some" && !d.scope_program_ids.length) { setError("Pick at least one program, or set it to apply to all programs."); return; }

    setError("");
    let res;
    if (d.id) {
      res = await supabase.from("promo_codes").update(row).eq("id", d.id).eq("organization_id", org.id).select().single();
    } else {
      res = await supabase.from("promo_codes").insert({ ...row, created_by: user?.id ?? null }).select().single();
    }
    if (res.error) {
      const msg = /promo_codes_org_code_active_uniq|duplicate key/i.test(res.error.message || "")
        ? `You already have an active code called "${code}". Turn that one off first, or pick a different code.`
        : res.error.message || "Couldn't save the code.";
      setError(msg);
      return;
    }
    // Update list in place.
    setCodes((list) => {
      const saved = res.data;
      const idx = list.findIndex((c) => c.id === saved.id);
      if (idx === -1) return [saved, ...list];
      const copy = list.slice(); copy[idx] = saved; return copy;
    });
    if (!d.id) {
      // Time-saved receipt (non-fatal): setting up a code by hand elsewhere ~15 min.
      supabase.from("time_saved_events").insert({
        organization_id: org.id,
        action_type: "promo_code_created",
        action_label: `Created discount code ${code}`,
        hours_saved: 0.25,
        related_entity_type: "promo_code",
        related_entity_id: res.data.id,
        created_by: user?.id ?? null,
      }).then(({ error: e }) => { if (e) console.warn("time_saved_events insert failed (non-fatal):", e.message); });
    }
    setDraft(null);
    flash(d.id ? "Code updated." : `Code "${code}" created.`);
  }

  async function toggleActive(c) {
    const { data, error: e } = await supabase.from("promo_codes")
      .update({ active: !c.active }).eq("id", c.id).eq("organization_id", org.id).select().single();
    if (e) {
      const msg = /promo_codes_org_code_active_uniq|duplicate key/i.test(e.message || "")
        ? `Can't turn "${c.code}" back on — another active code already uses that name.`
        : e.message;
      setError(msg); return;
    }
    setCodes((list) => list.map((x) => (x.id === c.id ? data : x)));
  }

  function openEdit(c) {
    setError("");
    setDraft({
      id: c.id,
      code: c.code,
      discount_type: c.discount_type,
      discount_value: String(c.discount_value),
      active: c.active,
      starts_at: toDateInput(c.starts_at),
      expires_at: toDateInput(c.expires_at),
      max_uses: c.max_uses == null ? "" : String(c.max_uses),
      per_family_limit: c.per_family_limit == null ? "" : String(c.per_family_limit),
      min_subtotal: c.min_subtotal_cents == null ? "" : centsToDollars(c.min_subtotal_cents),
      scope: c.scope_program_ids?.length ? "some" : "all",
      scope_program_ids: c.scope_program_ids ?? [],
    });
  }

  // Belt-and-suspenders: money surface. Nav also gates the route.
  if (!perm.canViewMoney) {
    return (
      <div style={{ maxWidth: 760 }}>
        <div style={{ padding: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, color: MUTED, fontSize: 14 }}>
          Discounts aren't available for your role.
        </div>
      </div>
    );
  }
  if (loading) return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;

  const siblingDirty = siblingPct.trim() !== siblingSaved.trim();

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ margin: "0 0 4px", color: PURPLE, fontSize: 28, fontWeight: 700 }}>Discounts</h1>
      <p style={{ margin: "0 0 20px", color: MUTED, fontSize: 14 }}>
        {isLean
          ? "Codes families type at checkout, plus your automatic sibling savings."
          : "Codes families type at checkout, plus your automatic sibling and early-bird savings."}
      </p>

      {error && <div style={{ marginBottom: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginBottom: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {/* Automatic discounts */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ ...cardTitle, display: "flex", alignItems: "center", gap: 7 }}>
          Sibling discount
          <EnnieTip title="Why offer a sibling discount?">
            A family with two children is deciding whether to sign up twice. A
            small automatic discount usually costs you less than losing that
            second registration.
          </EnnieTip>
        </div>
        <p style={cardBody}>Automatic % off each additional child in the same order. Blank turns it off.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ position: "relative", width: 100 }}>
            <input type="text" inputMode="decimal" value={siblingPct}
              onChange={(e) => setSiblingPct(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="Off" aria-label="Sibling discount percent"
              style={{ ...input, paddingRight: 24 }} />
            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: MUTED, fontSize: 14, pointerEvents: "none" }}>%</span>
          </div>
          <button type="button" onClick={saveSibling} disabled={savingSibling || !siblingDirty} style={primaryBtn(savingSibling || !siblingDirty)}>
            {savingSibling ? "Saving…" : siblingDirty ? "Save" : "Saved ✓"}
          </button>
        </div>
      </div>

      {/* Early-bird is a later-tier feature. Registration operators keep sibling
          discounts and promo codes; term-wide early-bird pricing is gated out
          rather than shown as something they can set. Hidden, not disabled — a
          greyed-out control still reads as a feature you have. */}
      {!isLean && <EarlyBirdSection programs={programs} offers={offers} onRun={runTermEarlyBird} />}

      {/* Promo codes */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: PURPLE, display: "flex", alignItems: "center", gap: 7 }}>
          Promo codes
          <EnnieTip title="What makes a promo code work?">
            Give each code a reason and an end date. Open-ended codes get passed
            around and quietly become your new price.
          </EnnieTip>
        </div>
        <button type="button" onClick={() => { setError(""); setDraft(blankDraft()); }} style={primaryBtn(false)}>+ New code</button>
      </div>

      {codes.length === 0 ? (
        <div style={{ padding: 28, background: PANEL, border: `1px dashed ${RULE}`, borderRadius: 12, color: MUTED, fontSize: 14, textAlign: "center" }}>
          No promo codes yet. Create one families can type at checkout — like a partner code or a launch promo.
        </div>
      ) : (
        <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, overflow: "hidden" }}>
          {codes.map((c, i) => {
            const st = statusOf(c);
            const scopeLabel = c.scope_program_ids?.length
              ? c.scope_program_ids.length === 1 ? programName(c.scope_program_ids[0]) : `${c.scope_program_ids.length} programs`
              : "All programs";
            const dateWindow = c.starts_at || c.expires_at
              ? `${c.starts_at ? fmtDate(toDateInput(c.starts_at)) : "now"} – ${c.expires_at ? fmtDate(toDateInput(c.expires_at)) : "no end"}`
              : "No date limit";
            return (
              // Five columns on a 347px phone gave each about 27-37px -
              // measured - so the code, its value and its usage all wrapped
              // into unreadable slivers. Stacks below the breakpoint; every
              // field already says what it is ("3 used", "10% off"), so no
              // labels are needed, unlike the tables elsewhere in this pass.
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1.4fr 1fr 1fr 1.2fr auto", gap: narrow ? 6 : 10, alignItems: narrow ? "start" : "center", padding: "12px 16px", borderTop: i ? `1px solid ${RULE}` : "none" }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK, letterSpacing: 0.3 }}>{c.code}</div>
                  <div style={{ fontSize: 12, color: MUTED }}>{scopeLabel}</div>
                </div>
                <div style={{ fontSize: 14, color: INK }}>{describeValue(c)}</div>
                <div style={{ fontSize: 13, color: MUTED }}>
                  {c.used_count ?? 0}{c.max_uses != null ? ` / ${c.max_uses}` : ""} used
                  {c.per_family_limit != null ? <div style={{ fontSize: 11 }}>{c.per_family_limit}/family</div> : null}
                </div>
                <div style={{ fontSize: 12, color: MUTED }}>{dateWindow}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: st.bg, color: st.ink }}>{st.label}</span>
                  <button type="button" onClick={() => toggleActive(c)} style={linkBtn}>{c.active ? "Turn off" : "Turn on"}</button>
                  <button type="button" onClick={() => openEdit(c)} style={linkBtn}>Edit</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ marginTop: 12, fontSize: 12, color: MUTED }}>
        {isLean
          ? "Codes apply on top of sibling savings."
          : "Codes apply on top of sibling and early-bird savings."}
      </p>

      {draft && (
        <DrawerForm
          draft={draft} setDraft={setDraft} programs={programs} error={error}
          onCancel={() => { setError(""); setDraft(null); }} onSave={saveDraft}
        />
      )}
    </div>
  );
}

function DrawerForm({ draft, setDraft, programs, error, onCancel, onSave }) {
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const isFree = draft.discount_type === "percent" && Number(draft.discount_value) >= 100;
  return (
    <div style={overlay} onClick={onCancel}>
      <div style={drawer} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 700, color: PURPLE, marginBottom: 4 }}>{draft.id ? "Edit code" : "New promo code"}</div>
        <p style={{ fontSize: 13, color: MUTED, marginTop: 0, marginBottom: 18 }}>Families type this at checkout to get the discount.</p>
        {error && <div style={{ marginBottom: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}

        <Field label="Code">
          <input type="text" value={draft.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            placeholder="SUMMER25" style={{ ...input, letterSpacing: 0.5, fontWeight: 600 }} />
        </Field>

        <Field label="Discount">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "inline-flex", border: `1.5px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
              {["percent", "fixed"].map((t) => (
                <button key={t} type="button" onClick={() => set({ discount_type: t })}
                  style={{ padding: "9px 14px", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit",
                    background: draft.discount_type === t ? BRIGHT : "#fff", color: draft.discount_type === t ? "#fff" : MUTED }}>
                  {t === "percent" ? "% off" : "$ off"}
                </button>
              ))}
            </div>
            <div style={{ position: "relative", width: 130 }}>
              {draft.discount_type === "fixed" && <span style={affixL}>$</span>}
              <input type="text" inputMode="decimal" value={draft.discount_value}
                onChange={(e) => set({ discount_value: e.target.value.replace(/[^0-9.]/g, "") })}
                placeholder={draft.discount_type === "percent" ? "10" : "25"}
                style={{ ...input, paddingLeft: draft.discount_type === "fixed" ? 22 : 12, paddingRight: draft.discount_type === "percent" ? 24 : 12 }} />
              {draft.discount_type === "percent" && <span style={affixR}>%</span>}
            </div>
          </div>
          {isFree && <div style={{ marginTop: 6, fontSize: 12, color: GREEN_INK }}>Families pay nothing — a free / scholarship code.</div>}
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Starts (optional)"><input type="date" value={draft.starts_at} onChange={(e) => set({ starts_at: e.target.value })} style={input} /></Field>
          <Field label="Ends (optional)"><input type="date" value={draft.expires_at} onChange={(e) => set({ expires_at: e.target.value })} style={input} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Total uses"><input type="text" inputMode="numeric" value={draft.max_uses} onChange={(e) => set({ max_uses: e.target.value.replace(/[^0-9]/g, "") })} placeholder="∞" style={input} /></Field>
          <Field label="Per family"><input type="text" inputMode="numeric" value={draft.per_family_limit} onChange={(e) => set({ per_family_limit: e.target.value.replace(/[^0-9]/g, "") })} placeholder="∞" style={input} /></Field>
          <Field label="Min. cart"><div style={{ position: "relative" }}><span style={affixL}>$</span><input type="text" inputMode="decimal" value={draft.min_subtotal} onChange={(e) => set({ min_subtotal: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="0" style={{ ...input, paddingLeft: 22 }} /></div></Field>
        </div>

        <Field label="Applies to">
          <div style={{ display: "flex", gap: 8, marginBottom: draft.scope === "some" ? 10 : 0 }}>
            {[["all", "All programs"], ["some", "Specific programs"]].map(([v, l]) => (
              <button key={v} type="button" onClick={() => set({ scope: v })}
                style={{ padding: "8px 14px", borderRadius: 8, border: `1.5px solid ${draft.scope === v ? BRIGHT : RULE}`, background: draft.scope === v ? LAVENDER : "#fff", color: draft.scope === v ? PURPLE : MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
            ))}
          </div>
          {draft.scope === "some" && (
            <div style={{ maxHeight: 180, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 8, padding: 8 }}>
              {programs.length === 0 ? <div style={{ fontSize: 13, color: MUTED, padding: 6 }}>No programs yet.</div> :
                programs.map((p) => {
                  const on = draft.scope_program_ids.includes(p.id);
                  return (
                    <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", fontSize: 13, color: INK, cursor: "pointer" }}>
                      <input type="checkbox" checked={on}
                        onChange={() => set({ scope_program_ids: on ? draft.scope_program_ids.filter((x) => x !== p.id) : [...draft.scope_program_ids, p.id] })} />
                      <span>{p.curriculum}{p.term ? <span style={{ color: MUTED }}> · {p.term}</span> : null}</span>
                    </label>
                  );
                })}
            </div>
          )}
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: INK, margin: "4px 0 20px", cursor: "pointer" }}>
          <input type="checkbox" checked={draft.active} onChange={(e) => set({ active: e.target.checked })} />
          Active (families can use it now)
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" onClick={onCancel} style={ghostBtn}>Cancel</button>
          <button type="button" onClick={onSave} style={primaryBtn(false)}>{draft.id ? "Save changes" : "Create code"}</button>
        </div>
      </div>
    </div>
  );
}

// Term-wide early-bird editor: one card per term. Each card sets a single
// deadline + a single discount ($ or % off standard) applied to every program
// in that term, with an expandable per-program price preview.
function EarlyBirdSection({ programs, offers, onRun }) {
  const terms = useMemo(() => {
    const map = new Map();
    for (const p of programs) {
      if (!map.has(p.term)) map.set(p.term, []);
      map.get(p.term).push(p);
    }
    // Chronological across the school year (Fall -> Winter -> Spring -> Summer).
    return Array.from(map.entries()).sort((a, b) => termSortKey(a[0]) - termSortKey(b[0]));
  }, [programs]);

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: PURPLE, marginBottom: 4 }}>Early-bird pricing</div>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 12px" }}>
        A lower price until a cutoff date, applied across a whole term.
      </p>
      {terms.length === 0 ? (
        <div style={{ padding: 20, background: PANEL, border: `1px dashed ${RULE}`, borderRadius: 12, color: MUTED, fontSize: 14 }}>
          No programs yet — add programs and their early-bird pricing shows up here by term.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {terms.map(([term, progs]) => (
            <EarlyBirdTermCard key={term} term={term} progs={progs}
              offer={offers[term]} onRun={onRun} />
          ))}
        </div>
      )}
    </div>
  );
}

function EarlyBirdTermCard({ term, progs, offer, onRun }) {
  // What the term is offering RIGHT NOW, as the database reads it. `offer` is
  // undefined while it loads (or if the lookup failed), null-ish fields when the
  // term's programs disagree about the discount -- three states, three sentences,
  // because "no early bird" and "we couldn't tell you" are not the same news.
  const derived = useMemo(() => {
    if (offer === undefined) return { loading: true, hasEb: false, ended: false, deadline: "", uniformOffDollars: "", mixed: false };
    const count = Number(offer?.program_count ?? 0);
    const deadline = toDateInput(offer?.deadline || "");
    const hasEb = count > 0;
    // A term can have an early bird AND no single description of it (two
    // different discounts, or two different end dates). Prefilling the boxes
    // from one of them would invite an Apply that silently overwrites the other.
    const mixed = hasEb && (offer?.discount_type == null || !deadline);
    const todayISO = new Date().toISOString().slice(0, 10);
    const ended = hasEb && !!deadline && deadline < todayISO;
    return {
      loading: false,
      hasEb,
      ended,
      mixed,
      deadline,
      programCount: count,
      type: offer?.discount_type ?? "fixed",
      uniformOffDollars:
        offer?.discount_value == null || mixed
          ? ""
          : String(Number(offer.discount_value)),
    };
  }, [offer]);

  const [deadline, setDeadline] = useState(derived.deadline);
  const [type, setType] = useState(derived.type ?? "fixed");
  const [value, setValue] = useState(derived.uniformOffDollars);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { ok: bool, text } — inline feedback at the card
  // The dry run: what Apply WOULD do, per program. undefined = not asked yet or
  // in flight; null = the lookup failed and we must not pretend to know.
  const [preview, setPreview] = useState(undefined);
  // The same rows mean two different things either side of an Apply -- "this is
  // what would happen" and "this is what happened" -- and a skipped row saying
  // "its early bird will be removed" after the removal has already happened is a
  // badge that outlived its state. One flag, so the tense follows the fact.
  const [applyDone, setApplyDone] = useState(false);

  const canApply = !!value && Number(value) > 0 && !!deadline;

  // Seed the boxes once the offer arrives. Guarded on `derived.loading` so an
  // operator who has started typing while it loads doesn't get overwritten --
  // and keyed on the offer itself so a re-read after Apply refreshes them.
  useEffect(() => {
    if (derived.loading) return;
    setDeadline(derived.deadline);
    setType(derived.type ?? "fixed");
    setValue(derived.uniformOffDollars);
  }, [derived.loading, derived.deadline, derived.type, derived.uniformOffDollars]);

  // Ask what Apply would do, whenever the three inputs make a real offer.
  // Debounced: this fires on every keystroke in the discount box.
  useEffect(() => {
    if (!canApply) { setPreview(undefined); return; }
    if (type === "percent" && Number(value) > 100) { setPreview(undefined); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const rows = await onRun(term, type, value, deadline, { dryRun: true });
      if (cancelled) return;
      setPreview(rows);
      setApplyDone(false); // a fresh proposal, not a result
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term, type, value, deadline, canApply, onRun]);

  const applied = preview?.filter((r) => !r.skip_reason) ?? null;
  const skipped = preview?.filter((r) => r.skip_reason) ?? null;

  async function apply() {
    if (!value || Number(value) <= 0) { setNote({ ok: false, text: "Enter a discount amount first." }); return; }
    if (type === "percent" && Number(value) > 100) { setNote({ ok: false, text: "A percentage can't be more than 100%." }); return; }
    if (!deadline) { setNote({ ok: false, text: "Pick an early-bird end date." }); return; }
    setBusy(true); setNote(null);
    const rows = await onRun(term, type, value, deadline, { dryRun: false });
    setBusy(false);
    if (!rows) { setNote({ ok: false, text: "Couldn't apply — see the message at the top." }); return; }
    setPreview(rows);
    setApplyDone(true);
    const got = rows.filter((r) => !r.skip_reason).length;
    const left = rows.length - got;
    // Counts, not "these": "8 of these" beats "these", and an operator who sees
    // 28 where they expected 34 needs the 6 named, which the list below does.
    setNote({
      ok: true,
      text: `Applied to ${got} ${prettyTerm(term)} program${got === 1 ? "" : "s"}` +
            (left ? `. ${left} skipped — see below.` : "."),
    });
  }
  async function turnOff() {
    setBusy(true); setNote(null);
    const rows = await onRun(term, null, null, null, { dryRun: false });
    setBusy(false);
    if (!rows) { setNote({ ok: false, text: "Couldn't turn it off — see the message at the top." }); return; }
    setValue("");
    setPreview(undefined);
    const cleared = rows.filter((r) => r.cleared).length;
    setNote({
      ok: true,
      text: `Early-bird turned off for ${prettyTerm(term)}` +
            (cleared ? ` — removed from ${cleared} program${cleared === 1 ? "" : "s"}.` : "."),
    });
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: PURPLE }}>
          {prettyTerm(term)}
          <span style={{ fontWeight: 500, color: MUTED, fontSize: 13 }}> · {progs.length} program{progs.length === 1 ? "" : "s"}</span>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, ...ebBadge(derived) }}>
          {ebBadge(derived).text}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, marginBottom: 5 }}>Ends</div>
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={{ ...input, width: 160 }} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, marginBottom: 5 }}>Discount off standard</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "inline-flex", border: `1.5px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
              {["fixed", "percent"].map((t) => (
                <button key={t} type="button" onClick={() => setType(t)}
                  style={{ padding: "9px 12px", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: type === t ? BRIGHT : "#fff", color: type === t ? "#fff" : MUTED }}>
                  {t === "fixed" ? "$ off" : "% off"}
                </button>
              ))}
            </div>
            <div style={{ position: "relative", width: 110 }}>
              {type === "fixed" && <span style={affixL}>$</span>}
              <input type="text" inputMode="decimal" value={value}
                onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder={type === "fixed" ? "10" : "5"}
                style={{ ...input, paddingLeft: type === "fixed" ? 22 : 12, paddingRight: type === "percent" ? 24 : 12 }} />
              {type === "percent" && <span style={affixR}>%</span>}
            </div>
          </div>
        </div>
        {/* The count is the DRY RUN's, never progs.length: it has to be the number
            this Apply will actually change. Until the dry run answers, the button
            says "Apply" rather than a number it would have to take back. */}
        <button type="button" onClick={apply} disabled={busy || !canApply} style={primaryBtn(busy || !canApply)}>
          {busy ? "Applying…" : applied ? `Apply to ${applied.length}` : "Apply"}
        </button>
        {derived.hasEb && (
          <button type="button" onClick={turnOff} disabled={busy} style={ghostBtn}>Turn off</button>
        )}
      </div>

      {note && (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600, color: note.ok ? GREEN_INK : "#991b1b" }}>
          {note.ok ? "✓ " : ""}{note.text}
        </div>
      )}
      {!derived.loading && !derived.hasEb && (
        <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
          Early-bird is off for this term. Enter a discount and an end date, then Apply to turn it on.
        </div>
      )}
      {derived.hasEb && derived.ended && !note && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#92400e" }}>
          Early-bird ended {fmtDate(derived.deadline)}. Families are paying standard price now — set a later end date and Apply to run it again.
        </div>
      )}
      {derived.hasEb && derived.mixed && !note && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#92400e" }}>
          These {derived.programCount} programs aren't all on the same early-bird deal, so there's no single
          discount to show here. Applying a discount below puts them all on the same one.
        </div>
      )}
      {derived.hasEb && !derived.ended && !derived.mixed && !canApply && !note && (
        <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
          Enter a discount and an end date, then Apply.
        </div>
      )}

      {/* The skipped programs, in the viewport, before Apply is pressed -- not
          hidden behind the expander. An operator who reads "Apply to 28" under a
          header saying "34 programs" needs the other 6 explained right there. */}
      {skipped && skipped.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
          <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>
            {skipped.length} {skipped.length === 1 ? "program isn't" : "programs aren't"} offered this early bird:
          </div>
          {skipped.map((r) => (
            <div key={r.program_id} style={{ display: "flex", gap: 6, flexWrap: "wrap", lineHeight: 1.7 }}>
              <span style={{ color: INK }}>{r.curriculum}</span>
              <span>— {skipReasonLabel(r.skip_reason)}</span>
              {r.cleared && (
                <span style={{ color: "#92400e", fontWeight: 600 }}>
                  {applyDone ? "(its early bird was removed)" : "(its early bird will be removed)"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {preview === null && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#991b1b" }}>
          Couldn't check which programs this applies to. Reload the page before applying.
        </div>
      )}

      <button type="button" onClick={() => setExpanded((x) => !x)} style={{ ...linkBtn, marginTop: 12 }}>
        {expanded ? "Hide prices" : "Preview prices"}
      </button>
      {expanded && (
        <div style={{ marginTop: 8, border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
          {/* Every row here comes from the dry run, so this list IS what Apply
              does -- prices and skips together. Before the dry run has answered,
              it falls back to the stored prices with no arrow, which is the
              honest "nothing proposed yet" state. */}
          {(preview ?? progs.map((p) => ({
            program_id: p.id, curriculum: p.curriculum, price_cents: p.price_cents,
            early_bird_cents: p.early_bird_price_cents, skip_reason: null,
          }))).map((r, i) => {
            const newPrice = r.early_bird_cents;
            return (
              <div key={r.program_id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "7px 12px", borderTop: i ? `1px solid ${RULE}` : "none", fontSize: 13 }}>
                <span style={{ color: INK }}>{r.curriculum}</span>
                <span style={{ color: MUTED }}>
                  ${centsToDollars(r.price_cents)}
                  {r.skip_reason
                    ? <span style={{ color: "#92400e" }}> · {skipReasonLabel(r.skip_reason)}</span>
                    : newPrice != null && <span style={{ color: GREEN_INK, fontWeight: 600 }}> → ${centsToDollars(newPrice)}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

const card = { background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 18 };
const cardTitle = { fontSize: 15, fontWeight: 700, color: PURPLE, marginBottom: 4 };
const cardBody = { fontSize: 13, color: MUTED, marginTop: 0, marginBottom: 12, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
const affixL = { position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: MUTED, fontSize: 14, pointerEvents: "none" };
const affixR = { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: MUTED, fontSize: 14, pointerEvents: "none" };
const linkBtn = { background: "none", border: "none", color: BRIGHT, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0 };
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
const ghostBtn = { padding: "9px 18px", background: "#fff", color: MUTED, border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };
const overlay = { position: "fixed", inset: 0, background: "rgba(28,0,79,0.28)", display: "flex", justifyContent: "flex-end", zIndex: 50 };
const drawer = { width: "min(520px, 94vw)", height: "100%", background: "#fff", padding: "28px 26px", overflowY: "auto", boxShadow: "-8px 0 24px rgba(0,0,0,0.12)" };
