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
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../../lib/supabase.js";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, OK, WARN } from "../../marketing/tokens.jsx";

const PARENT_SCOPES = [
  { value: "master_list", label: "Master list (everyone)" },
  { value: "school", label: "A specific school…" },
  { value: "area", label: "An area…" },
  // "segment" intentionally dropped 2026-06-01 — no segments built yet;
  // the underlying multi-select component stays in this file for when
  // segments come back. Add the option back here to re-expose.
  { value: "person", label: "Just one person…" },
];

export default function Q2_Who({ inputs, setField, onNext, onBack, canNext }) {
  const { org } = useOutletContext() ?? {};
  const who = inputs.who;
  const what = inputs.what;
  const [autoDeriveState, setAutoDeriveState] = useState({ status: "idle", info: null });
  const deriveKeyRef = useRef(null);

  // Auto-derive scope from Q1 picks when filter.type='auto'. Runs on mount and
  // whenever the picks change AS LONG AS the user hasn't manually overridden
  // (auto_derived flag still set).
  useEffect(() => {
    if (!org?.id) return;
    const isAuto = who?.filter?.type === "auto" || who?.filter?.auto_derived === true;
    if (!isAuto) return;

    // Key the derive on the picks signature so we don't redundantly re-fetch.
    // We mark the key as "done" AFTER the async resolves, not before — otherwise
    // React StrictMode's double-mount tears down the first effect (sets alive=false)
    // before the IIFE finishes, then the second mount sees the key already set and
    // bails early, leaving the loading state stuck forever.
    const key = JSON.stringify({
      mode: what?.mode,
      pids: what?.program_ids ?? [],
      cids: what?.camp_session_ids ?? [],
    });
    if (deriveKeyRef.current === key) return;

    let alive = true;
    (async () => {
      setAutoDeriveState({ status: "loading", info: null });
      const resolved = await deriveScopeFromPicks(org.id, what);
      if (!alive) return;
      deriveKeyRef.current = key; // mark complete only after successful resolve
      setAutoDeriveState({ status: "ready", info: resolved.info });
      setField("who", {
        audience: "parents",
        filter: { ...resolved.filter, auto_derived: true },
      });
    })();
    return () => { alive = false; };
  }, [org?.id, what?.mode, what?.program_ids, what?.camp_session_ids, who?.filter?.type, who?.filter?.auto_derived]);

  function setParentsScope(type) {
    if (type === "master_list") {
      setField("who", { audience: "parents", filter: { type: "master_list" } });
      return;
    }
    const next = { type };
    if (type === "school") next.school_ids = [];
    if (type === "area") next.area = "";
    if (type === "segment") next.segments = [];
    if (type === "person") next.recipient_id = null;
    setField("who", { audience: "parents", filter: next });
  }

  function updateFilter(patch) {
    // Manual filter changes drop the auto_derived flag so re-deriving stops
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

      <div style={{ background: "#faf7ed", border: `1px solid #ece1bf`, borderRadius: 8, padding: 14, marginTop: who.filter?.auto_derived ? 12 : 0 }}>
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
          />
        )}
        {who.filter?.type === "area" && (
          <AreaSelect
            orgId={org?.id}
            selected={who.filter.area ?? ""}
            onChange={(area) => updateFilter({ area })}
          />
        )}
        {who.filter?.type === "segment" && (
          <SegmentMultiSelect
            orgId={org?.id}
            selected={who.filter.segments ?? []}
            onChange={(segments) => updateFilter({ segments })}
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
      borderRadius: 8,
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
              <a href="/admin/settings" style={{ color: PURPLE, fontWeight: 600 }}>Move registration to Enrops →</a>
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
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 14, marginBottom: 12, fontSize: 13, color: MUTED }}>
        Working out who this campaign should go to…
      </div>
    );
  }
  if (!state.info) return null;
  const { headline, sub, tone } = state.info;
  const borderColor = tone === "warn" ? "#ece1bf" : `${OK}55`;
  const bgColor = tone === "warn" ? "#FAEEDA" : "#EAF3DE";
  const accent = tone === "warn" ? WARN : OK;
  return (
    <div style={{ background: bgColor, border: `1px solid ${borderColor}`, borderRadius: 8, padding: 14, marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        Audience picked for you
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{headline}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{sub}</div>}
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
    const preview = names.slice(0, 3).join(", ");
    const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
    return {
      filter: { type: "school", school_ids },
      info: {
        headline: `Parents at ${names.length} school${names.length === 1 ? "" : "s"}: ${preview}${extra}`,
        sub: "Derived from the programs you picked. Change the scope below to override.",
        tone: "ok",
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
      return {
        filter: { type: "area", area },
        info: {
          headline: `Parents in ${area}`,
          sub: `Derived from your camps' location districts. ${parentsByArea.get(area) ?? 0} parents in this area. Change the scope below to override.`,
          tone: "ok",
        },
      };
    }

    // Multiple areas — pick the one with the most CAMPS (operator's signal
    // of where they want to focus), tie-breaking on parent count. Sorting by
    // parents alone was wrong — e.g. 1 camp in Portland (713 parents) would
    // beat 10 camps in Hillsboro (305 parents). Camp count reflects intent.
    const sorted = [...areasWithParents]
      .map(([d, campCount]) => ({ area: d, campCount, parents: parentsByArea.get(d) ?? 0 }))
      .sort((a, b) => b.campCount - a.campCount || b.parents - a.parents);
    const top = sorted[0];
    const others = sorted.slice(1, 4).map((s) => `${s.area} (${s.campCount} camp${s.campCount === 1 ? "" : "s"}, ${s.parents} parents)`).join(", ");
    return {
      filter: { type: "area", area: top.area },
      info: {
        headline: `Parents in ${top.area}`,
        sub: `Your camps span ${sorted.length} areas — picked ${top.area} (${top.campCount} camp${top.campCount === 1 ? "" : "s"} there, ${top.parents} parents). Other options: ${others}. Change below to pick one of those, or 'Master list' to send to all.`,
        tone: "ok",
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
function SchoolMultiSelect({ orgId, selected, onChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");

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
      <ListBody loading={!rows} error={err} empty={!err && rows && rows.length === 0 ? "No program_locations yet — add some in Programs." : null}>
        {(filtered ?? []).map((loc) => (
          <CheckRow
            key={loc.id}
            checked={selected.includes(loc.id)}
            onChange={() => toggle(loc.id)}
            label={loc.name}
            aside={loc.name_aliases?.length ? `${loc.name_aliases.length} alias${loc.name_aliases.length === 1 ? "" : "es"}` : ""}
          />
        ))}
      </ListBody>
      <FooterCount n={selected.length} singular="school selected" plural="schools selected" />
    </ListWrap>
  );
}

// ---------- Area single-select (distinct geo_segment) ----------
function AreaSelect({ orgId, selected, onChange }) {
  const [areas, setAreas] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setAreas(null);
    setErr(null);
    supabase
      .from("marketing_recipients")
      .select("geo_segment")
      .eq("organization_id", orgId)
      .not("geo_segment", "is", null)
      .limit(2000)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        const counts = new Map();
        for (const r of data ?? []) {
          if (!r.geo_segment) continue;
          counts.set(r.geo_segment, (counts.get(r.geo_segment) ?? 0) + 1);
        }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        setAreas(sorted.map(([key, n]) => ({ key, count: n })));
      });
    return () => { alive = false; };
  }, [orgId]);

  return (
    <ListWrap>
      <ListBody loading={!areas} error={err} empty={!err && areas && areas.length === 0 ? "No areas yet — tag recipients with geo_segment to use this filter." : null}>
        {(areas ?? []).map((a) => (
          <label
            key={a.key}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
              borderTop: `1px solid ${RULE}`, cursor: "pointer",
              background: selected === a.key ? "#faf7ed" : "transparent",
            }}
          >
            <input
              type="radio"
              name="area"
              checked={selected === a.key}
              onChange={() => onChange(a.key)}
            />
            <span style={{ fontSize: 13, color: INK, flex: 1 }}>{a.key}</span>
            <span style={{ fontSize: 11, color: MUTED }}>{a.count} parents</span>
          </label>
        ))}
      </ListBody>
    </ListWrap>
  );
}

// ---------- Segment multi-select (distinct unnest of segments) ----------
function SegmentMultiSelect({ orgId, selected, onChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);
    supabase
      .from("marketing_recipients")
      .select("segments")
      .eq("organization_id", orgId)
      .not("segments", "is", null)
      .limit(5000)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        const counts = new Map();
        for (const r of data ?? []) {
          for (const s of r.segments ?? []) {
            if (!s) continue;
            counts.set(s, (counts.get(s) ?? 0) + 1);
          }
        }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        setRows(sorted.map(([key, n]) => ({ key, count: n })));
      });
    return () => { alive = false; };
  }, [orgId]);

  function toggle(key) {
    if (selected.includes(key)) onChange(selected.filter((x) => x !== key));
    else onChange([...selected, key]);
  }

  return (
    <ListWrap>
      <ListBody loading={!rows} error={err} empty={!err && rows && rows.length === 0 ? "No saved segments yet — tag recipients to use this filter." : null}>
        {(rows ?? []).map((s) => (
          <CheckRow
            key={s.key}
            checked={selected.includes(s.key)}
            onChange={() => toggle(s.key)}
            label={<span style={{ fontFamily: "ui-monospace, monospace" }}>{s.key}</span>}
            aside={`${s.count} parents`}
          />
        ))}
      </ListBody>
      <FooterCount n={selected.length} singular="segment selected" plural="segments selected" />
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

function CheckRow({ checked, onChange, label, aside }) {
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
      borderTop: `1px solid ${RULE}`, cursor: "pointer",
      background: checked ? "#faf7ed" : "transparent",
    }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span style={{ fontSize: 13, color: INK, flex: 1 }}>{label}</span>
      {aside && <span style={{ fontSize: 11, color: MUTED }}>{aside}</span>}
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
