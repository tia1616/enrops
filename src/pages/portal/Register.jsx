import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams, useOutletContext } from 'react-router-dom';
import { supabase, API_BASE } from '../../lib/supabase.js';
import { advanceProblem } from '../../lib/registerAdvance.js';
import { VIP_PRICE_PER_TERM_CENTS } from '../../lib/pricing.js';
import { schoolYearTermsForFall } from '../../lib/terms.js';
import { useCart } from '../../context/CartContext.jsx';
import StepIndicator from '../../components/StepIndicator.jsx';
import StepStudent from './register-steps/StepStudent.jsx';
import StepParent from './register-steps/StepParent.jsx';
import StepWaivers from './register-steps/StepWaivers.jsx';
import StepReview from './register-steps/StepReview.jsx';
import StepPay from './register-steps/StepPay.jsx';
import { parseRegFields, pickupDnrConflicts } from './register-steps/RegExtraFields.jsx';
import { renderWaiverText } from '../../lib/waiverText.js';

// Tenant resolution: `org` (id, slug, name, ...) is provided by PublicLayout
// via Outlet context — see src/layouts/PublicLayout.jsx. No more hardcoded
// ORG_ID / ORG_SLUG. Every query scopes by org.id; navigations use org.slug.
export default function Register() {
  const { org } = useOutletContext();
  const ORG_SLUG = org.slug;
  const ORG_ID = org.id;
  // Lean registration operators (enrops_platform): trim the after-school-specific
  // student fields (grade, homeroom teacher, school-flavored referral) that don't
  // fit a dance / music / chess program. Legacy J2S keeps the full childcare form.
  const isLean = org?.instructor_pay_model !== 'legacy_own_platform';
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    cart,
    activeChild,
    pricing,
    setActiveChildSchool,
    setActiveChildItem,
    updateActiveStudent,
    updateActiveChild,
    updateParent,
    setActiveChildWaiver,
    setPromo,
    setPromoInput,
    setPromoError,
    togglePaymentPlan,
    setSiblingPct,
    addAnotherChild,
  } = useCart();

  const [step, setStep] = useState(0);
  const [schools, setSchools] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [waivers, setWaivers] = useState([]);
  // customizable-registration: org's enabled standard + active custom questions.
  // Empty {std:{},custom:[]} = today's behavior (no extra fields render).
  const [regFields, setRegFields] = useState({ std: {}, custom: [] });
  const [feeConfig, setFeeConfig] = useState(null); // {fee_pass_through, platform_fee_card_pct, platform_fee_cap_cents}
  // This provider's published cancellation/refund policy, shown on the pay step
  // before any money is taken (v4 section 6). null = none published.
  const [cancellationPolicy, setCancellationPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The error banner, so a failure can be scrolled to the family. See the effect below.
  const errorRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);

  // Compute installment schedule for cart total split 3 ways.
  // - Standard term: charge 1 today, charge 2 = first_session + 28 days, charge 3 = first_session + 56 days.
  // - VIP year: charge 1 today (Fall start), charge 2 = Winter first_session, charge 3 = Spring first_session.
  // Returns null if any program is missing the required dates (toggle won't show).
  const installmentSchedule = useMemo(() => {
    if (!pricing || !pricing.lines.length) return null;

    // VIP cart: 3 lines (Fall, Winter, Spring) all with is_vip=true.
    // Detect VIP-only cart (all lines are VIP and they share the same VIP bundle).
    const vipLines = pricing.lines.filter((l) => l.is_vip);
    const isVipOnlyCart = vipLines.length === pricing.lines.length && vipLines.length === 3;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fmt = (d) => d.toISOString().slice(0, 10);

    let charge2Date, charge3Date;

    if (isVipOnlyCart) {
      // Find the Fall line (the anchor for date estimates).
      // Fall line is the one with first_session_date set (Winter/Spring may be null).
      const fallLine = vipLines.find((l) => l.term_label === 'Fall') || vipLines[0];
      const winterLine = vipLines.find((l) => l.term_label === 'Winter');
      const springLine = vipLines.find((l) => l.term_label === 'Spring');

      if (!fallLine?.first_session_date) return null;
      const fall = new Date(fallLine.first_session_date + 'T00:00:00');

      // Use real Winter/Spring dates if set; otherwise use fixed fallback dates.
      // Fallbacks chosen because Winter terms typically start early January and
      // Spring terms typically start early April. Jessica updates real dates via
      // SQL when terms are confirmed, which auto-overrides the fallback.
      const fallYear = fall.getFullYear();
      // If Fall is in 2026, Winter/Spring are 2027. Generally next calendar year.
      const nextYear = fallYear + 1;

      if (winterLine?.first_session_date) {
        charge2Date = new Date(winterLine.first_session_date + 'T00:00:00');
      } else {
        // Fixed fallback: January 5 of the year after Fall
        charge2Date = new Date(`${nextYear}-01-05T00:00:00`);
      }
      if (springLine?.first_session_date) {
        charge3Date = new Date(springLine.first_session_date + 'T00:00:00');
      } else {
        // Fixed fallback: April 1 of the year after Fall
        charge3Date = new Date(`${nextYear}-04-01T00:00:00`);
      }
    } else {
      // Standard term: every line must have first_session_date
      const fsdLines = pricing.lines.filter((l) => l.first_session_date);
      if (fsdLines.length !== pricing.lines.length) return null;
      const earliestIso = fsdLines.map((l) => l.first_session_date).sort()[0];
      const fsd = new Date(earliestIso + 'T00:00:00');
      // Bug B fix (2026-05-01): final installment must land BEFORE term ends.
      // charge3 = first_session + (sessions - 2) × 7 days, where `sessions` is the
      // MAX session count across all programs in the cart.
      // charge2 = anchored inside the program window at the session midpoint.
      const maxSessions = Math.max(...fsdLines.map((l) => l.sessions || 8));
      const safeSessions = Math.max(maxSessions, 3);
      const programWindowDays = (safeSessions - 2) * 7;
      charge2Date = new Date(fsd);
      charge2Date.setDate(charge2Date.getDate() + Math.floor(programWindowDays / 2));
      charge3Date = new Date(fsd);
      charge3Date.setDate(charge3Date.getDate() + programWindowDays);
    }

    // Charges 2 and 3 must be in the future
    if (charge2Date <= today || charge3Date <= today) return null;

    // Bug A fix (2026-05-01): per-child installment attribution.
    // Each cart line gets its own 3-installment split so the backend can attribute
    // each installment row to the correct registration_id (and therefore the correct
    // child + program). VIP lines map 1:1 to charges (Fall→c1, Winter→c2, Spring→c3).
    const perLineSplits = [];

    // Split the NET per-line amount (amount_cents = after sibling AND promo) so the
    // displayed installments sum to the discounted total, matching the actual charge.
    if (isVipOnlyCart) {
      const fallIdx = pricing.lines.findIndex((l) => l.term_label === 'Fall');
      const winterIdx = pricing.lines.findIndex((l) => l.term_label === 'Winter');
      const springIdx = pricing.lines.findIndex((l) => l.term_label === 'Spring');
      pricing.lines.forEach((l, idx) => {
        if (idx === fallIdx) perLineSplits.push({ line_index: idx, splits: [l.amount_cents, 0, 0] });
        else if (idx === winterIdx) perLineSplits.push({ line_index: idx, splits: [0, l.amount_cents, 0] });
        else if (idx === springIdx) perLineSplits.push({ line_index: idx, splits: [0, 0, l.amount_cents] });
      });
    } else {
      pricing.lines.forEach((l, idx) => {
        const net = l.amount_cents;
        const base = Math.floor(net / 3);
        const remainder = net - base * 3;
        perLineSplits.push({
          line_index: idx,
          splits: [base + remainder, base, base],
        });
      });
    }

    const i1 = perLineSplits.reduce((s, p) => s + p.splits[0], 0);
    const i2 = perLineSplits.reduce((s, p) => s + p.splits[1], 0);
    const i3 = perLineSplits.reduce((s, p) => s + p.splits[2], 0);

    return {
      display: [
        { number: 1, amount_cents: i1, due_date: fmt(today) },
        { number: 2, amount_cents: i2, due_date: fmt(charge2Date) },
        { number: 3, amount_cents: i3, due_date: fmt(charge3Date) },
      ],
      perLineSplits,
      dueDates: {
        charge1: fmt(today),
        charge2: fmt(charge2Date),
        charge3: fmt(charge3Date),
      },
    };
  }, [pricing]);

  useEffect(() => {
    load();
  }, []);

  // /register requires a ?program= param. School + program selection lives on
  // /j2s — anyone landing here without a program (including browser-back from
  // Stripe, which strips the query string) bounces home.
  useEffect(() => {
    if (!searchParams.get('program')) {
      navigate(`/${ORG_SLUG}`, { replace: true });
    }
  }, [searchParams, navigate]);

  // Scroll to top whenever the step changes — fixes pages loading mid-page
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [step]);

  // BRING THE ERROR BANNER TO THE FAMILY.
  //
  // The banner renders at the TOP of the page container, but every action that
  // can fail — above all "Continue to secure payment" — sits at the BOTTOM of a
  // long step. Measured on staging: the message landed 705px ABOVE the viewport
  // while the button the family had just pressed was still on screen. So the
  // button looked simply dead: no charge, no message, no reason.
  //
  // Found by walking the flow after the capacity gate started rejecting. The gate
  // itself was right and its 409 body was right; the family just never saw it.
  //
  // Keyed on `error` rather than done inside the catch, so EVERY path that sets an
  // error gets this and not only the newest one. The banner is unmounted while
  // error is empty, hence the effect (a ref would be null at throw time).
  //
  // behavior:'instant', NOT 'smooth'. The first version of this used 'smooth' -
  // copied from the scrollIntoView calls elsewhere in the repo - and it silently did
  // NOTHING: measured on the running page, a smooth scrollIntoView left scrollY
  // unchanged at 963 after two seconds, while the same call with 'instant' moved it
  // to 0. So the effect was firing correctly the whole time and the scroll was the
  // no-op, which looked identical to the bug it was meant to fix. 'instant' is also
  // what the step-change scroll above already relies on, so it is proven in this app.
  // (The 'smooth' calls in EmailSenderSettings / CurriculumReview / LocationsList may
  // have the same problem - not touched here, but worth a look.)
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, [error]);

  // Pre-select program + school + VIP from URL params (Home.jsx passes
  // ?program=X&vip=1). This is the only entry point into the wizard.
  useEffect(() => {
    const programFromUrl = searchParams.get('program');
    const vipFromUrl = searchParams.get('vip') === '1';
    // NOTE: do NOT gate on schools.length. A lean (enrops_platform) org can have
    // ZERO program_locations — a location-less program ("No specific location" in
    // the quick-builder) is valid and common. schools=[] is a real loaded state,
    // not "still loading" (schools + programs load together in load()). Gating on
    // it left location-less orgs with an empty cart -> $0 review -> no checkout.
    // The school lookup below is already null-safe; pricing is program-driven and
    // never needs a school. J2S always has locations, so this is a no-op for J2S.
    if (!programFromUrl || !programs.length || activeChild.items.length) return;

    const program = programs.find((x) => x.id === programFromUrl);
    if (!program) return;

    const school = schools.find((s) => s.id === program.program_location_id);
    if (school) setActiveChildSchool(school);

    if (!vipFromUrl) {
      setActiveChildItem({ program, isVip: false });
      return;
    }

    // VIP path needs Winter and Spring program rows for the bundle.
    //
    // The legs are derived from THIS program's own term, and only when that
    // term is a Fall (schoolYearTermsForFall returns null otherwise) — a
    // full-school-year bundle only exists from its start. A ?vip=1 link
    // pointing at a non-Fall program therefore falls through to the standard
    // single-term path below rather than bundling the program with itself.
    const bundleTerms = schoolYearTermsForFall(program.term);
    if (!bundleTerms) {
      setActiveChildItem({ program, isVip: false });
      return;
    }
    (async () => {
      const { data: matches } = await supabase
        .from('programs')
        // Location name via program_locations_public, not the base table - see
        // the load() query below for why. Still aliased to `program_locations`
        // so pricing.js's prog.program_locations?.name is untouched.
        .select('*, program_locations:program_locations_public(name)')
        .eq('program_location_id', program.program_location_id)
        .eq('day_of_week', program.day_of_week)
        .eq('runs_own_registration', false) // don't bundle partner-run programs into a paid VIP offer
        // A LEG MUST BE PUBLISHED TO BE SOLD. Without this the bundle happily
        // picked up DRAFT winter and spring classes and charged a family for
        // them -- a class the operator deliberately kept private, sold anyway,
        // with no way for them to see it had happened. Live on prod against
        // the-ukulele-project: an open Fall class at Stephenson had two $299
        // drafts sharing its location and day, both sellable this way.
        //
        // 'open' mirrors this page's own eligibility query rather than
        // inventing a second rule -- status is nullable, and a NULL-status row
        // is not open and must not be sold either, which .eq gives us.
        .eq('status', 'open')
        .in('term', [bundleTerms.winter, bundleTerms.spring]);
      const winter = matches?.find((p) => p.term === bundleTerms.winter);
      const spring = matches?.find((p) => p.term === bundleTerms.spring);
      if (winter && spring) {
        setActiveChildItem({
          program,
          isVip: true,
          vipBundle: { fall: program, winter, spring },
        });
      } else {
        // VIP eligibility broke between Home and here — fall back to standard
        setActiveChildItem({ program, isVip: false });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programs, schools]);

  async function load() {
    const [schoolsRes, programsRes, waiversRes, regFieldsRes, feeRes, cancelPolicyRes] = await Promise.all([
      // program_locations_public, NOT the base table. The old comment below said
      // "Anon-safe: public_read_program_locations allows anon reads" - true, but
      // that policy is `TO public`, so it served signed-in families too and let
      // any of them read every other provider's school contact phones and
      // arrival briefings cross-tenant (prod 2026-08-25: 89 rows, 3 providers,
      // 55 phones, 5 private notes). 20260825d scopes it to anon; this view is
      // what keeps registration working for signed-in parents, who are not
      // org_members.
      //
      // DEPLOY ORDER: migration 20260825b MUST reach an environment BEFORE this
      // frontend. PostgREST fails the whole statement on an unknown relation, so
      // without the view this read errors rather than degrading - and this is
      // the checkout path. Measured 2026-08-25: the view is on STAGING, NOT prod.
      supabase
        .from('program_locations_public')
        .select('id, name, district, address')
        .eq('organization_id', ORG_ID)
        .order('name'),
      supabase
        .from('programs')
        // Join the location NAME so the Review line can show it (pricing.js reads
        // prog.program_locations?.name). Aliased to `program_locations` so that
        // reader, and WaitlistModal's program?.program_locations?.name, are both
        // untouched. Location-less programs return null here (name omitted).
        .select('*, program_locations:program_locations_public(name)')
        .eq('organization_id', ORG_ID)
        .eq('status', 'open')
        .eq('runs_own_registration', false) // exclude partner-run programs — no public checkout
        .order('day_of_week'),
      supabase
        .from('waivers')
        .select('*')
        .eq('organization_id', ORG_ID)
        .eq('active', true),
      // customizable-registration: the org's enabled standard + active custom
      // questions (one-org reader; returns [] if nothing enabled → form unchanged).
      // Per-program fields: pass the program being registered for so the family
      // is asked ONLY what this class needs. Org-wide questions still come back
      // for every program; a question scoped to another class never appears.
      supabase.rpc('get_active_registration_fields', {
        p_org_id: ORG_ID,
        p_program_id: searchParams.get('program') || null,
      }),
      // Fee-display config via edge fn (RBAC-safe path — the anon org view
      // intentionally excludes fee columns). Used to show the pass-through
      // "Platform fee" line on StepPay before redirecting to Stripe.
      supabase.functions.invoke('org-fee-config', { body: { slug: ORG_SLUG } }),
      // v4 section 6: the family must see this provider's cancellation and
      // refund policy BEFORE they pay, not buried in a Terms page they would
      // have to go looking for. Published rows only — a hidden draft must not
      // reach a family. org_policies allows public SELECT, so this works for
      // guest checkout with no session.
      supabase
        .from('org_policies')
        .select('content_markdown')
        .eq('organization_id', ORG_ID)
        .eq('policy_type', 'cancellation')
        .eq('published', true)
        .maybeSingle(),
    ]);

    setSchools(schoolsRes.data || []);
    setPrograms(programsRes.data || []);
    // Substitute the business name into the waiver text here, at the one place
    // it is loaded, rather than in each component that displays it — a reader
    // that forgot would show a family "{{org}}" in a contract.
    setWaivers((waiversRes.data || []).map((w) => ({ ...w, content: renderWaiverText(w.content, org?.name) })));
    setRegFields(parseRegFields(regFieldsRes.data || []));
    setFeeConfig(feeRes?.data || { fee_pass_through: false, platform_fee_card_pct: 0, platform_fee_ach_pct: 0, platform_fee_cap_cents: 0 });
    // Absent is the normal case today: no provider has published one yet. The
    // pay step simply omits the block rather than inventing a policy, because a
    // made-up cancellation term is far worse than none.
    setCancellationPolicy(cancelPolicyRes?.data?.content_markdown || null);
    // Thread the org's sibling % onto the cart so the review screen matches the
    // server charge. undefined (older org-fee-config) -> pricing.js keeps the 10% default.
    setSiblingPct(feeRes?.data?.sibling_discount_pct);
    setLoading(false);
  }

  // Navigation guards — steps are 0=Student, 1=Parent, 2=Waivers, 3=Review, 4=Pay.
  //
  // ONE call answers both "is this blocked" and "what do we tell them". It used
  // to answer only the first, and the three list-shaped requirements (pickup,
  // do-not-release, second guardian) could then grey Continue out with nothing
  // on the page explaining why - see src/lib/registerAdvance.js. Derived on every
  // render rather than held in state, so the sentence cannot lag what the parent
  // has already typed.
  const advanceBlocker = advanceProblem({
    step,
    isLean,
    activeChild,
    parent: cart.parent,
    regFields,
    waivers,
    conflicts: pickupDnrConflicts(activeChild.authorized_pickup, activeChild.do_not_release),
  });

  // Has this step had a Continue press REFUSED? Continue stays enabled and the
  // warning stays hidden until then, so the first thing a parent sees is a
  // normal form rather than a page telling them off for not having filled it in
  // yet. Jessica, on the disabled-button version: "i didn't even notice it -
  // looks like just a part of the form to fill out." A warning that was already
  // sitting there before you did anything reads as furniture; one that appears
  // because you pressed the button reads as an answer.
  const [advanceRefused, setAdvanceRefused] = useState(false);
  // Cleared on every step change so a warning earned on the student step is not
  // still on screen over the parent step.
  useEffect(() => { setAdvanceRefused(false); }, [step]);
  // Once they HAVE been refused, the warning tracks live as they type, so the
  // sentence never describes a field they already fixed.
  const showAdvanceWarning = advanceRefused && !!advanceBlocker;

  // Send the parent to the field the sentence is about. Matched on
  // data-reg-field rather than an id, because one step renders at a time so the
  // key is unique, and the step components do not have to know the wizard exists.
  function goToBlockedField() {
    const key = advanceBlocker?.focus;
    if (!key) return;
    const el = document.querySelector(`[data-reg-field="${CSS.escape(key)}"]`);
    if (!el) return;
    // Focus the control itself, not the wrapper - a parent who taps "Take me
    // there" wants a cursor in the box, not merely to be looking at it.
    //
    // ORDER MATTERS, and it is the opposite of the obvious one. Focusing after
    // the scroll can cancel it mid-flight, leaving the page a few hundred pixels
    // from where it was and nowhere near the field. preventScroll keeps the
    // focus itself from jumping, then the scroll runs and lands.
    const control = el.matches('input, select, textarea')
      ? el
      : el.querySelector('input, select, textarea');
    if (control) control.focus({ preventScroll: true });
    // DELIBERATELY NOT `behavior: 'smooth'`. Smooth scrolling is a no-op wherever
    // the page is not actively painting, and it is also what a reduced-motion
    // setting suppresses - measured here, a smooth call left scrollY at 1500
    // while the instant one landed it at 34. This button exists so a blocked
    // parent is never left pressing something that does nothing; making it
    // depend on an animation that can silently decline to run would rebuild the
    // dead-control bug inside its own fix. The jump is the feature, not the glide.
    el.scrollIntoView({ block: 'center' });
  }

  function next() {
    if (advanceBlocker) {
      setAdvanceRefused(true);
      return;
    }
    setError('');
    setAdvanceRefused(false);
    setStep((s) => Math.min(4, s + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function back() {
    setError('');
    setStep((s) => Math.max(0, s - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Adding a sibling means picking a new school + program for them. Cart state
  // (Child 1, parent info) survives via the CartContext above /j2s. The ?keep=1
  // flag tells Home.jsx to skip its default clearCart.
  function handleAddAnotherChild() {
    addAnotherChild();
    // Carry embed mode across the trip back to the catalog, or the operator's
    // iframe would suddenly render our full header/hero/footer mid-flow (and the
    // height reporter unmounts, freezing the frame at its old height).
    navigate(`/${ORG_SLUG}?keep=1${isEmbed ? '&embed=1' : ''}`);
  }

  // Embedded in the operator's own website (iframe)? Stripe's hosted checkout
  // REFUSES to be framed, so the hand-off has to navigate the TOP-level window.
  //
  // We ASSIGN window.top.location rather than window.open(url,'_top'): a blocked
  // top navigation makes the assignment THROW SecurityError, whereas window.open
  // fails SILENTLY. That difference matters enormously here — the Stripe session
  // is already created and billed by this point, so a silent failure is a dead
  // Pay button and a family who taps again and creates a second session.
  // Blocking is real, not theoretical: hosts that sandbox their embed (several
  // site builders do) and expired user activation after a slow session create.
  // If it throws we surface a visible link instead of guessing — clicking it is
  // a fresh user gesture, which is exactly what an escaped navigation needs.
  const isEmbed = searchParams.get('embed') === '1';
  const [paymentFallbackUrl, setPaymentFallbackUrl] = useState('');

  // Only true when we POSITIVELY know the provider can't take payment. While the
  // config is loading — or if the call failed, or an older org-fee-config that
  // doesn't return the flag is deployed — this stays false and checkout proceeds
  // as normal. Failing OPEN here is deliberate: create-checkout is the
  // authoritative gate and refuses the charge server-side, so the worst case is
  // a clear error one step later, whereas failing closed would block real paying
  // families on a transient config hiccup.
  const paymentsClosed = feeConfig ? feeConfig.stripe_charges_enabled === false : false;
  function goToPayment(url) {
    if (isEmbed && window.self !== window.top) {
      try {
        window.top.location.href = url;
        return;
      } catch (_) {
        setPaymentFallbackUrl(url);
        setSubmitting(false);
        return;
      }
    }
    window.location.href = url;
  }

  // paymentMethod: 'card' | 'us_bank_account', chosen on StepPay. Passed to
  // create-checkout so it builds a single-method session with the matching fee.
  // Ignored on the installments path (always card).
  async function handleCheckout(paymentMethod = 'card') {
    setSubmitting(true);
    setError('');
    try {
      // 1. Call create-registration edge function (bypasses RLS via service role)
      const regResp = await fetch(`${API_BASE}/create-registration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          organization_slug: ORG_SLUG,
          parent: cart.parent,
          children: cart.children,
          promo_code: cart.promo?.code || null,
          payment_plan: cart.payment_plan,
          pricing_snapshot: pricing,
          // Set when the family arrived from a waitlist invite email. The server
          // re-resolves it and credits the ONE seat their waitlist row is already
          // holding; without it the capacity gate would refuse the seat they were
          // invited to take. A missing, stale or other-org token is simply ignored
          // server-side, and they get the ordinary "that class is full".
          waitlist_token: searchParams.get('waitlist') || null,
        }),
      });
      const regData = await regResp.json();
      if (!regResp.ok || regData.error) {
        throw new Error(regData.error || 'Could not save registration.');
      }

      // 2. Call create-checkout with registration IDs.
      // Forward the SERVER-authoritative pricing create-registration returned
      // (net line amounts, promo actually applied) so the charge matches the DB
      // rows. Fall back to the client pricing if an older function is deployed
      // (identical numbers when there's no promo).
      const serverPricing = regData.pricing;
      const useInstallments = !!(cart.payment_plan && installmentSchedule);
      const checkoutLineItems =
        serverPricing?.lines?.length
          ? serverPricing.lines.map((l) => ({
              program_id: l.program_id,
              program_name: l.program_name,
              school_name: l.school_name,
              day_of_week: l.day_of_week,
              start_time: l.start_time,
              amount_cents: l.amount_cents,
              child_label: l.child_label,
            }))
          : pricing.lines.map((l) => ({
              program_id: l.program_id,
              program_name: l.program_name,
              school_name: l.school_name,
              day_of_week: l.day_of_week,
              start_time: l.start_time,
              amount_cents: l.amount_cents, // NET (after sibling + promo)
              child_label: `Child ${l.child_index + 1}`,
            }));
      const checkoutPayload = {
        registration_ids: regData.registration_ids,
        parent_email: cart.parent.email,
        parent_name: `${cart.parent.first_name} ${cart.parent.last_name}`,
        line_items: checkoutLineItems,
        total_cents: serverPricing?.total_cents ?? pricing.total_cents,
        origin: window.location.origin,
        success_path: `/${ORG_SLUG}/register/success`,
        cancel_path: `/${ORG_SLUG}/register`,
        payment_method: paymentMethod,
      };
      if (useInstallments) {
        checkoutPayload.use_installments = true;
        // Bug A fix (2026-05-01): per-line schedule with correct registration_id mapping.
        const dueDates = installmentSchedule.dueDates;
        const perLineEntries = [];
        // Prefer the SERVER-authoritative net amounts (promo applied) so the plan
        // totals match the DB rows / the checkout guard. Fall back to the client
        // schedule for VIP carts (term-to-charge mapping) or an older function.
        const isVipCart = cart.children.some((c) => c.items?.some((it) => it.isVip));
        const useServerNet =
          serverPricing?.lines?.length === regData.registration_ids.length && !isVipCart;
        if (useServerNet) {
          serverPricing.lines.forEach((l) => {
            const net = l.amount_cents;
            const base = Math.floor(net / 3);
            const splits = [base + (net - base * 3), base, base]; // remainder on charge 1
            const regId = l.registration_id;
            if (splits[0] > 0) perLineEntries.push({ installment_number: 1, registration_id: regId, amount_cents: splits[0], due_date: dueDates.charge1 });
            if (splits[1] > 0) perLineEntries.push({ installment_number: 2, registration_id: regId, amount_cents: splits[1], due_date: dueDates.charge2 });
            if (splits[2] > 0) perLineEntries.push({ installment_number: 3, registration_id: regId, amount_cents: splits[2], due_date: dueDates.charge3 });
          });
        } else {
          installmentSchedule.perLineSplits.forEach(({ line_index, splits }) => {
            const regId = regData.registration_ids[line_index];
            if (!regId) {
              console.error(`Missing registration_id for line ${line_index}`);
              return;
            }
            if (splits[0] > 0) perLineEntries.push({ installment_number: 1, registration_id: regId, amount_cents: splits[0], due_date: dueDates.charge1 });
            if (splits[1] > 0) perLineEntries.push({ installment_number: 2, registration_id: regId, amount_cents: splits[1], due_date: dueDates.charge2 });
            if (splits[2] > 0) perLineEntries.push({ installment_number: 3, registration_id: regId, amount_cents: splits[2], due_date: dueDates.charge3 });
          });
        }
        // Aggregate per-charge from the per-line entries so the totals always match
        // whatever source (server net or client) was used above.
        const sumCharge = (n) => perLineEntries.filter((e) => e.installment_number === n).reduce((s, e) => s + e.amount_cents, 0);
        checkoutPayload.installment_schedule = {
          aggregated: [
            { installment_number: 1, amount_cents: sumCharge(1), due_date: dueDates.charge1 },
            { installment_number: 2, amount_cents: sumCharge(2), due_date: dueDates.charge2 },
            { installment_number: 3, amount_cents: sumCharge(3), due_date: dueDates.charge3 },
          ],
          per_line: perLineEntries,
        };
      }
      const coResp = await fetch(`${API_BASE}/create-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(checkoutPayload),
      });
      const coData = await coResp.json();
      if (!coResp.ok || coData.error) {
        throw new Error(coData.error || 'Could not start checkout.');
      }
      if (coData.comp) {
        // $0 scholarship — no payment, no Stripe. This is OUR page and it frames
        // fine, so navigate normally: breaking out to the top window here would
        // replace the operator's whole website with a bare success page for no
        // reason. Inside an embed the family stays on their site.
        window.location.href = `/${ORG_SLUG}/register/success?comp=1${isEmbed ? '&embed=1' : ''}`;
        return;
      }
      if (coData.url) {
        goToPayment(coData.url);
      } else {
        throw new Error('Checkout session missing URL.');
      }
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="animate-pulse text-j2s-ink/50">Loading registration&hellip;</div>
      </div>
    );
  }

  return (
    <div>
      <StepIndicator current={step} />
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        {error && (
          <div ref={errorRef} className="mb-6 animate-fade-in rounded-xl border-2 border-j2s-orange-dark bg-j2s-orange/10 p-4">
            <p className="font-bold text-j2s-orange-dark">Heads up</p>
            <p className="mt-1 text-sm text-j2s-ink">{error}</p>
          </div>
        )}

        {/* The embedded hand-off to Stripe was blocked (the operator's site
            sandboxes this frame, or the click's activation expired while the
            session was being created). The registration IS saved and the payment
            page IS ready — so give them a real link rather than a button that
            looks broken. The click is a fresh gesture, which is what an escaped
            navigation needs. target=_top keeps them out of the framed-Stripe
            dead end. */}
        {paymentFallbackUrl && (
          <div className="mb-6 rounded-xl border-2 border-j2s-purple bg-j2s-purple-soft p-4">
            <p className="font-bold text-j2s-purple-dark">One more tap to pay</p>
            <p className="mt-1 text-sm text-j2s-ink">
              Your spot is saved. Your payment page is ready to open.
            </p>
            <a
              href={paymentFallbackUrl}
              target="_top"
              rel="noopener"
              className="btn-j2s-primary mt-3 inline-block"
            >
              Continue to secure payment →
            </a>
          </div>
        )}

        <div className="animate-slide-up">
          {step === 0 && (
            <StepStudent
              student={activeChild.student}
              onUpdate={updateActiveStudent}
              childIndex={activeChild.child_index}
              regFields={regFields}
              child={activeChild}
              onUpdateChild={updateActiveChild}
              lean={isLean}
              orgName={org?.name || ''}
            />
          )}
          {step === 1 && (
            <StepParent
              parent={cart.parent}
              onUpdate={updateParent}
              guardianConfig={regFields.std.guardian_secondary}
            />
          )}
          {step === 2 && (
            <StepWaivers
              waivers={waivers}
              signatures={activeChild.waivers}
              onUpdateSignature={setActiveChildWaiver}
              parentName={`${cart.parent.first_name} ${cart.parent.last_name}`}
            />
          )}
          {step === 3 && (
            <StepReview
              cart={cart}
              pricing={pricing}
              installmentSchedule={installmentSchedule?.display || null}
              onPromoApply={async (code) => {
                setPromoInput(code);
                const { data } = await supabase
                  .from('promo_codes')
                  .select('*')
                  .eq('organization_id', ORG_ID)
                  .eq('code', code.trim().toUpperCase())
                  .eq('active', true)
                  .maybeSingle();
                if (data) {
                  setPromo({
                    code: data.code,
                    discount_type: data.discount_type,
                    discount_value: data.discount_value,
                  });
                  setPromoError('');
                } else {
                  setPromo(null);
                  setPromoError('That code isn\'t valid.');
                }
              }}
              onPromoClear={() => {
                setPromo(null);
                setPromoInput('');
              }}
              onTogglePaymentPlan={togglePaymentPlan}
              onAddAnotherChild={handleAddAnotherChild}
            />
          )}
          {step === 4 && (
            paymentsClosed ? (
              /* The provider hasn't connected Stripe, so there is nowhere of
                 THEIRS for this money to land. create-checkout refuses these
                 server-side; showing it here means the family finds out before
                 they hand over card details, not after. Deliberately blames
                 nobody and gives them a way forward. */
              <div className="rounded-xl border-2 border-j2s-purple/20 bg-white p-6 text-center">
                <h2 className="text-xl font-bold text-j2s-purple-dark">
                  {org?.name} isn&rsquo;t taking payments online just yet
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-j2s-ink/70">
                  Their registration page is up, but online payment isn&rsquo;t switched on
                  yet, so we can&rsquo;t complete checkout. Get in touch with them directly
                  and they&rsquo;ll get you signed up.
                </p>
              </div>
            ) : (
              <StepPay
                pricing={pricing}
                submitting={submitting}
                onCheckout={handleCheckout}
                paymentPlan={cart.payment_plan}
                installmentSchedule={installmentSchedule?.display || null}
                org={{ ...org, ...(feeConfig || {}) }}
                cancellationPolicy={cancellationPolicy}
              />
            )
          )}
        </div>

        {/* Nav */}
        {/* THE REFUSED PRESS, ANSWERED. Shown only after Continue has actually
            been pressed and refused - see advanceRefused above for why an
            always-on explanation was invisible.

            Orange, not the quiet purple this used to be: it borrows the exact
            palette the birth-date problem and the pickup/do-not-release conflict
            already use on this same form, so a parent who has seen one of those
            recognises this instantly as "something needs fixing" rather than as
            another thing to fill in.

            POLITE, not role="alert". It is announced, but queued rather than
            interrupting. The conflict warning in RegExtraFields is role="alert"
            and should be - it appears once and then sits still. This one TRACKS
            the parent: fill the first name and it immediately becomes "add your
            child's last name". Assertive would cut across whatever the screen
            reader is saying every time they complete a field, including the echo
            of their own typing. */}
        {step < 4 && showAdvanceWarning && (
          <div
            id="advance-warning"
            role="status"
            aria-live="polite"
            className="mt-8 flex items-start gap-3 rounded-xl border-2 border-j2s-orange-dark bg-j2s-orange-dark/5 px-4 py-4"
          >
            <span aria-hidden="true" className="mt-px flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-j2s-orange-dark text-sm font-bold text-white">!</span>
            <div>
              <p className="font-titan text-base text-j2s-orange-dark">We still need one thing</p>
              <p className="mt-1 text-sm text-j2s-ink">{advanceBlocker.message}</p>
              {advanceBlocker.focus && (
                <button
                  type="button"
                  onClick={goToBlockedField}
                  className="mt-2 text-sm font-semibold text-j2s-orange-dark underline underline-offset-2 hover:no-underline"
                >
                  Take me there
                </button>
              )}
            </div>
          </div>
        )}

        <div className="mt-10 flex items-center justify-between border-t border-j2s-purple/10 pt-6">
          <button
            onClick={back}
            disabled={step === 0 || submitting}
            className="rounded-lg px-4 py-2 font-semibold text-j2s-ink/70 transition hover:bg-j2s-purple-soft disabled:opacity-40"
          >
            &larr; Back
          </button>
          {step < 4 ? (
            /* NOT disabled. A dead button gives a family nothing to press and no
               way to find out why, which is exactly how the 24 Aug call happened.
               It stays live and next() refuses the press with a reason. */
            <button
              onClick={next}
              aria-describedby={showAdvanceWarning ? 'advance-warning' : undefined}
              className="btn-j2s-primary"
            >
              Continue →
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
