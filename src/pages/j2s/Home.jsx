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

// Tenant resolution: `org` (id, slug, name, ...) is provided by PublicLayout
// via Outlet context. Page reads org.id / org.slug from there instead of
// hardcoding 'j2s'. The FA26 term filter is still hardcoded here — separate
// backlog item to derive "current active term" from scheduling_cycles.
export default function J2SHome() {
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
  const [loading, setLoading] = useState(true);

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

    const { data: pg } = await supabase
      .from('programs')
      .select('*')
      .eq('organization_id', org.id)
      .eq('term', 'FA26')
      .eq('status', 'open')
      .order('day_of_week');

    // Look up Winter/Spring matches for each fall program to determine VIP eligibility.
    // A fall program is VIP-eligible only if WI27 AND SP27 exist at the same school + day.
    const bundles = {};
    if (pg && pg.length) {
      const { data: futureTerms } = await supabase
        .from('programs')
        .select('*')
        .eq('organization_id', org.id)
        .in('term', ['WI27', 'SP27']);

      pg.forEach((fall) => {
        const winter = futureTerms?.find(
          (f) => f.term === 'WI27' && f.program_location_id === fall.program_location_id && f.day_of_week === fall.day_of_week,
        );
        const spring = futureTerms?.find(
          (f) => f.term === 'SP27' && f.program_location_id === fall.program_location_id && f.day_of_week === fall.day_of_week,
        );
        if (winter && spring) {
          bundles[fall.id] = { winter, spring };
        }
      });
    }

    setSchools(sc || []);
    setPrograms(pg || []);
    setVipBundles(bundles);
    setLoading(false);
  }

  // Only districts that have at least one school with an open program
  const activeDistricts = useMemo(() => {
    const schoolsWithPrograms = new Set(programs.map((p) => p.program_location_id));
    const districts = new Set();
    schools.forEach((s) => {
      if (schoolsWithPrograms.has(s.id) && s.district) districts.add(s.district);
    });
    return [...districts].sort((a, b) =>
      districtFullName(a).localeCompare(districtFullName(b)),
    );
  }, [schools, programs]);

  const schoolsInDistrict = useMemo(() => {
    if (!selectedDistrict) return [];
    const withPrograms = new Set(programs.map((p) => p.program_location_id));
    return schools
      .filter((s) => s.district === selectedDistrict && withPrograms.has(s.id))
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

  function startRegistration(programId, isVip = false) {
    if (!keepCart) clearCart();
    const params = new URLSearchParams({ school: selectedSchool });
    if (programId) params.set('program', programId);
    if (isVip) params.set('vip', '1');
    navigate(`/${ORG_SLUG}/register?${params.toString()}`);
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
              Fall 2026 registration is open
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

      {/* Finder */}
      <section className="relative -mt-16 pb-16">
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
                        className="overflow-hidden rounded-2xl border border-j2s-purple/10 bg-white shadow-card"
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

                          {/* Fall Only column (RIGHT) */}
                          <div className="p-5">
                            {/* "Fall only" reads as a contrast to the VIP all-terms column;
                                when Fall is the only option (no VIP bundle), drop the "only". */}
                            <p className="font-titan text-xs uppercase tracking-widest text-j2s-ink/50">
                              {vipEligible ? 'Fall only' : 'Fall'}
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
                            <p className="mt-1 text-xs text-j2s-ink/60">Fall 2026</p>
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
                              {vipEligible ? 'Register for fall only' : 'Register for fall'}
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
                  href="mailto:info@journeytosteam.com"
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
