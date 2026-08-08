// Q2_Who — audience scope picker. Marketing tab is parent-only per the IA
// decision (partner + instructor comms moved to their own tabs), so the
// audience-type radio is gone; audience is always parents. Q2 is now just
// the scope picker.
//
// Auto-derive: when the user lands here from Q1 with filter.type='auto',
// Q2 resolves the scope from the picks and writes back the concrete filter
// so the rest of the pipeline never sees 'auto'.
//   - Programs picked → { type: 'school', school_ids: [picks' program_location_ids] }
//   - Camps picked    → { type: 'area', area: 'Hillsboro' } when picks resolve
//                       to one dominant area; otherwise master_list with notice
//   - Other / no picks → master_list
//
// `auto_derived: true` is set on the resolved filter so re-deriving on a Q1
// change is allowed. Once the operator manually picks a scope, that flag
// disappears and we leave their choice alone.
//
// Data sources (all org-scoped):
//   - schools  → program_locations (organization_id)
//   - areas    → distinct marketing_recipients.geo_segment for this org
//   - segments → distinct unnest(marketing_recipients.segments) for this org
//   - single   → simple typeahead against marketing_recipients name/email

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../../lib/supabase.js";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, OK, WARN } from "../../marketing/tokens.jsx";

const PARENT_SCOPES = [
  { value: "master_list", label: "Master list (everyone)" },
  { value: "school", label: "A specific school…" },
  { value: "area", label: "An area…" },
  { value: "tag", label: "A group / tag…" },
  { value: "person", label: "Just one person…" },
];

export default function Q2_Who({ inputs, setField, onNext, onBack, canNext }) {
  const { org } = useOutletContext() ?? {};
  const who = inputs.who;
  const what = inputs.what;
  const [autoDeriveState, setAutoDeriveState] = useState({ status: "idle", info: null });
  const deriveKeyRef = useRef(null);

  // Auto-derive scope from Q1 picks. For programs/camps modes, this ALWAYS
  // runs when Q1 picks change — Q2 audience must mirror Q1 catalog
  // (operator confirmed 2026-06-02: "Q2 areas = Q1 districts always").
  // Without this, drift accumulates: operator-edits-Q2 → Q1-changes-later →
  // stale audience with orphan areas (Portland audience but no Portland
  // camps) or under-derived areas (Q1 has Oregon City camps but Q2 missing).
  //
  // Operator can still NARROW within the auto-derived set (uncheck areas in
  // the multi-select). That narrowing survives Q1 NOT-changing — tracked via
  // filter.derived_from_picks_key. When picks key matches, we don't re-derive
  // so the operator's narrowing isn't overwritten on re-mount.
  //
  // For mode='other' (one-off), only run when filter.type='auto' (operator
  // has full audience freedom for one-offs).
  const picksKey = JSON.stringify({
    mode: what?.mode,
    pids: what?.program_ids ?? [],
    cids: what?.camp_session_ids ?? [],
  });
  useEffect(() => {
    if (!org?.id) return;
    const isOther = what?.mode === "other";
    if (isOther && who?.filter?.type !== "auto") return;
    // Already derived for THIS Q1 picks set? Bail — preserves operator narrowing.
    if (who?.filter?.derived_from_picks_key === picksKey) return;

    let alive = true;
    (async () => {
      setAutoDeriveState({ status: "loading", info: null });
      const resolved = await deriveScopeFromPicks(org.id, what);
      if (!alive) return;
      deriveKeyRef.current = picksKey;
      setAutoDeriveState({ status: "ready", info: resolved.info });
      setField("who", {
        audience: "parents",
        filter: { ...resolved.filter, auto_derived: true, derived_from_picks_key: picksKey },
      });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, picksKey]);

  function setParentsScope(type) {
    if (type === "master_list") {
      setField("who", { audience: "parents", filter: { type: "master_list", derived_from_picks_key: picksKey } });
      return;
    }
    const next = { type, derived_from_picks_key: picksKey };
    if (type === "school") next.school_ids = [];
    if (type === "area") next.areas = [];
    if (type === "tag") next.tags = [];
    if (type === "person") next.recipient_id = null;
    setField("who", { audience: "parents", filter: next });
  }

  function updateFilter(patch) {
    // Manual filter changes drop the auto_derived flag but PRESERVE
    // derived_from_picks_key so the narrowing survives re-mount / re-render
    // (until Q1 picks actually change, which triggers re-derive).
    const { auto_derived: _drop, ...rest } = who.filter;
    setField("who", { audience: "parents", filter: { ...rest, ...patch } });
  }

  return (
    <QuestionStep
      title="Who's this going to?"
      helper="Ennie picked an audience based on your catalog choices. Change it below if you want something different."
      onNext={onNext}
      onBack={onBack}
      canNext={canNext}
    >
      {/* Auto-derive banner: shows what we picked from Q1 and lets operator override */}
      {(who.filter?.auto_derived || who.filter?.type === "auto") && (
        <AutoScopeBanner state={autoDeriveState} filter={who.filter} what={what} />
      )}

      <div style={{ background: "#faf7ed", border: `1px solid #ece1bf`, borderRadius: 12, padding: 14, marginTop: who.filter?.auto_derived ? 12 : 0 }}>
        <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 600, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.6 }}>
          {who.filter?.auto_derived ? "Change scope" : "Who's it going to?"}
        </p>
        <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Scope</label>
        <select
          value={who.filter?.type === "auto" ? "master_list" : (who.filter?.type ?? "master_list")}
          onChange={(e) => setParentsScope(e.target.value)}
          style={{
            width: "100%", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 5,
            background: "#fff", fontSize: 13, fontFamily: "inherit", color: INK,
          }}
        >
          {PARENT_SCOPES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        {who.filter?.type === "master_list" && (
          <p style={{ margin: "8px 0 0", fontSize: 12, color: MUTED }}>
            All parents on your master list will be included.
          </p>
        )}
        {who.filter?.type === "school" && (
          <SchoolMultiSelect
            orgId={org?.id}
            selected={who.filter.school_ids ?? []}
            onChange={(school_ids) => updateFilter({ school_ids })}
            // Pass Q1 picks so the picker can dim schools where Q1 has no
            // content (visual constraint — operator can still check them but
            // gets a clear signal those parents won't see picked programs).
            programIds={what?.program_ids ?? []}
          />
        )}
        {who.filter?.type === "area" && (
          <AreaMultiSelect
            orgId={org?.id}
            selected={
              // Backward-compat: tolerate legacy single-area drafts.
              Array.isArray(who.filter.areas)
                ? who.filter.areas
                : (who.filter.area ? [who.filter.area] : [])
            }
            onChange={(areas) => updateFilter({ areas, area: undefined })}
            campSessionIds={what?.camp_session_ids ?? []}
          />
        )}
        {who.filter?.type === "tag" && (
          <TagMultiSelect
            orgId={org?.id}
            selected={who.filter.tags ?? []}
            onChange={(tags) => updateFilter({ tags })}
          />
        )}
        {who.filter?.type === "person" && (
          <PersonTypeahead
            orgId={org?.id}
            selectedId={who.filter.recipient_id ?? null}
            onChange={(recipient_id, label) => updateFilter({ recipient_id, recipient_label: label })}
          />
        )}
      </div>

      {/* Already-registered toggle. Only meaningful for programs/camps mode
          (one-off notes have nothing to dedup against). Gated by Enrops
          registration data — if there are 0 confirmed registrations for the
          picked programs, the toggle is disabled with coaching toward
          adopting Enrops registration. */}
      {(what?.mode === "programs" || what?.mode === "camps") && (
        <ExcludeAlreadyRegisteredToggle
          orgId={org?.id}
          what={what}
          checked={!!who.exclude_already_registered}
          onChange={(v) => setField("who", { ...who, exclude_already_registered: v })}
        />
      )}
    </QuestionStep>
  );
}

// ---------- Exclude-already-registered toggle ----------
// Queries the registrations table for the picked programs/camps. If there are
// confirmed registrations -> toggle enabled, shows the count that would be
// excluded. If zero -> disabled with a coaching link explaining why (likely
// the provider's registration isn't on Enrops, or no one's registered yet).
function ExcludeAlreadyRegisteredToggle({ orgId, what, checked, onChange }) {
  const [registeredCount, setRegisteredCount] = useState(null);
  const [excludableCount, setExcludableCount] = useState(0);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRegisteredCount(null);
    (async () => {
      const programIds = Array.isArray(what?.program_ids) ? what.program_ids : [];
      const campIds = Array.isArray(what?.camp_session_ids) ? what.camp_session_ids : [];
      if (programIds.length === 0 && campIds.length === 0) {
        if (alive) { setRegisteredCount(0); setExcludableCount(0); }
        return;
      }

      // Count confirmed registrations for the picked programs/camps. We don't
      // join to marketing_recipients yet because the toggle's gate logic only
      // needs "any Enrops registrations exist?". The actual exclusion happens
      // server-side at send time.
      let regQuery = supabase
        .from("registrations")
        .select("parent_id", { count: "exact", head: false })
        .eq("organization_id", orgId)
        .eq("status", "confirmed");
      if (programIds.length > 0 && campIds.length > 0) {
        regQuery = regQuery.or(`program_id.in.(${programIds.join(",")}),camp_session_id.in.(${campIds.join(",")})`);
      } else if (programIds.length > 0) {
        regQuery = regQuery.in("program_id", programIds);
      } else {
        regQuery = regQuery.in("camp_session_id", campIds);
      }
      const { data: regs } = await regQuery;
      if (!alive) return;
      const total = regs?.length ?? 0;
      setRegisteredCount(total);

      // For the inline "would exclude N" hint, count distinct recipients with
      // matching emails. Two-query approach is fine for v1.
      if (total > 0) {
        const parentIds = [...new Set((regs ?? []).map((r) => r.parent_id).filter(Boolean))];
        const { data: parents } = await supabase
          .from("parents")
          .select("email")
          .in("id", parentIds);
        const emails = (parents ?? []).map((p) => p.email?.toLowerCase()).filter(Boolean);
        if (emails.length > 0) {
          const { count: matched } = await supabase
            .from("marketing_recipients")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId)
            .in("email", emails);
          if (alive) setExcludableCount(matched ?? 0);
        } else {
          if (alive) setExcludableCount(0);
        }
      } else {
        setExcludableCount(0);
      }
    })();
    return () => { alive = false; };
  }, [orgId, what?.program_ids, what?.camp_session_ids, what?.mode]);

  const loading = registeredCount === null;
  const enabled = (registeredCount ?? 0) > 0;
  // Disable + uncheck if gate is closed
  useEffect(() => {
    if (!enabled && checked) onChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return (
    <div style={{
      marginTop: 12, padding: "12px 14px",
      background: enabled ? "#fff" : "#faf7ed",
      border: `1px solid ${enabled ? RULE : "#ece1bf"}`,
      borderRadius: 12,
    }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: enabled ? "pointer" : "not-allowed" }}>
        <input
          type="checkbox"
          checked={checked && enabled}
          disabled={!enabled || loading}
          onChange={(e) => onChange(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: enabled ? INK : MUTED }}>
            Skip parents already registered for these {what?.mode === "camps" ? "camps" : "programs"}
            {enabled && checked && excludableCount > 0 && (
              <span style={{ color: OK, fontWeight: 500 }}> · {excludableCount} will be excluded</span>
            )}
          </div>
          {loading && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Checking who's already in…</div>
          )}
          {!loading && enabled && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
              {/* Two real numbers in play and they aren't always equal:
                  - registeredCount: total parents with a confirmed registration
                  - excludableCount: how many of those are on your marketing list
                  When they match we say "10 parents..."; when they don't we
                  explain the gap so "10 registered / 7 excluded" doesn't read
                  like a bug. The non-list registrants aren't in this campaign's
                  audience anyway, so they're not actionable here either way. */}
              {registeredCount === excludableCount
                ? <>{registeredCount} parent{registeredCount === 1 ? "" : "s"} {registeredCount === 1 ? "has" : "have"} already registered for {what?.mode === "camps" ? "these camps" : "these programs"} through Enrops. Skipping them keeps your campaign from pushing an offer they already took.</>
                : <>{excludableCount} of your marketing-list parents {excludableCount === 1 ? "has" : "have"} already registered for {what?.mode === "camps" ? "these camps" : "these programs"} through Enrops — skipping them keeps your campaign from pushing an offer they already took. ({registeredCount - excludableCount} more registered but {(registeredCount - excludableCount) === 1 ? "isn't" : "aren't"} on your marketing list, so {(registeredCount - excludableCount) === 1 ? "they aren't" : "they aren't"} getting this campaign anyway.)</>
              }
            </div>
          )}
          {!loading && !enabled && (
            <div style={{ fontSize: 12, color: "#7a5510", marginTop: 2 }}>
              Available when registration runs through Enrops — we'll know who's already in, in real time. For Squarespace / external registration, we can't see who's signed up yet.
              {" "}
              <Link to="/admin/settings" style={{ color: PURPLE, fontWeight: 600 }}>Move registration to Enrops →</Link>
            </div>
          )}
        </div>
      </label>
    </div>
  );
}

// ---------- Auto-scope banner + derivation ----------
function AutoScopeBanner({ state, filter, what }) {
  if (state.status === "loading") {
    return (
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 14, marginBottom: 12, fontSize: 13, color: MUTED }}>
        Working out who this campaign should go to…
      </div>
    );
  }
  if (!state.info) return null;
  const { headline, sub, tone, items } = state.info;
  const borderColor = tone === "warn" ? "#ece1bf" : `${OK}55`;
  const bgColor = tone === "warn" ? "#FAEEDA" : "#EAF3DE";
  const accent = tone === "warn" ? WARN : OK;
  return (
    <div style={{ background: bgColor, border: `1px solid ${borderColor}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        Audience picked for you
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{headline}</div>
      {Array.isArray(items) && items.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {items.map((it) => (
            <span key={it.label} style={{
              fontSize: 12, fontWeight: 600, color: INK,
              padding: "3px 10px", borderRadius: 999,
              background: "#fff", border: `1px solid ${borderColor}`,
            }}>
              {it.label}{typeof it.count === "number" ? ` · ${it.count}` : ""}
            </span>
          ))}
        </div>
      )}
      {sub && <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>{sub}</div>}
    </div>
  );
}

// Resolves Q1 picks into a concrete Q2 filter. Returns { filter, info } where
// `filter` is what gets written to state and `info` is what the banner renders.
async function deriveScopeFromPicks(orgId, what) {
  if (!what || !what.mode) {
    return { filter: { type: "master_list" }, info: { headline: "Master list (everyone)", sub: "No picks yet.", tone: "ok" } };
  }

  if (what.mode === "programs" && (what.program_ids?.length ?? 0) > 0) {
    const { data } = await supabase
      .from("programs")
      .select("program_location_id, program_locations(name)")
      .in("id", what.program_ids);
    const schools = new Map();
    for (const r of data ?? []) {
      if (!r.program_location_id) continue;
      schools.set(r.program_location_id, r.program_locations?.name || "(unnamed school)");
    }
    const school_ids = [...schools.keys()];
    if (school_ids.length === 0) {
      return {
        filter: { type: "master_list" },
        info: { headline: "Master list (everyone)", sub: "Your picks don't link to schools — sending to the full list.", tone: "warn" },
      };
    }
    const names = [...schools.values()];
    return {
      filter: { type: "school", school_ids },
      info: {
        headline: `Parents at ${names.length} school${names.length === 1 ? "" : "s"}`,
        sub: "These were added from the programs you picked. Uncheck any below to skip — those parents won't get this email.",
        tone: "ok",
        items: names.map((label) => ({ label })),
      },
    };
  }

  if (what.mode === "camps" && (what.camp_session_ids?.length ?? 0) > 0) {
    // Derive area via each camp's location.district (NOT school_name —
    // camps run at parks / rec centers / libraries, not schools, so the
    // parent's school_name almost never matches a camp's location_name).
    const { data: camps } = await supabase
      .from("camp_sessions")
      .select("location_name, program_locations(district)")
      .neq("status", "cancelled")
      .in("id", what.camp_session_ids);
    const campsByDistrict = new Map();
    let untaggedCount = 0;
    for (const c of camps ?? []) {
      const d = c.program_locations?.district;
      if (!d) { untaggedCount++; continue; }
      campsByDistrict.set(d, (campsByDistrict.get(d) ?? 0) + 1);
    }
    if (campsByDistrict.size === 0) {
      return {
        filter: { type: "master_list" },
        info: {
          headline: "Master list (everyone)",
          sub: "Your picked camps' locations don't have a district set yet. Sending to the full list — set district on the location in Programs → Locations, or pick a specific area below.",
          tone: "warn",
        },
      };
    }

    // Cross-reference districts with recipient geo_segments to find areas that
    // actually have parents. A district with zero parents is useless to target.
    const districtList = [...campsByDistrict.keys()];
    const { data: recipients } = await supabase
      .from("marketing_recipients")
      .select("geo_segment")
      .eq("organization_id", orgId)
      .in("geo_segment", districtList);
    const parentsByArea = new Map();
    for (const r of recipients ?? []) {
      parentsByArea.set(r.geo_segment, (parentsByArea.get(r.geo_segment) ?? 0) + 1);
    }
    const areasWithParents = [...campsByDistrict.entries()].filter(([d]) => parentsByArea.has(d));

    if (areasWithParents.length === 0) {
      const districtSummary = districtList.slice(0, 3).join(", ");
      return {
        filter: { type: "master_list" },
        info: {
          headline: "Master list (everyone)",
          sub: `Your camps are in ${districtSummary}, but no parents in your list are tagged to those areas. Sending to the full list — or pick a specific area below.`,
          tone: "warn",
        },
      };
    }

    if (areasWithParents.length === 1) {
      const [area] = areasWithParents[0];
      const parents = parentsByArea.get(area) ?? 0;
      return {
        filter: { type: "area", areas: [area] },
        info: {
          headline: `Parents in ${area}`,
          sub: `This area was added from your picked camps. ${parents} parents here. Uncheck below to skip — those parents won't get this email.`,
          tone: "ok",
          items: [{ label: area, count: parents }],
        },
      };
    }

    // Multiple areas — pre-select ALL areas that have BOTH camps AND parents.
    // Operator scoped to the camps that match; the audience should mirror.
    // They can drop individual areas in Q2 if they want a narrower send.
    // (Was: pick the single top-camp area; that forced the operator to manually
    // re-add the other areas every time. Multi-select is the cleaner default.)
    const sorted = [...areasWithParents]
      .map(([d, campCount]) => ({ area: d, campCount, parents: parentsByArea.get(d) ?? 0 }))
      .sort((a, b) => b.campCount - a.campCount || b.parents - a.parents);
    const areaKeys = sorted.map((s) => s.area);
    const totalParents = sorted.reduce((n, s) => n + s.parents, 0);
    return {
      filter: { type: "area", areas: areaKeys },
      info: {
        headline: `Parents across ${sorted.length} areas`,
        sub: `These were added from your picked camps. ~${totalParents} parents across all of them. Uncheck any below to skip — those parents won't get this email.`,
        tone: "ok",
        items: sorted.map((s) => ({ label: s.area, count: s.parents })),
      },
    };
  }

  // mode='other' or no picks → master_list
  return {
    filter: { type: "master_list" },
    info: { headline: "Master list (everyone)", sub: "No catalog picks. Pick a scope below or stick with the full list.", tone: "ok" },
  };
}

// ---------- School multi-select ----------
function SchoolMultiSelect({ orgId, selected, onChange, programIds = [] }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  // Set of program_location_ids that Q1's picked programs run at. Schools
  // outside this set get visually dimmed — operator can still pick them,
  // but those parents won't see any of the picked programs in the email.
  const [coveredIds, setCoveredIds] = useState(null);
  const programIdsKey = programIds.join(",");
  useEffect(() => {
    if (!orgId || programIds.length === 0) { setCoveredIds(new Set()); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("programs")
        .select("program_location_id")
        .in("id", programIds);
      if (!alive) return;
      setCoveredIds(new Set((data ?? []).map((r) => r.program_location_id).filter(Boolean)));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, programIdsKey]);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);
    supabase
      .from("program_locations")
      .select("id, name, name_aliases")
      .eq("organization_id", orgId)
      .order("name")
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) setErr(error.message);
        else setRows(data ?? []);
      });
    return () => { alive = false; };
  }, [orgId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(needle));
  }, [rows, q]);

  function toggle(id) {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  }

  return (
    <ListWrap>
      <SearchInput value={q} onChange={setQ} placeholder="Search your schools…" />
      <AllNoneBar
        onAll={() => onChange((filtered ?? []).map((loc) => loc.id))}
        onNone={() => onChange([])}
      />
      <ListBody loading={!rows} error={err} empty={!err && rows && rows.length === 0 ? "No program_locations yet — add some in Programs." : null}>
        {(filtered ?? []).map((loc) => {
          const covered = coveredIds == null || coveredIds.size === 0 || coveredIds.has(loc.id);
          return (
            <CheckRow
              key={loc.id}
              checked={selected.includes(loc.id)}
              onChange={() => toggle(loc.id)}
              label={loc.name}
              aside={
                !covered
                  ? "no picks here"
                  : (loc.name_aliases?.length ? `${loc.name_aliases.length} alias${loc.name_aliases.length === 1 ? "" : "es"}` : "")
              }
              dim={!covered}
            />
          );
        })}
      </ListBody>
      <FooterCount n={selected.length} singular="school selected" plural="schools selected" />
    </ListWrap>
  );
}

// ---------- Area single-select (distinct geo_segment) ----------
// Multi-select. Camps frequently span 3+ cities (SU26 has Hillsboro,
// Beaverton, Cornelius, …) and the operator wants to email parents across
// the set. Changed 2026-06-02 from radio (single) to checkbox (multi).
// Inline "All / None" affordance — same shape as the instructor picker
// in admin/Schedule.jsx. Rendered above the checkbox list. Keeps the
// component visually consistent with other multi-selects we already ship.
function AllNoneBar({ onAll, onNone }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "8px 10px", borderBottom: "1px solid #e8e2d4", background: "#fafaf6" }}>
      <button type="button" onClick={onAll}
        style={{ background: "transparent", border: "1px solid #e8e2d4", color: "#674EE8", borderRadius: 4, padding: "3px 10px", fontFamily: "inherit", cursor: "pointer", fontWeight: 600, fontSize: 11 }}>
        All
      </button>
      <button type="button" onClick={onNone}
        style={{ background: "transparent", border: "1px solid #e8e2d4", color: "#6b6880", borderRadius: 4, padding: "3px 10px", fontFamily: "inherit", cursor: "pointer", fontWeight: 600, fontSize: 11 }}>
        None
      </button>
    </div>
  );
}

function AreaMultiSelect({ orgId, selected, onChange, campSessionIds = [] }) {
  const [areas, setAreas] = useState(null);
  const [err, setErr] = useState(null);
  // Set of area keys (geo_segment / district) that Q1's picked camps run in.
  // Areas outside this set get dimmed.
  const [coveredAreas, setCoveredAreas] = useState(null);
  const campIdsKey = campSessionIds.join(",");
  useEffect(() => {
    if (!orgId || campSessionIds.length === 0) { setCoveredAreas(new Set()); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("camp_sessions")
        .select("program_locations(district)")
        .neq("status", "cancelled")
        .in("id", campSessionIds);
      if (!alive) return;
      const dists = new Set();
      for (const r of data ?? []) {
        const d = r.program_locations?.district;
        if (d) dists.add(d);
      }
      setCoveredAreas(dists);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, campIdsKey]);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setAreas(null);
    setErr(null);
    // Paginate — was .limit(2000) which silently truncated rows for tenants
    // with > 2000 recipients (J2S has 2275). The cut-off slice may contain
    // ALL parents of a small area (Corbett's 23 parents got truncated 2026-06-02),
    // making that area invisible in the multi-select even though it has
    // real coverage.
    (async () => {
      const PAGE = 1000;
      const counts = new Map();
      for (let off = 0; ; off += PAGE) {
        const { data, error } = await supabase
          .from("marketing_recipients")
          .select("geo_segment")
          .eq("organization_id", orgId)
          .not("geo_segment", "is", null)
          .range(off, off + PAGE - 1);
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        if (!data || data.length === 0) break;
        for (const r of data) {
          if (!r.geo_segment) continue;
          counts.set(r.geo_segment, (counts.get(r.geo_segment) ?? 0) + 1);
        }
        if (data.length < PAGE) break;
        if (counts.size >= 5000) break; // sanity ceiling on distinct areas
      }
      if (!alive) return;
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      setAreas(sorted.map(([key, n]) => ({ key, count: n })));
    })();
    return () => { alive = false; };
  }, [orgId]);

  function toggle(key) {
    if (selected.includes(key)) onChange(selected.filter((x) => x !== key));
    else onChange([...selected, key]);
  }

  return (
    <ListWrap>
      <AllNoneBar
        onAll={() => onChange((areas ?? []).map((a) => a.key))}
        onNone={() => onChange([])}
      />
      <ListBody loading={!areas} error={err} empty={!err && areas && areas.length === 0 ? "No areas yet — tag recipients with geo_segment to use this filter." : null}>
        {(areas ?? []).map((a) => {
          const covered = coveredAreas == null || coveredAreas.size === 0 || coveredAreas.has(a.key);
          return (
            <CheckRow
              key={a.key}
              checked={selected.includes(a.key)}
              onChange={() => toggle(a.key)}
              label={a.key}
              aside={covered ? `${a.count} parents` : `${a.count} parents · no picks here`}
              dim={!covered}
            />
          );
        })}
      </ListBody>
      <FooterCount n={selected.length} singular="area selected" plural="areas selected" />
    </ListWrap>
  );
}

// ---------- Tag / group multi-select (distinct unnest of tags) ----------
// Operator-applied labels (e.g. membership tier), set when uploading contacts.
// Targets marketing_recipients.tags — the `segments` column is reserved for
// system markers (_internal_admin), so operator grouping lives on `tags`.
function TagMultiSelect({ orgId, selected, onChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);
    // Paginated so tenants with many recipients don't silently truncate.
    (async () => {
      const PAGE = 1000;
      const counts = new Map();
      for (let off = 0; ; off += PAGE) {
        const { data, error } = await supabase
          .from("marketing_recipients")
          .select("tags")
          .eq("organization_id", orgId)
          .not("tags", "is", null)
          .range(off, off + PAGE - 1);
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        if (!data || data.length === 0) break;
        for (const r of data) {
          for (const s of r.tags ?? []) {
            if (!s) continue;
            counts.set(s, (counts.get(s) ?? 0) + 1);
          }
        }
        if (data.length < PAGE) break;
        if (counts.size >= 5000) break;
      }
      if (!alive) return;
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      setRows(sorted.map(([key, n]) => ({ key, count: n })));
    })();
    return () => { alive = false; };
  }, [orgId]);

  function toggle(key) {
    if (selected.includes(key)) onChange(selected.filter((x) => x !== key));
    else onChange([...selected, key]);
  }

  return (
    <ListWrap>
      <AllNoneBar
        onAll={() => onChange((rows ?? []).map((s) => s.key))}
        onNone={() => onChange([])}
      />
      <ListBody loading={!rows} error={err} empty={!err && rows && rows.length === 0 ? "No groups or tags yet — add a “Group / tag” column when you upload contacts to use this filter." : null}>
        {(rows ?? []).map((s) => (
          <CheckRow
            key={s.key}
            checked={selected.includes(s.key)}
            onChange={() => toggle(s.key)}
            label={s.key}
            aside={`${s.count} parents`}
          />
        ))}
      </ListBody>
      <FooterCount n={selected.length} singular="group selected" plural="groups selected" />
    </ListWrap>
  );
}

// ---------- Person typeahead ----------
function PersonTypeahead({ orgId, selectedId, onChange }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!orgId || q.trim().length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const handle = setTimeout(() => {
      supabase
        .from("marketing_recipients")
        .select("id, parent_name, email, school_name")
        .eq("organization_id", orgId)
        .or(`parent_name.ilike.%${q}%,email.ilike.%${q}%,child_first_name.ilike.%${q}%`)
        .limit(8)
        .then(({ data }) => {
          if (!alive) return;
          setResults(data ?? []);
          setLoading(false);
        });
    }, 200);
    return () => { alive = false; clearTimeout(handle); };
  }, [orgId, q]);

  return (
    <ListWrap>
      <SearchInput value={q} onChange={setQ} placeholder="Type a name or email…" />
      <ListBody loading={loading} empty={q.trim().length < 2 ? "Type at least 2 characters to search." : results.length === 0 ? "No matches." : null}>
        {results.map((r) => (
          <button
            key={r.id}
            onClick={() => onChange(r.id, `${r.parent_name || r.email}`)}
            style={{
              width: "100%", textAlign: "left", padding: "8px 10px",
              border: "none", background: selectedId === r.id ? "#faf7ed" : "transparent",
              borderTop: `1px solid ${RULE}`, cursor: "pointer", fontFamily: "inherit",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
            }}
          >
            <span style={{ fontSize: 13, color: INK, minWidth: 0 }}>
              <strong>{r.parent_name || "(no name)"}</strong> · {r.email}
            </span>
            <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>
              {r.school_name || ""}
            </span>
          </button>
        ))}
      </ListBody>
    </ListWrap>
  );
}

// ---------- Shared bits ----------
function ListWrap({ children }) {
  return (
    <div style={{ marginTop: 8, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 6, overflow: "hidden" }}>
      {children}
    </div>
  );
}

function SearchInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%", border: "none", borderBottom: `1px solid ${RULE}`,
        padding: "8px 10px", fontSize: 13, fontFamily: "inherit", outline: "none", background: "#fff",
      }}
    />
  );
}

function ListBody({ loading, error, empty, children }) {
  if (loading) return <div style={{ padding: 12, fontSize: 12, color: MUTED }}>Loading…</div>;
  if (error) return <div style={{ padding: 12, fontSize: 12, color: "#b3261e" }}>Error: {error}</div>;
  if (empty) return <div style={{ padding: 12, fontSize: 12, color: MUTED }}>{empty}</div>;
  return <div style={{ maxHeight: 220, overflowY: "auto" }}>{children}</div>;
}

function CheckRow({ checked, onChange, label, aside, dim }) {
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
      borderTop: `1px solid ${RULE}`, cursor: "pointer",
      background: checked ? "#faf7ed" : "transparent",
      opacity: dim ? 0.55 : 1,
    }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span style={{ fontSize: 13, color: INK, flex: 1, fontStyle: dim ? "italic" : "normal" }}>{label}</span>
      {aside && <span style={{ fontSize: 11, color: dim ? "#b3261e" : MUTED }}>{aside}</span>}
    </label>
  );
}

function FooterCount({ n, singular, plural }) {
  if (n === 0) return null;
  return (
    <div style={{ padding: "6px 10px", fontSize: 11, color: MUTED, background: "#fafafa", borderTop: `1px solid ${RULE}` }}>
      {n} {n === 1 ? singular : plural}
    </div>
  );
}
