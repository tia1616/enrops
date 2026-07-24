import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams, useOutletContext } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { districtFullName } from '../../lib/tenants.js';
import { useCart } from '../../context/CartContext.jsx';
import {
  formatMoney,
  formatEarlyBirdDate,
  LEGACY_PRICE_CENTS,
  isLegacyActive,
  VIP_PRICE_PER_TERM_CENTS,
  VIP_TOTAL_CENTS,
  basePriceForItem,
  standardPriceFor,
} from '../../lib/pricing.js';
import { formatTermLabel, termSeasonName, schoolYearTermsForFall } from '../../lib/terms.js';

// Tenant resolution: `org` (id, slug, name, active_registration_term, ...) is
// provided by PublicLayout via Outlet context (from the public_org_directory
// view). Page reads org.id / org.slug from there instead of hardcoding 'j2s'.
// The catalog term is per-org from org.active_registration_term — NOT hardcoded.
// Catch-all bucket for venues with no public district (private/charter schools,
// libraries, community sites). Keeps them on the reg page instead of hidden, and
// stops each one rendering as its own one-school "district".
const OTHER_DISTRICT = 'Other schools & sites';

// Week order for the recurring class schedule (day_of_week stored Title-Case).
const WEEKLY_DAY_ORDER = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

export default function Home() {
  const { org } = useOutletContext();
  const ORG_SLUG = org.slug;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // ?keep=1 means we arrived here from the wizard's "Add another child" flow.
  // Skip clearCart so the in-progress sibling registration keeps its parent + child 1 state.
  const keepCart = searchParams.get('keep') === '1';
  const { clearCart } = useCart();
  const [orgId, setOrgId] = useState(org?.id ?? null);
  const [branding, setBranding] = useState(null);
  const [schools, setSchools] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [vipBundles, setVipBundles] = useState({}); // fallProgramId -> { winter, spring }
  const [selectedDistrict, setSelectedDistrict] = useState('');
  const [selectedSchool, setSelectedSchool] = useState('');
  // Program id to scroll-to + highlight, set when arriving via a shared
  // per-program link (/<slug>?program=<id>).
  const [highlightProgram, setHighlightProgram] = useState('');
  const [weeklyClasses, setWeeklyClasses] = useState([]); // recurring class_schedule (outside-registration tenants), safe public view
  const [loading, setLoading] = useState(true);

  // Labels for the term the catalog is serving, derived from the org's own
  // active term — never hardcoded to a season. termLabel: "Winter 2027";
  // seasonName: "Winter". Both fall back to neutral wording if the org's term
  // code is missing or malformed, so the page degrades to vague rather than
  // to a confidently wrong season.
  const termLabel = formatTermLabel(org?.active_registration_term) || '';
  const seasonName = termSeasonName(org?.active_registration_term); // null when not a term code

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    load();
  }, [org?.id]);

  async function load() {
    if (!org?.id) {
      setLoading(false);
      return;
    }
    setOrgId(org.id);

    // Fetch branding (hero copy, colors, etc) — multi-tenant ready.
    // Any provider can customize these via org_branding row; defaults apply if blank.
    const { data: br } = await supabase
      .from('org_branding')
      .select('hero_headline, hero_subtext, banner_image_url')
      .eq('organization_id', org.id)
      .maybeSingle();
    setBranding(br);

    const { data: sc } = await supabase
      .from('program_locations')
      .select('id, name, district, address, organization_id')
      .eq('organization_id', org.id)
      .order('name');

    // The one term the catalog serves, per org. Every term-derived label on
    // this page reads from this same value, so the page can't claim one season
    // while listing another's programs.
    const catalogTerm = org.active_registration_term;

    const { data: pg } = await supabase
      .from('programs')
      .select('*')
      .eq('organization_id', org.id)
      .eq('term', catalogTerm)
      .eq('status', 'open')
      // Native programs (we run checkout) OR partner-run programs the operator
      // explicitly listed with a registration link (shown as a link-out, no checkout).
      .or('runs_own_registration.eq.false,and(runs_own_registration.eq.true,list_in_public_catalog.eq.true,external_registration_url.not.is.null)')
      .order('day_of_week');

    // Look up Winter/Spring matches for each fall program to determine VIP eligibility.
    // A fall program is VIP-eligible only if that school year's Winter AND Spring
    // exist at the same school + day.
    //
    // Gated on the open term being a FALL term (schoolYearTermsForFall returns
    // null otherwise): VIP sells a whole school year, which only makes sense
    // from its start. Without this gate, a Winter open term would match itself
    // as its own "winter" leg and render a 3-term bundle listing the same class
    // twice. Codes are derived from the open term, never hardcoded, so this
    // keeps working when the school year rolls over.
    const bundleTerms = schoolYearTermsForFall(catalogTerm);
    const bundles = {};
    if (pg && pg.length && bundleTerms) {
      const { data: futureTerms } = await supabase
        .from('programs')
        .select('*')
        .eq('organization_id', org.id)
        .eq('runs_own_registration', false) // don't bundle partner-run programs into a paid VIP offer
        .in('term', [bundleTerms.winter, bundleTerms.spring]);

      pg.forEach((fall) => {
        const winter = futureTerms?.find(
          (f) => f.term === bundleTerms.winter && f.program_location_id === fall.program_location_id && f.day_of_week === fall.day_of_week,
        );
        const spring = futureTerms?.find(
          (f) => f.term === bundleTerms.spring && f.program_location_id === fall.program_location_id && f.day_of_week === fall.day_of_week,
        );
        if (winter && spring) {
          bundles[fall.id] = { winter, spring };
        }
      });
    }

    // Recurring weekly classes for outside-registration tenants (no term/checkout).
    // Read from the anon-safe view (no coach email/notes). Only renders a section
    // when rows exist, so registration tenants (J2S) are unaffected.
    const { data: wc } = await supabase
      .from('class_schedule_public')
      .select('id, title, day_of_week, start_time, end_time, location_text, age_min, age_max, capacity')
      .eq('organization_id', org.id);

    setSchools(sc || []);
    setPrograms(pg || []);
    setVipBundles(bundles);
    setWeeklyClasses(wc || []);
    setLoading(false);
  }

  // Group the recurring classes by weekday for display.
  const weeklyByDay = useMemo(() => {
    const sorted = [...weeklyClasses].sort((a, b) =>
      ((WEEKLY_DAY_ORDER[a.day_of_week] ?? 9) - (WEEKLY_DAY_ORDER[b.day_of_week] ?? 9)) ||
      (a.start_time || '').localeCompare(b.start_time || ''));
    const groups = [];
    for (const c of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.day === c.day_of_week) last.items.push(c);
      else groups.push({ day: c.day_of_week, items: [c] });
    }
    return groups;
  }, [weeklyClasses]);

  // Only districts that have at least one school with an open program. Schools
  // with no district collect under a single "Other schools & sites" bucket
  // (sorted last) instead of vanishing or each becoming its own district.
  const activeDistricts = useMemo(() => {
    const schoolsWithPrograms = new Set(programs.map((p) => p.program_location_id));
    const districts = new Set();
    let hasOther = false;
    schools.forEach((s) => {
      if (!schoolsWithPrograms.has(s.id)) return;
      if (s.district) districts.add(s.district);
      else hasOther = true;
    });
    const sorted = [...districts].sort((a, b) =>
      districtFullName(a).localeCompare(districtFullName(b)),
    );
    if (hasOther) sorted.push(OTHER_DISTRICT);
    return sorted;
  }, [schools, programs]);

  const schoolsInDistrict = useMemo(() => {
    if (!selectedDistrict) return [];
    const withPrograms = new Set(programs.map((p) => p.program_location_id));
    return schools
      .filter((s) => withPrograms.has(s.id)
        && (selectedDistrict === OTHER_DISTRICT ? !s.district : s.district === selectedDistrict))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedDistrict, schools, programs]);

  const programsAtSchool = useMemo(() => {
    if (!selectedSchool) return [];
    return programs
      .filter((p) => p.program_location_id === selectedSchool)
      .sort((a, b) =>
        (a.day_of_week || '').localeCompare(b.day_of_week || ''),
      );
  }, [selectedSchool, programs]);

  // Deep link from a shared per-program link (/<slug>?program=<id>): auto-select
  // the class's district + school so its card renders, then flag it to highlight.
  // Guarded so it never fights a family who's already picked a school.
  useEffect(() => {
    const programId = searchParams.get('program');
    if (!programId || !programs.length || !schools.length || selectedSchool) return;
    const prog = programs.find((p) => p.id === programId);
    if (!prog) return; // not in the current catalog (e.g. a non-FA26 program) — show normal catalog
    const school = schools.find((s) => s.id === prog.program_location_id);
    if (!school) return;
    setSelectedDistrict(school.district || OTHER_DISTRICT);
    setSelectedSchool(school.id);
    setHighlightProgram(programId);
  }, [programs, schools, searchParams, selectedSchool]);

  // Once the highlighted card is in the DOM, scroll to it and fade the ring.
  useEffect(() => {
    if (!highlightProgram) return;
    const el = document.getElementById(`program-card-${highlightProgram}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightProgram(''), 3000);
    return () => clearTimeout(t);
  }, [highlightProgram, programsAtSchool]);

  function startRegistration(programId, isVip = false) {
    if (!keepCart) clearCart();
    const params = new URLSearchParams({ school: selectedSchool });
    if (programId) params.set('program', programId);
    if (isVip) params.set('vip', '1');
    navigate(`/${ORG_SLUG}/register?${params.toString()}`);
  }

  // Lean, enrops-branded registration for self-serve operators (everyone except
  // legacy J2S). No hardcoded J2S hero and no district->school picker: the org's
  // open programs render as a simple list straight to checkout, so a location-less
  // program is reachable. J2S (legacy_own_platform) keeps its existing page below.
  const isLeanReg = org?.instructor_pay_model !== 'legacy_own_platform';
  if (isLeanReg) {
    const openPrograms = programs || [];
    const leanCard = (hl) => ({
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      padding: '16px 18px', border: `1px solid ${hl ? '#5847C9' : '#e2dfd5'}`,
      borderRadius: 14, background: '#fff',
      boxShadow: hl ? '0 0 0 3px rgba(88,71,201,0.15)' : 'none',
    });
    const leanBtn = {
      flexShrink: 0, padding: '10px 18px', background: '#5847C9', color: '#fff',
      border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600,
      fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
    };
    return (
      <div style={{ minHeight: '100vh', background: '#F7F7FB', fontFamily: "'Poppins', system-ui, sans-serif", color: '#1a1a1a' }}>
        <div style={{ background: '#1C004F', color: '#fff', padding: '56px 20px 72px' }}>
          <div style={{ maxWidth: 820, margin: '0 auto' }}>
            <span style={{ display: 'inline-block', background: 'rgba(38,214,135,0.14)', border: '1px solid rgba(38,214,135,0.35)', color: '#26D687', borderRadius: 100, padding: '5px 14px', fontSize: 12, fontWeight: 600 }}>
              {termLabel ? `${termLabel} registration is open` : 'Registration is open'}
            </span>
            <h1 style={{ fontSize: 38, fontWeight: 700, lineHeight: 1.12, margin: '18px 0 12px' }}>
              {branding?.hero_headline || org?.name || 'Register today'}
            </h1>
            <p style={{ fontSize: 17, lineHeight: 1.6, color: 'rgba(255,255,255,0.82)', maxWidth: 560, margin: 0 }}>
              {branding?.hero_subtext || 'Pick a class below and sign your child up in under a minute.'}
            </p>
          </div>
        </div>
        <div style={{ maxWidth: 820, margin: '-40px auto 0', padding: '0 20px 64px' }}>
          <div style={{ background: '#fff', border: '1px solid #e2dfd5', borderRadius: 20, padding: '24px 22px', boxShadow: '0 8px 30px rgba(28,0,79,0.06)' }}>
            {loading ? (
              <div style={{ color: '#6b6b6b', padding: '24px 0', textAlign: 'center' }}>Loading classes&hellip;</div>
            ) : openPrograms.length === 0 ? (
              <div style={{ color: '#6b6b6b', padding: '24px 0', textAlign: 'center' }}>No open programs yet. Check back soon.</div>
            ) : (
              <>
                <h2 style={{ fontSize: 19, fontWeight: 700, margin: '2px 0 16px' }}>
                  {openPrograms.length === 1 ? '1 open program' : `${openPrograms.length} open programs`}
                </h2>
                <div style={{ display: 'grid', gap: 12 }}>
                  {openPrograms.map((p) => {
                    const timeStr = [p.start_time, p.end_time].filter(Boolean).join(' – ');
                    const meta = [`${p.day_of_week}s`, timeStr].filter(Boolean).join(' · ');
                    const hl = highlightProgram === p.id;
                    if (p.runs_own_registration) {
                      return (
                        <div key={p.id} id={`program-card-${p.id}`} style={leanCard(hl)}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 16 }}>{p.curriculum}</div>
                            <div style={{ fontSize: 13, color: '#6b6b6b', marginTop: 2 }}>{meta}</div>
                          </div>
                          <a href={p.external_registration_url} target="_blank" rel="noopener noreferrer" style={leanBtn}>Register &#8599;</a>
                        </div>
                      );
                    }
                    return (
                      <div key={p.id} id={`program-card-${p.id}`} style={leanCard(hl)}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 16 }}>{p.curriculum}</div>
                          <div style={{ fontSize: 13, color: '#6b6b6b', marginTop: 2 }}>
                            {meta}{meta ? ' · ' : ''}<span style={{ fontWeight: 600, color: '#1a1a1a' }}>{formatMoney(p.price_cents)}</span>
                          </div>
                        </div>
                        <button onClick={() => startRegistration(p.id, false)} style={leanBtn}>Register</button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <p style={{ textAlign: 'center', color: '#9B9FBB', fontSize: 12, marginTop: 18 }}>
            Powered by <a href="https://getenrops.com" style={{ color: '#5847C9', textDecoration: 'none', fontWeight: 600 }}>enrops</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-j2s-purple via-j2s-purple-dark to-j2s-purple pb-24 pt-16 text-white sm:pt-24">
        <div className="absolute inset-0 -z-0 opacity-30">
          <svg className="h-full w-full" preserveAspectRatio="none" viewBox="0 0 1200 600">
            <circle cx="1100" cy="100" r="220" fill="#F8A638" />
            <circle cx="200" cy="480" r="160" fill="#F8A638" opacity="0.5" />
          </svg>
        </div>
        <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-3xl">
            <span className="inline-block rounded-full bg-white/15 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white">
              {termLabel ? `${termLabel} registration is open` : 'Registration is open'}
            </span>
            <h1 className="mt-6 font-titan text-5xl leading-[1.05] tracking-tight sm:text-7xl">
              Future-Ready Skills.
              <br />
              Right After School.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/90 sm:text-xl">
              Hands-on coding, LEGO, game design, and robotics at 30+ Portland-area schools.
              Small groups, expert instructors, and a kid who can't wait for next week.
            </p>
            {isLegacyActive() && (
              <div className="mt-8 inline-flex items-center gap-3 rounded-xl border-2 border-j2s-orange bg-white/95 px-5 py-3 text-j2s-ink shadow-pop">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-j2s-orange font-titan text-white">
                  !
                </span>
                <div>
                  <p className="font-bold">
                    Early-bird: {formatMoney(LEGACY_PRICE_CENTS)} per class
                  </p>
                  <p className="text-sm text-j2s-ink/70">Through June 5 &mdash; all classes</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Weekly class schedule — only for outside-registration tenants that
          uploaded a class_schedule. Registration tenants (J2S) have none, so this
          renders nothing for them. Read-only "what's happening each week". */}
      {weeklyByDay.length > 0 && (
        <section className="relative -mt-16 pb-4">
          <div className="mx-auto max-w-4xl px-4 sm:px-6">
            <div className="rounded-3xl border border-j2s-purple/10 bg-white p-6 shadow-card sm:p-10">
              <h2 className="font-titan text-2xl text-j2s-ink sm:text-3xl">This week&rsquo;s schedule</h2>
              <p className="mt-2 text-sm text-j2s-ink/70">Our weekly classes, by day.</p>
              <div className="mt-6 space-y-6">
                {weeklyByDay.map((g) => (
                  <div key={g.day}>
                    <h3 className="font-bold uppercase tracking-widest text-xs text-j2s-purple">{g.day}</h3>
                    <ul className="mt-2 divide-y divide-j2s-purple/10">
                      {g.items.map((c) => {
                        const time = [c.start_time, c.end_time].filter(Boolean).join(' – ');
                        return (
                          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                            <span className="font-semibold text-j2s-ink">{c.title}</span>
                            <span className="text-sm text-j2s-ink/70">
                              {time}{c.location_text ? `${time ? ' · ' : ''}${c.location_text}` : ''}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Finder */}
      <section className={`relative pb-16 ${weeklyByDay.length > 0 ? 'pt-4' : '-mt-16'}`}>
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <div className="rounded-3xl border border-j2s-purple/10 bg-white p-6 shadow-card sm:p-10">
            <h2 className="font-titan text-2xl text-j2s-ink sm:text-3xl">
              {branding?.hero_headline || "Find your child's program"}
            </h2>
            <p className="mt-2 text-sm text-j2s-ink/70">
              {branding?.hero_subtext || 'Pick your district, then your school, then the class.'}
            </p>

            {/* Banner image — pulled from org_branding, templated for all providers */}
            {branding?.banner_image_url && (
              <div className="mt-6 overflow-hidden rounded-2xl">
                <img
                  src={branding.banner_image_url}
                  alt="Students in a Journey to STEAM class"
                  className="h-48 w-full object-cover sm:h-64"
                  loading="eager"
                />
              </div>
            )}

            {loading ? (
              <div className="mt-8 animate-pulse text-j2s-ink/50">Loading schools&hellip;</div>
            ) : (
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label-field">District</label>
                  <select
                    className="input-field"
                    value={selectedDistrict}
                    onChange={(e) => {
                      setSelectedDistrict(e.target.value);
                      setSelectedSchool('');
                    }}
                  >
                    <option value="">Select a district&hellip;</option>
                    {activeDistricts.map((d) => (
                      <option key={d} value={d}>
                        {districtFullName(d)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label-field">School</label>
                  <select
                    className="input-field"
                    value={selectedSchool}
                    onChange={(e) => setSelectedSchool(e.target.value)}
                    disabled={!selectedDistrict}
                  >
                    <option value="">
                      {selectedDistrict
                        ? 'Select a school…'
                        : 'Pick a district first'}
                    </option>
                    {schoolsInDistrict.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Program preview */}
            {selectedSchool && programsAtSchool.length > 0 && (
              <div className="mt-8 animate-fade-in space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-titan text-lg text-j2s-ink">
                    Open programs ({programsAtSchool.length})
                  </h3>
                </div>
                <div className="space-y-4">
                  {programsAtSchool.map((p) => {
                    // Partner-run, listed program: families register on the partner's
                    // site, so render a link-out card (no price, no VIP, no checkout).
                    if (p.runs_own_registration) {
                      return (
                        <div
                          key={p.id}
                          id={`program-card-${p.id}`}
                          className={`overflow-hidden rounded-2xl border bg-white shadow-card transition ${highlightProgram === p.id ? 'border-j2s-purple ring-2 ring-j2s-purple ring-offset-2' : 'border-j2s-purple/10'}`}
                        >
                          <div className="border-b border-j2s-purple/10 bg-j2s-purple-soft/40 px-5 py-4">
                            <p className="font-titan text-lg text-j2s-ink">{p.curriculum}</p>
                            {p.short_description && (
                              <p className="mt-1 text-sm text-j2s-ink/65 leading-snug">{p.short_description}</p>
                            )}
                            <p className="mt-1 text-sm text-j2s-ink/70">
                              {p.day_of_week}s · {p.start_time}{p.end_time && <>–{p.end_time}</>}
                              {p.grade_min != null && p.grade_max != null && (
                                <> · Grades {p.grade_min === 0 ? 'K' : p.grade_min}–{p.grade_max}</>
                              )}
                            </p>
                          </div>
                          <div className="px-5 py-4">
                            <p className="text-sm text-j2s-ink/70">
                              Registration for this program is handled by our partner.
                            </p>
                            <a
                              href={p.external_registration_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-3 inline-flex items-center gap-2 rounded-xl border-2 border-j2s-purple px-5 py-2.5 font-bold text-j2s-purple transition hover:bg-j2s-purple hover:text-white"
                            >
                              Register on the partner's site
                              <span aria-hidden="true">↗</span>
                            </a>
                          </div>
                        </div>
                      );
                    }
                    const bundle = vipBundles[p.id];
                    const vipEligible = !!bundle;
                    const fallPricing = basePriceForItem({ program: p, isVip: false });
                    const fallShowsEarlyBird = fallPricing.is_legacy;
                    const fallEarlyBirdLabel = fallPricing.early_bird_deadline
                      ? formatEarlyBirdDate(fallPricing.early_bird_deadline)
                      : null;
                    // VIP comparison: sum of standard (non-early-bird) prices across 3 terms,
                    // since different terms may have different session_count.
                    const standardTotal = vipEligible
                      ? standardPriceFor(p) + standardPriceFor(bundle.winter) + standardPriceFor(bundle.spring)
                      : standardPriceFor(p) * 3;
                    const vipSavings = standardTotal - VIP_TOTAL_CENTS;
                    return (
                      <div
                        key={p.id}
                        id={`program-card-${p.id}`}
                        className={`overflow-hidden rounded-2xl border bg-white shadow-card transition ${highlightProgram === p.id ? 'border-j2s-purple ring-2 ring-j2s-purple ring-offset-2' : 'border-j2s-purple/10'}`}
                      >
                        {/* Program header — #7: short description */}
                        <div className="border-b border-j2s-purple/10 bg-j2s-purple-soft/40 px-5 py-4">
                          <p className="font-titan text-lg text-j2s-ink">{p.curriculum}</p>
                          {p.short_description && (
                            <p className="mt-1 text-sm text-j2s-ink/65 leading-snug">
                              {p.short_description}
                            </p>
                          )}
                          <p className="mt-1 text-sm text-j2s-ink/70">
                            {p.day_of_week}s · {p.start_time}{p.end_time && <>–{p.end_time}</>}
                            {p.grade_min != null && p.grade_max != null && (
                              <>
                                {' '}· Grades {p.grade_min === 0 ? 'K' : p.grade_min}–
                                {p.grade_max}
                              </>
                            )}
                            {p.session_count && p.session_count !== 8 && (
                              <> · {p.session_count} sessions</>
                            )}
                          </p>
                        </div>

                        {/* Two-column pricing — #1: VIP on LEFT */}
                        <div className={`grid ${vipEligible ? 'sm:grid-cols-2' : ''}`}>

                          {/* VIP column (LEFT) — #10: purple tint + Most popular pill */}
                          {vipEligible && (
                            <div className="border-j2s-purple/10 bg-j2s-purple/[0.06] p-5 sm:border-r">
                              <span className="inline-block rounded-full bg-j2s-purple px-3 py-1 text-xs font-bold uppercase tracking-widest text-white">
                                Most popular
                              </span>
                              {/* #2: "All 3 Terms" */}
                              <p className="mt-3 font-titan text-xs uppercase tracking-widest text-j2s-purple-dark">
                                All 3 Terms
                              </p>
                              {/* #5: $240/term headline size */}
                              <p className="mt-2 font-titan text-2xl text-j2s-ink">
                                {formatMoney(VIP_PRICE_PER_TERM_CENTS).replace('.00', '')}
                                <span className="text-base font-nunito text-j2s-ink/60">/term</span>
                              </p>
                              <p className="mt-1 text-sm text-j2s-ink/70">
                                {formatMoney(VIP_TOTAL_CENTS)} total
                              </p>
                              {/* #4: "Save up to" badge */}
                              <span className="mt-2 inline-block rounded-full bg-j2s-orange px-3 py-1 text-xs font-bold text-white">
                                Save up to {formatMoney(vipSavings).replace('.00', '')}
                              </span>
                              {/* #8: Early-bird on both cards */}
                              {fallShowsEarlyBird && fallEarlyBirdLabel && (
                                <p className="mt-2 text-xs font-semibold text-j2s-orange-dark">
                                  Early-bird pricing ends {fallEarlyBirdLabel}
                                </p>
                              )}
                              {/* #6: "Your child's full school year:" */}
                              <p className="mt-3 text-xs font-semibold text-j2s-ink/60">
                                Your child's full school year:
                              </p>
                              <div className="mt-1 space-y-1 text-xs text-j2s-ink/80">
                                <p>
                                  <span className="font-bold">Fall:</span> {p.curriculum}
                                </p>
                                <p>
                                  <span className="font-bold">Winter:</span> {bundle.winter.curriculum}
                                </p>
                                <p>
                                  <span className="font-bold">Spring:</span> {bundle.spring.curriculum}
                                </p>
                              </div>
                              {/* #9: VIP = filled primary button */}
                              <button
                                onClick={() => startRegistration(p.id, true)}
                                className="btn-j2s-primary mt-4 w-full text-sm"
                              >
                                Lock in VIP spot →
                              </button>
                            </div>
                          )}

                          {/* Single-term column (RIGHT) */}
                          <div className="p-5">
                            {/* "<Season> only" reads as a contrast to the VIP all-terms
                                column; when it's the only option (no VIP bundle), drop
                                the "only". Season comes from the open term — when Winter
                                is open this must read "Winter", not "Fall". */}
                            <p className="font-titan text-xs uppercase tracking-widest text-j2s-ink/50">
                              {seasonName
                                ? (vipEligible ? `${seasonName} only` : seasonName)
                                : (vipEligible ? 'This term only' : 'This term')}
                            </p>
                            <div className="mt-2">
                              {fallShowsEarlyBird ? (
                                <>
                                  <p className="font-titan text-3xl text-j2s-orange-dark">
                                    {formatMoney(fallPricing.base_cents)}
                                  </p>
                                  <p className="text-xs text-j2s-ink/60 line-through">
                                    {formatMoney(fallPricing.standard_cents)}
                                  </p>
                                </>
                              ) : (
                                <p className="font-titan text-3xl text-j2s-purple">
                                  {formatMoney(fallPricing.base_cents)}
                                </p>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-j2s-ink/60">{termLabel}</p>
                            {/* #8: Early-bird on both cards */}
                            {fallShowsEarlyBird && fallEarlyBirdLabel && (
                              <p className="mt-2 text-xs font-semibold text-j2s-orange-dark">
                                Early-bird pricing ends {fallEarlyBirdLabel}
                              </p>
                            )}
                            {/* #9: Fall = outline/secondary button */}
                            <button
                              onClick={() => startRegistration(p.id, false)}
                              className="btn-j2s-secondary mt-4 w-full text-sm"
                            >
                              {seasonName
                                ? (vipEligible ? `Register for ${seasonName.toLowerCase()} only` : `Register for ${seasonName.toLowerCase()}`)
                                : (vipEligible ? 'Register for this term only' : 'Register')}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedSchool && programsAtSchool.length === 0 && (
              <div className="mt-8 rounded-xl bg-j2s-purple-soft p-6 text-center text-j2s-ink/70">
                No open programs at this school yet. Check back soon or{' '}
                <a
                  href="mailto:support@journeytosteam.com"
                  className="font-semibold text-j2s-purple hover:underline"
                >
                  reach out to us
                </a>
                .
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Programs teaser — removed. Registration page stays focused on the task:
          pick district → school → class. Providers will be able to add banner/welcome
          copy via org_branding in v1.1 if desired. */}
    </div>
  );
}
