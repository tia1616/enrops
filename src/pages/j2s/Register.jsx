import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams, useOutletContext } from 'react-router-dom';
import { supabase, API_BASE } from '../../lib/supabase.js';
import { VIP_PRICE_PER_TERM_CENTS } from '../../lib/pricing.js';
import { useCart } from '../../context/CartContext.jsx';
import StepIndicator from '../../components/StepIndicator.jsx';
import StepStudent from './register-steps/StepStudent.jsx';
import StepParent from './register-steps/StepParent.jsx';
import StepWaivers from './register-steps/StepWaivers.jsx';
import StepReview from './register-steps/StepReview.jsx';
import StepPay from './register-steps/StepPay.jsx';
import { parseRegFields, pickupDnrConflicts } from './register-steps/RegExtraFields.jsx';

// Has the parent answered a custom question? (by field type)
function hasAnswer(value, type) {
  if (type === 'multiselect') return Array.isArray(value) && value.length > 0;
  if (type === 'checkbox') return value === true || value === 'true';
  if (type === 'number') return value !== undefined && value !== null && String(value).trim() !== '';
  return typeof value === 'string' ? value.trim() !== '' : value != null;
}

// Tenant resolution: `org` (id, slug, name, ...) is provided by PublicLayout
// via Outlet context — see src/layouts/PublicLayout.jsx. No more hardcoded
// ORG_ID / ORG_SLUG. Every query scopes by org.id; navigations use org.slug.
export default function Register() {
  const { org } = useOutletContext();
  const ORG_SLUG = org.slug;
  const ORG_ID = org.id;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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

    if (isVipOnlyCart) {
      const fallIdx = pricing.lines.findIndex((l) => l.term_label === 'Fall');
      const winterIdx = pricing.lines.findIndex((l) => l.term_label === 'Winter');
      const springIdx = pricing.lines.findIndex((l) => l.term_label === 'Spring');
      pricing.lines.forEach((l, idx) => {
        if (idx === fallIdx) perLineSplits.push({ line_index: idx, splits: [l.subtotal_cents, 0, 0] });
        else if (idx === winterIdx) perLineSplits.push({ line_index: idx, splits: [0, l.subtotal_cents, 0] });
        else if (idx === springIdx) perLineSplits.push({ line_index: idx, splits: [0, 0, l.subtotal_cents] });
      });
    } else {
      pricing.lines.forEach((l, idx) => {
        const sub = l.subtotal_cents;
        const base = Math.floor(sub / 3);
        const remainder = sub - base * 3;
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

  // Pre-select program + school + VIP from URL params (Home.jsx passes
  // ?program=X&vip=1). This is the only entry point into the wizard.
  useEffect(() => {
    const programFromUrl = searchParams.get('program');
    const vipFromUrl = searchParams.get('vip') === '1';
    if (!programFromUrl || !programs.length || !schools.length || activeChild.items.length) return;

    const program = programs.find((x) => x.id === programFromUrl);
    if (!program) return;

    const school = schools.find((s) => s.id === program.program_location_id);
    if (school) setActiveChildSchool(school);

    if (!vipFromUrl) {
      setActiveChildItem({ program, isVip: false });
      return;
    }

    // VIP path needs Winter and Spring program rows for the bundle
    (async () => {
      const { data: matches } = await supabase
        .from('programs')
        .select('*')
        .eq('program_location_id', program.program_location_id)
        .eq('day_of_week', program.day_of_week)
        .eq('runs_own_registration', false) // don't bundle partner-run programs into a paid VIP offer
        .in('term', ['WI27', 'SP27']);
      const winter = matches?.find((p) => p.term === 'WI27');
      const spring = matches?.find((p) => p.term === 'SP27');
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
    const [schoolsRes, programsRes, waiversRes, regFieldsRes, feeRes] = await Promise.all([
      supabase
        .from('program_locations')
        .select('id, name, district, address')
        .eq('organization_id', ORG_ID)
        .order('name'),
      supabase
        .from('programs')
        .select('*')
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
      supabase.rpc('get_active_registration_fields', { p_org_id: ORG_ID }),
      // Fee-display config via edge fn (RBAC-safe path — the anon org view
      // intentionally excludes fee columns). Used to show the pass-through
      // "Platform fee" line on StepPay before redirecting to Stripe.
      supabase.functions.invoke('org-fee-config', { body: { slug: ORG_SLUG } }),
    ]);

    setSchools(schoolsRes.data || []);
    setPrograms(programsRes.data || []);
    setWaivers(waiversRes.data || []);
    setRegFields(parseRegFields(regFieldsRes.data || []));
    setFeeConfig(feeRes?.data || { fee_pass_through: false, platform_fee_card_pct: 0, platform_fee_ach_pct: 0, platform_fee_cap_cents: 0 });
    // Thread the org's sibling % onto the cart so the review screen matches the
    // server charge. undefined (older org-fee-config) -> pricing.js keeps the 10% default.
    setSiblingPct(feeRes?.data?.sibling_discount_pct);
    setLoading(false);
  }

  // Navigation guards — steps are 0=Student, 1=Parent, 2=Waivers, 3=Review, 4=Pay.
  function canAdvance() {
    switch (step) {
      case 0: {
        const s = activeChild.student;
        const base =
          !!s.first_name &&
          !!s.last_name &&
          s.grade !== '' &&
          !!s.birthdate &&
          !!s.homeroom_teacher &&
          !!s.emergency_contact_name &&
          !!s.emergency_contact_phone;
        if (!base) return false;
        const std = regFields.std;
        // dismissal method (if enabled + required)
        if (std.dismissal_method?.required && !s.dismissal_method) return false;
        // pickup list required when released to an adult — or always, if the org
        // enabled pickup without the dismissal question (matches the form's render)
        if (std.authorized_pickup?.required && (s.dismissal_method === 'released_to_authorized_adult' || !std.dismissal_method)) {
          const named = (activeChild.authorized_pickup || []).filter(
            (p) => (p.first_name || '').trim() && (p.last_name || '').trim(),
          );
          if (named.length === 0) return false;
        }
        // required custom questions
        for (const f of regFields.custom) {
          if (f.is_required && !hasAnswer(activeChild.custom_answers?.[f.field_key], f.field_type)) return false;
        }
        // A person can't be on both the pickup and do-not-release lists (the DB
        // enforces this too). Block until the parent resolves the overlap.
        if (pickupDnrConflicts(activeChild.authorized_pickup, activeChild.do_not_release).length > 0) return false;
        return true;
      }
      case 1: {
        const base =
          !!cart.parent.first_name &&
          !!cart.parent.last_name &&
          !!cart.parent.email &&
          !!cart.parent.phone;
        if (!base) return false;
        if (regFields.std.guardian_secondary?.required) {
          const g = cart.parent.guardian2 || {};
          if (!(g.first_name || '').trim() || !(g.last_name || '').trim()) return false;
        }
        return true;
      }
      case 2: {
        const requiredWaivers = waivers.filter((w) => w.required);
        return requiredWaivers.every(
          (w) => activeChild.waivers[w.id]?.agreed === true,
        );
      }
      case 3:
        return true;
      default:
        return false;
    }
  }

  function next() {
    if (!canAdvance()) return;
    setError('');
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
    navigate(`/${ORG_SLUG}?keep=1`);
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
              amount_cents: l.subtotal_cents,
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
        // $0 scholarship — no payment. Go straight to the success page.
        window.location.href = `/${ORG_SLUG}/register/success?comp=1`;
        return;
      }
      if (coData.url) {
        window.location.href = coData.url;
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
          <div className="mb-6 animate-fade-in rounded-xl border-2 border-j2s-orange-dark bg-j2s-orange/10 p-4">
            <p className="font-bold text-j2s-orange-dark">Heads up</p>
            <p className="mt-1 text-sm text-j2s-ink">{error}</p>
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
            <StepPay
              pricing={pricing}
              submitting={submitting}
              onCheckout={handleCheckout}
              paymentPlan={cart.payment_plan}
              installmentSchedule={installmentSchedule?.display || null}
              org={{ ...org, ...(feeConfig || {}) }}
            />
          )}
        </div>

        {/* Nav */}
        <div className="mt-10 flex items-center justify-between border-t border-j2s-purple/10 pt-6">
          <button
            onClick={back}
            disabled={step === 0 || submitting}
            className="rounded-lg px-4 py-2 font-semibold text-j2s-ink/70 transition hover:bg-j2s-purple-soft disabled:opacity-40"
          >
            &larr; Back
          </button>
          {step < 4 ? (
            <button
              onClick={next}
              disabled={!canAdvance()}
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
