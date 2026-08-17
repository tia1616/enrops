import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams, useOutletContext, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useCart } from '../../context/CartContext.jsx';
import { isEmbedContext } from '../../layouts/PublicLayout.jsx';
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
import { programScheduleSummary, formatDayLabel } from '../../lib/programSchedule.js';
import { audienceLabel } from '../../lib/grades.js';
import { feeOnCents, totalWithFee } from '../../lib/platformFee.js';
import { buildCatalogPicker, OTHER_DISTRICT } from '../../lib/regCatalogPicker.js';
import { isGroupingDistrict } from '../../lib/districts.js';

// Tenant resolution: `org` (id, slug, name, active_registration_term, ...) is
// provided by PublicLayout via Outlet context (from the public_org_directory
// view). Page reads org.id / org.slug from there instead of hardcoding 'j2s'.
// The catalog term is per-org from org.active_registration_term — NOT hardcoded.
//
// OTHER_DISTRICT (the catch-all bucket for venues with no public district) and
// the whole lean district->school picker now live in lib/regCatalogPicker.js, so
// they can be tested. They used to be inline here, which is why the picker
// reached prod on 2026-08-14 with no coverage at all.

// Week order for the recurring class schedule (day_of_week stored Title-Case).
const WEEKLY_DAY_ORDER = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

export default function Home() {
  const { org } = useOutletContext();
  const ORG_SLUG = org.slug;
  const navigate = useNavigate();
  const embedLocation = useLocation();
  // Embedded in the operator's own site (iframe): drop the big hero and the page
  // background so the widget reads as part of THEIR page, not a framed app.
  const isEmbed = isEmbedContext(embedLocation);
  const [searchParams] = useSearchParams();
  // ?keep=1 means we arrived here from the wizard's "Add another child" flow.
  // Skip clearCart so the in-progress sibling registration keeps its parent + child 1 state.
  const keepCart = searchParams.get('keep') === '1';
  const { clearCart } = useCart();
  const [orgId, setOrgId] = useState(org?.id ?? null);
  const [branding, setBranding] = useState(null);
  const [schools, setSchools] = useState([]);
  // district id -> { name, district_type }, from districts_public. Holds the ROW,
  // not just the name: district_type is what decides whether a district earns its
  // own heading in the picker or falls into the shared bucket (20260817a). Renamed
  // from districtNames when it stopped being names.
  const [districtsById, setDistrictsById] = useState({});
  const [programs, setPrograms] = useState([]);
  const [vipBundles, setVipBundles] = useState({}); // fallProgramId -> { winter, spring }
  const [selectedDistrict, setSelectedDistrict] = useState('');
  const [selectedSchool, setSelectedSchool] = useState('');
  // Program id to scroll-to + highlight, set when arriving via a shared
  // per-program link (/<slug>?program=<id>).
  const [highlightProgram, setHighlightProgram] = useState('');
  const [weeklyClasses, setWeeklyClasses] = useState([]); // recurring class_schedule (outside-registration tenants), safe public view
  const [loading, setLoading] = useState(true);
  // PHONE LAYOUT for the lean program cards. Mirrors QuickProgramBuilder's
  // `narrow` pattern (the only responsive convention in this inline-styled
  // codebase) rather than inventing a second one.
  //
  // Measured on Jeff's live page at 375px before this existed: the card is a
  // flex ROW that never wrapped, and two siblings inside it refuse to shrink -
  // the 56px photo and the ~94px Register button. Of 310px of card, 150px went
  // to those two, leaving the class name AND a 726-character description sharing
  // a 93px ribbon 1187px tall. The card's own min-content also blew past its
  // grid track, so cards overhung their container.
  //
  // 560, not 480: the card holds photo + button + a description that needs a
  // readable measure, so it runs out of room well before a phone's width. Above
  // this the row layout is unchanged.
  const [narrowCards, setNarrowCards] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 560);
  useEffect(() => {
    const onResize = () => setNarrowCards(window.innerWidth < 560);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // How much description a card shows before "More". Three lines is the card-list
  // convention (Airbnb, Eventbrite, Amazon all clamp secondary text this way);
  // the facts BELOW it - day, time, location, who it is for, dates and price -
  // are never clamped, because those are the things a family must not miss.
  const [expandedDescriptions, setExpandedDescriptions] = useState(() => new Set());
  const toggleDescription = useCallback((id) => {
    setExpandedDescriptions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  // Lean catalog picker. Both start EMPTY: no school chosen means no classes
  // shown, so a family never lands on a price from someone else's district.
  const [locationDistrict, setLocationDistrict] = useState(''); // lean catalog: which district
  const [locationFilter, setLocationFilter] = useState(''); // lean catalog: which school
  // Fee config, so the class card can show what a family will actually pay.
  // The doc's rule is "never a surprise at the end" - until now the service fee
  // first appeared at the Pay step, after they had entered a child's details.
  // null = not loaded yet, and until it loads we show the plain price rather
  // than a total we can't stand behind.
  const [feeConfig, setFeeConfig] = useState(null);

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

    // Fee config: fired FIRST and deliberately NOT awaited.
    //
    // It only needs the slug, which we already have, so there is nothing for it
    // to wait behind - yet it used to be kicked off on the last line of this
    // function, after all five queries above had finished in series. On prod it
    // was the last request of the whole page load, starting at 1749ms and
    // landing at 2168ms, which meant the class cards rendered with the bare
    // class price and the all-in price replaced it ~420ms later. The one call
    // that decides what a family thinks they will pay was scheduled last.
    //
    // Still not awaited, on purpose. Cards must not wait on it: if it is slow
    // or fails, they render the plain price - the documented fallback - instead
    // of holding the whole catalog hostage to the fee line. Starting it here
    // just shrinks the window where the price is incomplete rather than
    // creating one. Same source the Pay step uses.
    supabase.functions
      .invoke('org-fee-config', { body: { slug: org.slug } })
      .then(({ data }) => setFeeConfig(data || null))
      .catch(() => setFeeConfig(null));

    // The picker belongs to the org we are ABOUT to load, so clear it here.
    // This component does NOT remount when the :slug route param changes - that
    // is the whole reason load() is keyed on org?.id - so without this the
    // previous provider's school id survives into the next provider's catalog.
    // `locationFilter` being truthy makes schoolChosen true, the filter then
    // matches none of the new org's programs, and the page renders "No classes
    // at that school right now." at a provider that has plenty. The old code
    // had the same hole but escaped it with a "Show all classes" button, which
    // the school gate removed - so the stale state stopped being recoverable
    // and had to stop happening instead.
    setLocationDistrict('');
    setLocationFilter('');

    // The one term the catalog serves, per org. Every term-derived label on
    // this page reads from this same value, so the page can't claim one season
    // while listing another's programs.
    const catalogTerm = org.active_registration_term;

    // Winter/Spring codes for the VIP bundle lookup, derived from the open term.
    //
    // Gated on the open term being a FALL term (schoolYearTermsForFall returns
    // null otherwise): VIP sells a whole school year, which only makes sense
    // from its start. Without this gate, a Winter open term would match itself
    // as its own "winter" leg and render a 3-term bundle listing the same class
    // twice. Codes are derived from the open term, never hardcoded, so this
    // keeps working when the school year rolls over.
    const bundleTerms = schoolYearTermsForFall(catalogTerm);

    // ONE round trip, not five.
    //
    // These queries were five sequential awaits, each waiting on the one above
    // it for no reason - none of them consumes another's result. Measured on
    // prod 2026-07-30 they formed a strict chain (each request started 2-4ms
    // after the previous one ended) sitting behind two more serial round trips
    // in PublicLayout, for 8 in total and a last-byte 10.2s after navigation
    // start. Total time was simply 8x whatever one round trip cost that day,
    // which is why the run-to-run variance was so wide.
    //
    // The bundle lookup joins this batch rather than waiting for `pg`: it only
    // filters on organization_id and the two derived term codes, all known
    // here. It is `pg` that is matched against ITS result, below, not the other
    // way round. When the open term is not a fall term there is no bundle to
    // build, so the query is skipped entirely rather than sent and discarded.
    //
    // It used to ALSO be gated on `pg.length`, which cannot be known without
    // waiting - that gate is what chained it. So an org whose fall term is open
    // but has no open programs now issues one query it did not before. It costs
    // no wall-clock (it runs alongside the others) and changes nothing on the
    // page: the match loop below still requires `pg.length`, so `bundles` comes
    // out {} either way, exactly as it did before.
    //
    // Fee config stays OUT of this batch deliberately - see below.
    const [brRes, scRes, pgRes, futureRes, wcRes, dtRes] = await Promise.all([
      // Branding (hero copy, colors, etc) - multi-tenant ready. Any provider
      // can customize these via org_branding row; defaults apply if blank.
      supabase
        .from('org_branding')
        .select('hero_headline, hero_subtext, banner_image_url')
        .eq('organization_id', org.id)
        .maybeSingle(),
      // district_id is the district a provider actually PICKED. The `district`
      // text column beside it is the legacy free-text code - the admin UI labels
      // it "Legacy district code (internal), kept only to match calendars you
      // uploaded before districts existed". This page read that legacy field, so
      // a provider who used the picker (Jeff: all 22 locations via district_id,
      // all 22 with district = NULL) had every location fall into "Other schools
      // & sites" and the picker was useless to them. It is still selected here
      // because other surfaces match calendars on it; it is no longer what this
      // page groups by.
      //
      // The NAME no longer comes from a `districts(name)` embed. That embed hits
      // the districts TABLE, whose public policy is scoped `to anon` and whose
      // other policy grants by org_members - and PARENTS ARE NOT ORG MEMBERS. So
      // the moment a family signed in, every district name came back null and
      // the grouping silently vanished (prod 2026-08-14: j2s 19 districts signed
      // out, 0 signed in). Names now come from districts_public below, which
      // both roles can read. See 20260814k.
      supabase
        .from('program_locations')
        .select('id, name, district, district_id, address, organization_id')
        .eq('organization_id', org.id)
        .order('name'),
      supabase
        .from('programs')
        .select('*, program_locations(name, district_id)')
        .eq('organization_id', org.id)
        .eq('term', catalogTerm)
        .eq('status', 'open')
        // Native programs (we run checkout) OR partner-run programs the operator
        // explicitly listed with a registration link (shown as a link-out, no checkout).
        .or('runs_own_registration.eq.false,and(runs_own_registration.eq.true,list_in_public_catalog.eq.true,external_registration_url.not.is.null)')
        .order('day_of_week'),
      bundleTerms
        ? supabase
          .from('programs')
          .select('*')
          .eq('organization_id', org.id)
          .eq('runs_own_registration', false) // don't bundle partner-run programs into a paid VIP offer
          // Same rule as the catalog query directly above, and as Register's own
          // bundle lookup: a leg must be PUBLISHED to be offered. Without it the
          // VIP bundle advertised DRAFT winter and spring classes to families --
          // classes the operator deliberately kept private. Second instance of
          // the same missing filter; both fixed together so one cannot drift
          // back on its own.
          .eq('status', 'open')
          .in('term', [bundleTerms.winter, bundleTerms.spring])
        : Promise.resolve({ data: null }),
      // Recurring weekly classes for outside-registration tenants (no term/checkout).
      // Read from the anon-safe view (no coach email/notes). Only renders a section
      // when rows exist, so registration tenants (J2S) are unaffected.
      supabase
        .from('class_schedule_public')
        .select('id, title, day_of_week, start_time, end_time, location_text, age_min, age_max, capacity')
        .eq('organization_id', org.id),
      // District names, from the anon-safe view rather than the districts table,
      // so a SIGNED-IN family sees the same grouping a signed-out one does. Same
      // pattern as class_schedule_public above.
      //
      // DEPLOY ORDER: migration 20260814k MUST be applied to an environment
      // BEFORE this frontend reaches it. PostgREST fails the whole statement on
      // an unknown relation, so without the view this read returns an error, not
      // a partial row - see the failure branch below for what that costs.
      // Measured 2026-08-14: the view is on STAGING, NOT on prod.
      // district_type comes with the name because the grouping rule needs it:
      // an `independent_school` row is a private/charter school that owns its own
      // calendar and must fall into the shared bucket rather than become its own
      // heading (20260817a). Selecting it is a deploy-order contract exactly like
      // the view itself was - the column must exist on an environment before this
      // frontend reaches it, or PostgREST fails the whole statement rather than
      // returning a partial row. Measured 2026-08-17: 20260817a is on STAGING,
      // NOT on prod.
      supabase
        .from('districts_public')
        .select('id, name, district_type')
        .eq('organization_id', org.id),
    ]);

    const br = brRes.data;
    const sc = scRes.data;
    const pg = pgRes.data;
    const wc = wcRes.data;
    // id -> name. A district whose name we cannot read falls out of the map and
    // its schools land in the OTHER_DISTRICT bucket, which is what happened to
    // EVERY district while signed in before this - the difference is that it is
    // now the failure mode, not the normal case.
    //
    // EMPTY AND FAILED MUST STAY DISTINGUISHABLE. `dtRes.data || []` alone makes
    // "this org has no districts" and "the districts read errored" produce the
    // identical page, and the second one is precisely the bug this commit exists
    // to fix - it would have gone silent all over again, on a page no operator
    // has an error report for. The degrade is deliberate and soft (the school
    // select still works, families can still register, so there is nothing a
    // family could act on and no error is shown to them) but it does not get to
    // be invisible to US.
    if (dtRes.error) {
      console.warn('[registration] district names unavailable; catalog will group everything as "%s". Cause: %o', OTHER_DISTRICT, dtRes.error);
    }
    // id -> the ROW, so district_type travels with the name. An
    // `independent_school` row is a private/charter school that owns its own
    // calendar: it stays IN this map (it is a real, readable district row) and the
    // grouping rule in regCatalogPicker sends it to the bucket. Keeping it in the
    // map rather than filtering it out here is what keeps "correctly-configured
    // private school" distinguishable from "the read broke", which is the whole
    // point of the paragraph above.
    const dn = {};
    (dtRes.data || []).forEach((d) => { dn[d.id] = { name: d.name, district_type: d.district_type }; });

    // Look up Winter/Spring matches for each fall program to determine VIP
    // eligibility. A fall program is VIP-eligible only if that school year's
    // Winter AND Spring exist at the same school + day.
    const futureTerms = futureRes?.data;
    const bundles = {};
    if (pg && pg.length && bundleTerms) {
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

    setBranding(br);
    setDistrictsById(dn);
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

  // The district name a provider CHOSE, rendered verbatim.
  //
  // Jessica, 2026-08-06: "let him name his districts. parents know the acronym
  // their kid is in." So "PPS" stays "PPS" - we do not translate it. This
  // deliberately replaces districtFullName(), which mapped ten Portland-area
  // codes to full names and would have silently overridden a provider's own
  // wording (Jeff's "PPS" would have rendered as "Portland Public Schools").
  // Uniformity is already guaranteed upstream: a location's district is PICKED
  // from the provider's own districts list, not typed per school.
  //
  // Returns null for an `independent_school` row as well as for a missing one, so
  // a private/charter school falls into the OTHER_DISTRICT bucket below instead of
  // becoming its own heading (20260817a). THE LEAN PATH HAS THE SAME RULE, in
  // regCatalogPicker.buildLocationOptions - this page drives two different pickers
  // off the same map and they must agree, which is exactly the drift that put
  // "Catlin Gabel School" up as a district heading in the first place.
  //
  // So the rule is CALLED, not restated. This line held its own copy of the
  // literal 'independent_school' while regCatalogPicker (the other picker named
  // two lines up) had been moved onto the shared helper - the two agreed only by
  // coincidence, which is the precise shape of the drift this comment warns about.
  const districtOf = (school) => {
    const row = school?.district_id ? districtsById[school.district_id] : null;
    if (!row?.name || !isGroupingDistrict(row)) return null;
    return row.name;
  };

  // Only districts that have at least one school with an open program. Schools
  // with no district collect under a single "Other schools & sites" bucket
  // (sorted last) instead of vanishing or each becoming its own district.
  const activeDistricts = useMemo(() => {
    const schoolsWithPrograms = new Set(programs.map((p) => p.program_location_id));
    const districts = new Set();
    let hasOther = false;
    schools.forEach((s) => {
      if (!schoolsWithPrograms.has(s.id)) return;
      const d = districtOf(s);
      if (d) districts.add(d);
      else hasOther = true;
    });
    const sorted = [...districts].sort((a, b) => a.localeCompare(b));
    if (hasOther) sorted.push(OTHER_DISTRICT);
    return sorted;
  }, [schools, programs, districtsById]);

  const schoolsInDistrict = useMemo(() => {
    if (!selectedDistrict) return [];
    const withPrograms = new Set(programs.map((p) => p.program_location_id));
    return schools
      .filter((s) => withPrograms.has(s.id)
        && (selectedDistrict === OTHER_DISTRICT ? !districtOf(s) : districtOf(s) === selectedDistrict))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedDistrict, schools, programs, districtsById]);

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
    setSelectedDistrict(districtOf(school) || OTHER_DISTRICT);
    setSelectedSchool(school.id);
    // The lean catalog's own picker, which is a SEPARATE pair of state values.
    // It has to be set too now that the lean list is gated on a school: before
    // the gate a deep link landed on every class and merely highlighted one, so
    // leaving these empty was harmless. Now it would render an empty page for
    // every shared class link.
    setLocationDistrict(districtOf(school) || OTHER_DISTRICT);
    setLocationFilter(school.id);
    setHighlightProgram(programId);
    // districtsById is listed because this effect reads it through districtOf.
    // It is inert today - names, schools and programs are set in one batch from
    // the same Promise.all, so they arrive together - but leaving a read out of
    // the deps is how that stops being true silently.
  }, [programs, schools, searchParams, selectedSchool, districtsById]);

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
    // Carry embed mode into the registration steps so the family never sees our
    // header/footer appear mid-flow inside the operator's own page.
    if (isEmbed) params.set('embed', '1');
    navigate(`/${ORG_SLUG}/register?${params.toString()}`);
  }

  // Lean, enrops-branded registration for self-serve operators (everyone except
  // legacy J2S). No hardcoded J2S hero, and the open programs render as a list
  // straight to checkout. J2S (legacy_own_platform) keeps its existing page below.
  //
  // This used to add "so a location-less program is still reachable". The school
  // gate makes that false - a program whose location has no id or no name is
  // skipped by locOptions and can never be filtered TO. It describes a row that
  // cannot exist anyway: programs.program_location_id and program_locations.name
  // are both NOT NULL on prod, with zero blank names (checked 2026-08-14). If
  // either ever becomes nullable, this gate needs an "everything else" bucket.
  //
  // The picker here is now the SAME SHAPE as J2S's below: district, then school,
  // then the classes. It used to be one grouped select that FILTERED a list every
  // visitor could already see, on the reasoning that a parent knows their school
  // and a district step is a dead click. That reasoning held at 2 open classes and
  // died at 18. See the note above the selects for what changed.
  const isLeanReg = org?.instructor_pay_model !== 'legacy_own_platform';
  // Can this provider actually be paid? Only gates the LEAN catalog — J2S is
  // connected and its page below is untouched. `!== false` so an older cached
  // org row (before the view exposed the flag) still shows the catalog rather
  // than blanking a working provider's page.
  const paymentsReady = org?.stripe_charges_enabled !== false;
  if (isLeanReg) {
    const allOpen = programs || [];

    // DISTRICT, THEN SCHOOL, THEN THE CLASSES - and nothing priced before a
    // school is chosen. Same shape as J2S's page below, deliberately.
    //
    // This replaced one grouped select defaulting to "All schools and sites"
    // above a list of every open class. The argument for that was that a parent
    // knows their school, so a district step is a dead click and an optgroup
    // organises without becoming one. What it missed is what the FIRST SCREEN
    // says. Jeff's catalog opens on 18 classes ordered by weekday, so the first
    // price a family read was Oak Creek at $329 - his most expensive district -
    // when their own school is $279 or $299. Jeff: "I don't want someone to get
    // scared off by looking at a price tag for a program at a more expensive
    // district." A filter cannot fix that, because the list is already rendered
    // behind it. A gate can.
    //
    // It also matches how school-based enrichment registration works elsewhere:
    // a Jumbula district catalog puts one TAB per school across the top and
    // shows no class until you pick one, and Homeroom gives each school its own
    // page. Nobody in this category opens on a priced list spanning every site.
    //
    // Native selects rather than a custom dropdown or a modal: on a phone this
    // opens the OS picker, which is scrollable, typeable and accessible for free.
    //
    // THE RULES THEMSELVES LIVE IN lib/regCatalogPicker.js, with 40 tests and a
    // mutation check that proves those tests detect. Keep them there: inline was
    // how this shipped untested.
    const picker = buildCatalogPicker(allOpen, districtsById, {
      district: locationDistrict,
      school: locationFilter,
    });
    const {
      groupNames, hasMultiLoc, useGroups, schoolChoices, schoolChosen,
      visiblePrograms: openPrograms,
    } = picker;
    // The SANITISED selection, not the raw state. If a value is not among the
    // options the module hands back '' - a select whose value is not in its own
    // option list renders blank and disagrees with the list beneath it.
    const districtValue = picker.district;
    const schoolValue = picker.school;
    // On a phone the card STACKS: content, then a full-width Register. Above 560
    // it is the same side-by-side row it always was. alignItems flips to stretch
    // so the stacked button spans the card instead of sitting centred and stubby.
    const leanCard = (hl) => ({
      display: 'flex',
      flexDirection: narrowCards ? 'column' : 'row',
      alignItems: narrowCards ? 'stretch' : 'center',
      justifyContent: 'space-between',
      gap: narrowCards ? 12 : 16,
      padding: '16px 18px', border: `1px solid ${hl ? '#5847C9' : '#e2dfd5'}`,
      borderRadius: 14, background: '#fff',
      boxShadow: hl ? '0 0 0 3px rgba(88,71,201,0.15)' : 'none',
      // Without this the card's min-content width (photo + button + the longest
      // unbreakable word) exceeded its grid track and cards overhung the page.
      minWidth: 0,
    });
    const leanBtn = {
      flexShrink: 0, padding: '10px 18px', background: '#5847C9', color: '#fff',
      border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600,
      fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'none',
      display: 'inline-block',
      // Stacked, it is the card's primary action and gets the whole width as a
      // tap target. In a row it must not stretch, so width stays auto.
      width: narrowCards ? '100%' : undefined,
      textAlign: 'center',
    };
    // ONE description renderer for both lean cards. There are two nearly
    // identical cards below (external-registration and ours) and every previous
    // change to this description has had to be made twice - the marginBottom fix
    // and the "show it at all" fix both did. A shared renderer is how the clamp
    // cannot land on one card and miss the other.
    const leanDescription = (p) => {
      if (!p.short_description) return null;
      const expanded = expandedDescriptions.has(p.id);
      // Only offer More when there is plausibly something to reveal. Character
      // count, not line count: lines are not measurable here without a ref, and
      // a wrong guess either hides text behind a needless toggle or clamps three
      // lines with nothing after them.
      const clampable = p.short_description.length > 150;
      return (
        <>
          <div
            style={{
              fontSize: 13, color: '#6b6b6b', marginTop: 4,
              marginBottom: clampable ? 2 : 10,
              lineHeight: 1.45, whiteSpace: 'pre-line',
              ...(clampable && !expanded ? {
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              } : null),
            }}
          >
            {p.short_description}
          </div>
          {clampable && (
            <button
              type="button"
              onClick={() => toggleDescription(p.id)}
              aria-expanded={expanded}
              style={{
                background: 'none', border: 'none', padding: 0, marginBottom: 10,
                color: '#5847C9', fontSize: 12.5, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'underline',
              }}
            >
              {expanded ? 'Less' : 'More'}
            </button>
          )}
        </>
      );
    };
    return (
      <div style={{
        minHeight: isEmbed ? 0 : '100vh',
        background: isEmbed ? 'transparent' : '#F7F7FB',
        fontFamily: "'Poppins', system-ui, sans-serif",
        color: '#1a1a1a',
      }}>
        {/* The dark hero is the operator's PUBLIC page identity. Inside their own
            website they've already got a header and their own branding above this
            iframe, so repeating a big purple banner just looks like a bolted-on
            widget. Embed mode goes straight to the classes. */}
        {!isEmbed && (
        <div style={{ background: '#1C004F', color: '#fff', padding: '56px 20px 72px' }}>
          <div style={{ maxWidth: 820, margin: '0 auto' }}>
            {/* Don't announce "registration is open" above a page that then says
                it isn't — the hero and the body have to tell the same story.
                `allOpen.length` is the second half of that rule and was missing:
                an org with Stripe connected and nothing published showed the
                green "registration is open" badge directly above a body reading
                "No open programs yet." Stripe being ready is not the same fact
                as there being something to register for. */}
            {paymentsReady && allOpen.length > 0 && (
              <span style={{ display: 'inline-block', background: 'rgba(38,214,135,0.14)', border: '1px solid rgba(38,214,135,0.35)', color: '#26D687', borderRadius: 100, padding: '5px 14px', fontSize: 12, fontWeight: 600 }}>
                {termLabel ? `${termLabel} registration is open` : 'Registration is open'}
              </span>
            )}
            <h1 style={{ fontSize: 38, fontWeight: 700, lineHeight: 1.12, margin: '18px 0 12px' }}>
              {branding?.hero_headline || org?.name || 'Register today'}
            </h1>
            {/* The DEFAULT tracks what the body actually shows. Three states, three
                sentences: nothing published yet, a school still to pick, or a class
                list right below. Getting this wrong is the hero-vs-body
                contradiction the badge above guards against - the empty-catalog
                case used to promise "Pick a class below" over a body reading "No
                open programs yet." An operator's own hero_subtext is left exactly
                as they wrote it - their page, their words. */}
            <p style={{ fontSize: 17, lineHeight: 1.6, color: 'rgba(255,255,255,0.82)', maxWidth: 560, margin: 0 }}>
              {!paymentsReady
                ? 'Classes are coming soon.'
                : (branding?.hero_subtext
                  || (allOpen.length === 0
                    ? 'Classes are coming soon.'
                    : hasMultiLoc
                      ? 'Find your school and sign your child up in under a minute.'
                      : 'Pick a class below and sign your child up in under a minute.'))}
            </p>
          </div>
        </div>
        )}
        <div style={{
          maxWidth: 820,
          margin: isEmbed ? '0 auto' : '-40px auto 0',
          padding: isEmbed ? '0' : '0 20px 64px',
        }}>
          <div style={{
            background: '#fff',
            border: isEmbed ? 'none' : '1px solid #e2dfd5',
            borderRadius: isEmbed ? 0 : 20,
            padding: isEmbed ? '4px 0' : '24px 22px',
            boxShadow: isEmbed ? 'none' : '0 8px 30px rgba(28,0,79,0.06)',
          }}>
            {loading ? (
              <div style={{ color: '#6b6b6b', padding: '24px 0', textAlign: 'center' }}>Loading classes&hellip;</div>
            ) : !paymentsReady ? (
              /* No Stripe = no way to take money, so don't advertise classes at
                 all. Listing them and blocking at the Pay step is a worse
                 experience: a family picks a class, fills in their child's
                 details, and only then finds out. Says nothing about Stripe —
                 that's the provider's business, not the family's. */
              <div style={{ color: '#6b6b6b', padding: '28px 0', textAlign: 'center' }}>
                <div style={{ fontWeight: 600, color: '#1a1a1a', marginBottom: 4 }}>
                  Registration isn&rsquo;t open yet
                </div>
                {org?.name} is still getting set up. Check back soon.
              </div>
            ) : allOpen.length === 0 ? (
              <div style={{ color: '#6b6b6b', padding: '24px 0', textAlign: 'center' }}>No open programs yet. Check back soon.</div>
            ) : (
              <>
                {/* The heading counts what is ON SCREEN. Before a school is
                    chosen there are no classes on screen, so counting the whole
                    catalog there would be the same "18 open programs, here they
                    all are" first impression the gate exists to remove. */}
                <h2 style={{ fontSize: 19, fontWeight: 700, margin: '2px 0 4px' }}>
                  {!schoolChosen
                    ? 'Find your child’s class'
                    : (openPrograms.length === 1 ? '1 open program' : `${openPrograms.length} open programs`)}
                </h2>
                {hasMultiLoc && !schoolChosen && (
                  <p style={{ fontSize: 14, color: '#6b6b6b', margin: '0 0 16px' }}>
                    {useGroups ? 'Pick your district, then your school.' : 'Pick your school to see its classes.'}
                  </p>
                )}
                {/* District, then school - see the note where `groups` is built. */}
                {hasMultiLoc && (
                  <div style={{
                    display: 'grid', gap: 12, margin: '12px 0 16px',
                    gridTemplateColumns: useGroups ? 'repeat(auto-fit, minmax(200px, 1fr))' : '1fr',
                    maxWidth: 560,
                  }}>
                    {useGroups && (
                      <div>
                        <label
                          htmlFor="catalog-district"
                          style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#1a1a1a', margin: '0 0 6px' }}
                        >
                          District
                        </label>
                        <select
                          id="catalog-district"
                          value={districtValue}
                          onChange={(e) => {
                            // Changing district always clears the school. Keeping
                            // it would leave a school selected that the new
                            // district does not contain, and the class list below
                            // would show a school the select no longer offers.
                            setLocationDistrict(e.target.value);
                            setLocationFilter('');
                          }}
                          style={{
                            width: '100%', padding: '11px 12px', fontSize: 15,
                            fontFamily: 'inherit', color: '#1a1a1a', background: '#fff',
                            border: '1px solid #cfcbc0', borderRadius: 10, cursor: 'pointer',
                          }}
                        >
                          <option value="">Select a district&hellip;</option>
                          {groupNames.map((d) => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label
                        htmlFor="catalog-school"
                        style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#1a1a1a', margin: '0 0 6px' }}
                      >
                        School
                      </label>
                      <select
                        id="catalog-school"
                        value={schoolValue}
                        disabled={useGroups && !districtValue}
                        onChange={(e) => setLocationFilter(e.target.value)}
                        style={{
                          width: '100%', padding: '11px 12px', fontSize: 15,
                          fontFamily: 'inherit', background: '#fff',
                          color: useGroups && !districtValue ? '#9a9a9a' : '#1a1a1a',
                          border: '1px solid #cfcbc0', borderRadius: 10,
                          cursor: useGroups && !districtValue ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <option value="">
                          {/* A literal ellipsis, NOT &hellip;. This is a JS string
                              inside a JSX expression, so an HTML entity would
                              render as the seven characters "&hellip;". The
                              district option below is JSX TEXT, where the entity
                              is correct - the two are not inconsistent. */}
                          {useGroups && !districtValue ? 'Pick a district first' : 'Select a school…'}
                        </option>
                        {schoolChoices.map((loc) => (
                          <option key={loc.id} value={loc.id}>{loc.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {/* A school with nothing in it must say so, or an empty page reads
                    as broken. Only reachable if a school's classes disappear
                    between render and the change event. */}
                {schoolChosen && openPrograms.length === 0 && (
                  <div style={{ color: '#6b6b6b', padding: '18px 0', textAlign: 'center', fontSize: 14 }}>
                    No classes at that school right now.
                  </div>
                )}
                <div style={{ display: 'grid', gap: 12 }}>
                  {openPrograms.map((p) => {
                    const timeStr = [p.start_time, p.end_time].filter(Boolean).join(' – ');
                    // "Is my child old enough?" is the first thing a parent asks
                    // and the most common reason they message the provider
                    // instead of registering. Only shown when the operator has
                    // actually said - never guessed.
                    //
                    // Now GRADES OR AGES, from the one shared definition. This card
                    // rendered ages only, so a provider who thinks in grades - which
                    // is every afterschool provider, per Jessica - had no way to tell
                    // families who a class was for. The wording for every age case is
                    // carried over verbatim from what this line used to produce, so
                    // nothing a family has been reading changes.
                    const ageStr = audienceLabel(p);
                    // "Mondays", "Monday" for a one-off, or null when no day is set
                    // (never the literal "nulls"). Shared helper so this label and
                    // the schedule line below use the same one-session coercion.
                    const dayStr = formatDayLabel(p);
                    const meta = [dayStr, timeStr, p.program_locations?.name, ageStr].filter(Boolean).join(' · ');
                    // "When does it start, and how many weeks am I buying?" - the
                    // two questions that previously could only be answered by
                    // starting a registration, which is where families dropped out.
                    const scheduleStr = programScheduleSummary(p);
                    const hl = highlightProgram === p.id;
                    // Optional program photo. alt="" because the class name sits
                    // right beside it — announcing the file twice adds nothing.
                    // No photo = the card renders exactly as it always has.
                    const photo = p.photo_url ? (
                      <img
                        src={p.photo_url}
                        alt=""
                        loading="lazy"
                        style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
                      />
                    ) : null;
                    if (p.runs_own_registration) {
                      return (
                        <div key={p.id} id={`program-card-${p.id}`} style={leanCard(hl)}>
                          <div style={{ display: 'flex', alignItems: narrowCards ? 'flex-start' : 'center', gap: 12, minWidth: 0 }}>
                            {photo}
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 16 }}>{p.curriculum}</div>
                              {/* The operator's own description, clamped to 3 lines
                                  with a More toggle. See leanDescription above -
                                  shared with the card below so a change here cannot
                                  miss its twin. */}
                              {leanDescription(p)}
                              <div style={{ fontSize: 13, color: '#6b6b6b', marginTop: 2 }}>{meta}</div>
                              {scheduleStr && (
                                <div style={{ fontSize: 13, color: '#6b6b6b', marginTop: 2 }}>{scheduleStr}</div>
                              )}
                            </div>
                          </div>
                          <a href={p.external_registration_url} target="_blank" rel="noopener noreferrer" style={leanBtn}>Register &#8599;</a>
                        </div>
                      );
                    }
                    return (
                      <div key={p.id} id={`program-card-${p.id}`} style={leanCard(hl)}>
                        <div style={{ display: 'flex', alignItems: narrowCards ? 'flex-start' : 'center', gap: 12, minWidth: 0 }}>
                          {photo}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 16 }}>{p.curriculum}</div>
                            {/* Same shared renderer as the external-registration card
                                above. This is the one Jeff's families actually see. */}
                            {leanDescription(p)}
                            <div style={{ fontSize: 13, color: '#6b6b6b', marginTop: 2 }}>
                              {meta}
                            </div>
                            {scheduleStr && (
                              <div style={{ fontSize: 13, color: '#6b6b6b', marginTop: 2 }}>{scheduleStr}</div>
                            )}
                            {/* All-in price, stated here rather than at the Pay
                                step. The breakdown sits underneath so the fee
                                is never a reveal — a family sees the real
                                number before they type anything. */}
                            <div style={{ fontSize: 13, color: '#6b6b6b', marginTop: 2 }}>
                              <span style={{ fontWeight: 600, color: '#1a1a1a' }}>{formatMoney(totalWithFee(p.price_cents, feeConfig))}</span>
                              {feeOnCents(p.price_cents, feeConfig) > 0 && (
                                <span> · {formatMoney(p.price_cents)} class + {formatMoney(feeOnCents(p.price_cents, feeConfig))} enrops service fee</span>
                              )}
                            </div>
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
          {/* Attribution deliberately omitted: this route renders inside
              PublicLayout, whose footer carries the single platform line. */}
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
            {/* Operator-editable, same as every other tenant's page (Jessica
                2026-08-05: J2S runs the same features as everyone, only its
                colors, hero image and WORDING differ). These two lines used to
                be hardcoded here, which is why the branding editor looked broken
                for this layout. The literals below are now only a FALLBACK, so
                the page reads identically until someone edits the wording. */}
            <h1 className="mt-6 font-titan text-5xl leading-[1.05] tracking-tight sm:text-7xl">
              {branding?.hero_headline || (
                <>
                  Future-Ready Skills.
                  <br />
                  Right After School.
                </>
              )}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/90 sm:text-xl">
              {branding?.hero_subtext
                || "Hands-on coding, LEGO, game design, and robotics at 30+ Portland-area schools. Small groups, expert instructors, and a kid who can't wait for next week."}
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
            {/* PLATFORM labels for the picker, not operator brand copy. These
                used to read the branding hero fields, so ONE pair of fields was
                driving two unrelated jobs: an operator editing their page
                headline silently retitled the class finder instead. The hero
                fields now belong to the hero above; this is just the control's
                own heading. */}
            <h2 className="font-titan text-2xl text-j2s-ink sm:text-3xl">
              Find your child&rsquo;s program
            </h2>
            <p className="mt-2 text-sm text-j2s-ink/70">
              Pick your district, then your school, then the class.
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
                        {d}
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
                    // "When does it start, and how many weeks am I buying?" - the
                    // two questions that previously could only be answered by
                    // starting a registration, which is where families dropped out.
                    const scheduleStr = programScheduleSummary(p);
                    // Same null-guarded weekday label as the openPrograms cards -
                    // a program with no day must not render the literal "nulls".
                    const dayLabel = formatDayLabel(p);
                    // Filtered join (like openPrograms' meta line) so an absent day
                    // or time never leaves an orphan " · " in front of the grades.
                    const timeStr = p.start_time
                      ? `${p.start_time}${p.end_time ? `–${p.end_time}` : ''}`
                      : null;
                    // Was a fifth hand-rolled copy of the grade vocabulary, and the
                    // only one that handled K. Now the same definition the lean card
                    // above uses, so the two layouts cannot drift while they stay
                    // forked. Renders identically for every row live on prod today.
                    // Re-counted on prod 2026-08-07, after the LEGO camp's ages were
                    // cleared: J2S holds 90 graded rows and 0 aged, prod-wide there
                    // are ZERO one-sided ranges and ZERO equal-endpoint ranges, so
                    // neither the new open-ended wording ("Grades 2+", "Up to grade
                    // 5") nor the single-value collapse ("Grade 3") can appear on an
                    // existing card. J2S is also the only prod org with grades at
                    // all, and it is the only one on THIS layout - so this change is
                    // inert on every live registration page.
                    const gradeStr = audienceLabel(p);
                    const metaStr = [dayLabel, timeStr, gradeStr].filter(Boolean).join(' · ');
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
                              <p className="mt-1 mb-2.5 whitespace-pre-line text-sm text-j2s-ink/65 leading-snug">{p.short_description}</p>
                            )}
                            {metaStr && <p className="mt-1 text-sm text-j2s-ink/70">{metaStr}</p>}
                            {scheduleStr && (
                              <p className="mt-1 text-sm font-semibold text-j2s-ink/70">
                                {scheduleStr}
                              </p>
                            )}
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
                            <p className="mt-1 whitespace-pre-line text-sm text-j2s-ink/65 leading-snug">
                              {p.short_description}
                            </p>
                          )}
                          {metaStr && <p className="mt-1 text-sm text-j2s-ink/70">{metaStr}</p>}
                          {/* Session count used to live on the line above, but only
                              when it wasn't 8 - so the most common class silently
                              said nothing about its length. It now always shows,
                              next to the start date, on one line that owns both.
                              (The old guard also rendered a bare "0" for a program
                              whose session_count was 0, since `0 && ...` is 0.) */}
                          {scheduleStr && (
                            <p className="mt-1 text-sm font-semibold text-j2s-ink/70">
                              {scheduleStr}
                            </p>
                          )}
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
