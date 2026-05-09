import React, { useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase.js';
import {
  formatMoney,
  isLegacyActive,
  LEGACY_PRICE_CENTS,
  VIP_PRICE_PER_TERM_CENTS,
  VIP_TOTAL_CENTS,
  calculateProgramPrice,
} from '../../../lib/pricing.js';

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

export default function StepProgram({
  programs,
  schoolName,
  selectedItem,
  onSelectItem,
}) {
  const [showingVipFor, setShowingVipFor] = useState(null);
  const [vipPreview, setVipPreview] = useState(null);
  const [loadingVip, setLoadingVip] = useState(false);

  // Only FA26 programs are entry points. VIP bundles extend to WI27 + SP27.
  const fallPrograms = useMemo(
    () => programs.filter((p) => p.term === 'FA26'),
    [programs],
  );

  // Merge multi-day cards per Doc 02:
  // If a school has multiple programs (different days), group them into one card.
  // Parent picks a day, which selects the program.
  const schoolCards = useMemo(() => {
    if (fallPrograms.length <= 1) {
      // Single program: show as a single-day "card" with that program preselected.
      return fallPrograms.map((p) => ({
        programs: [p],
        isMultiDay: false,
      }));
    }
    // Multiple programs at this school → one merged card with day sub-selector.
    const sorted = [...fallPrograms].sort((a, b) => {
      const ai = DAY_ORDER.indexOf(a.day_of_week);
      const bi = DAY_ORDER.indexOf(b.day_of_week);
      return ai - bi;
    });
    return [{ programs: sorted, isMultiDay: true }];
  }, [fallPrograms]);

  async function openVipPreview(fallProgram) {
    setLoadingVip(true);
    setShowingVipFor(fallProgram.id);

    const { data: matches } = await supabase
      .from('programs')
      .select('*')
      .eq('program_location_id', fallProgram.program_location_id)
      .eq('day_of_week', fallProgram.day_of_week)
      .in('term', ['WI27', 'SP27']);

    const wi = matches?.find((p) => p.term === 'WI27');
    const sp = matches?.find((p) => p.term === 'SP27');

    setVipPreview({ fall: fallProgram, winter: wi, spring: sp });
    setLoadingVip(false);
  }

  function confirmStandard(program) {
    onSelectItem({ program, isVip: false });
  }

  function confirmVip() {
    if (!vipPreview || !vipPreview.winter || !vipPreview.spring) return;
    onSelectItem({
      program: vipPreview.fall,
      isVip: true,
      vipBundle: {
        fall: vipPreview.fall,
        winter: vipPreview.winter,
        spring: vipPreview.spring,
      },
    });
  }

  // VIP preview modal-style view
  if (showingVipFor && vipPreview) {
    const canVip = !!vipPreview.winter && !!vipPreview.spring;
    return (
      <div>
        <button
          onClick={() => {
            setShowingVipFor(null);
            setVipPreview(null);
          }}
          className="mb-4 text-sm font-semibold text-j2s-purple hover:underline"
        >
          &larr; Back to all programs
        </button>
        <div className="rounded-2xl border-2 border-j2s-orange bg-gradient-to-br from-j2s-orange/10 to-j2s-purple-soft/50 p-8">
          <span className="inline-block rounded-full bg-j2s-purple px-3 py-1 text-xs font-bold uppercase tracking-widest text-white">
            Most popular
          </span>
          <h2 className="mt-4 font-titan text-3xl text-j2s-ink">
            All 3 Terms — one commitment
          </h2>
          <p className="mt-2 text-j2s-ink/70">
            Lock in your spot at {schoolName} on {vipPreview.fall.day_of_week}s for
            all three terms. Here's the full year curriculum:
          </p>

          {loadingVip ? (
            <div className="mt-6 animate-pulse text-j2s-ink/50">Loading&hellip;</div>
          ) : (
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                { label: 'Fall 2026', p: vipPreview.fall },
                { label: 'Winter 2027', p: vipPreview.winter },
                { label: 'Spring 2027', p: vipPreview.spring },
              ].map(({ label, p }) => (
                <div
                  key={label}
                  className="rounded-xl border border-j2s-purple/15 bg-white p-4"
                >
                  <p className="font-titan text-xs uppercase tracking-widest text-j2s-orange">
                    {label}
                  </p>
                  {p ? (
                    <>
                      <p className="mt-2 font-bold text-j2s-ink">{p.curriculum}</p>
                      <p className="mt-1 text-xs text-j2s-ink/60">
                        {p.day_of_week}s &middot; {p.start_time}{p.end_time && <>–{p.end_time}</>}
                      </p>
                    </>
                  ) : (
                    <p className="mt-2 text-sm italic text-j2s-ink/50">
                      Not yet assigned
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 rounded-xl bg-white p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-titan text-lg text-j2s-ink">Full year total</p>
                <p className="text-sm text-j2s-ink/60">
                  {formatMoney(VIP_PRICE_PER_TERM_CENTS)} per term &times; 3 terms
                </p>
              </div>
              <p className="font-titan text-3xl text-j2s-orange-dark">
                {formatMoney(VIP_TOTAL_CENTS)}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <button
              disabled={!canVip}
              onClick={confirmVip}
              className="btn-j2s-orange disabled:cursor-not-allowed disabled:opacity-50"
            >
              Lock in VIP spot →
            </button>
          </div>
          {!canVip && (
            <p className="mt-3 text-sm italic text-j2s-ink/60">
              Winter or spring curriculum isn't confirmed yet for this day. Please
              register for the fall term and we'll let you know when VIP opens.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        Pick a program
      </h1>
      <p className="mt-2 text-j2s-ink/70">Open fall programs at {schoolName}</p>

      <div className="mt-8 space-y-4">
        {schoolCards.map((card, idx) => (
          <SchoolCard
            key={idx}
            card={card}
            selectedItem={selectedItem}
            onSelect={confirmStandard}
            onOpenVip={openVipPreview}
          />
        ))}
      </div>
    </div>
  );
}

// Single card — either a single-day program, or a multi-day merged card with day toggle.
function SchoolCard({ card, selectedItem, onSelect, onOpenVip }) {
  const { programs, isMultiDay } = card;
  // For multi-day cards, track which day the user has picked inside this card.
  const [activeDayIdx, setActiveDayIdx] = useState(0);
  const currentProgram = programs[activeDayIdx];
  const selected = selectedItem?.program?.id === currentProgram.id;

  if (!isMultiDay) {
    const p = programs[0];
    const sel = selectedItem?.program?.id === p.id;
    return (
      <ProgramCardBody
        program={p}
        selected={sel}
        onSelect={() => onSelect(p)}
        onOpenVip={() => onOpenVip(p)}
      />
    );
  }

  return (
    <div
      className={`rounded-2xl border-2 bg-white p-6 transition ${
        selected
          ? 'border-j2s-purple bg-j2s-purple-soft shadow-pop'
          : 'border-j2s-purple/10'
      }`}
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="rounded-full bg-j2s-purple/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-j2s-purple">
          Multi-day school
        </span>
        <span className="text-sm text-j2s-ink/70">Pick the day that works for you</span>
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        {programs.map((p, i) => (
          <button
            key={p.id}
            onClick={() => setActiveDayIdx(i)}
            className={`rounded-xl border-2 px-4 py-2 text-sm font-bold transition ${
              i === activeDayIdx
                ? 'border-j2s-purple bg-j2s-purple text-white'
                : 'border-j2s-purple/20 bg-white text-j2s-ink hover:border-j2s-purple/50'
            }`}
          >
            {p.day_of_week}
          </button>
        ))}
      </div>
      <ProgramCardBody
        program={currentProgram}
        selected={selected}
        onSelect={() => onSelect(currentProgram)}
        onOpenVip={() => onOpenVip(currentProgram)}
        embedded
      />
    </div>
  );
}

function ProgramCardBody({ program: p, selected, onSelect, onOpenVip, embedded }) {
  const [vipEligible, setVipEligible] = useState(null);
  const [bundle, setBundle] = useState(null);

  React.useEffect(() => {
    let cancelled = false;
    async function check() {
      const { data: matches } = await supabase
        .from('programs')
        .select('term, curriculum, session_count, program_type, price_cents')
        .eq('program_location_id', p.program_location_id)
        .eq('day_of_week', p.day_of_week)
        .in('term', ['WI27', 'SP27']);
      if (cancelled) return;
      const winter = matches?.find((m) => m.term === 'WI27');
      const spring = matches?.find((m) => m.term === 'SP27');
      if (winter && spring) {
        setBundle({ winter, spring });
        setVipEligible(true);
      } else {
        setVipEligible(false);
      }
    }
    check();
    return () => { cancelled = true; };
  }, [p.program_location_id, p.day_of_week]);

  const wrapperCls = embedded
    ? ''
    : `rounded-2xl border-2 p-0 overflow-hidden transition ${
        selected
          ? 'border-j2s-purple shadow-pop'
          : 'border-j2s-purple/10 hover:border-j2s-purple/30'
      }`;

  const standardTotal = vipEligible && bundle
    ? calculateProgramPrice(p) + calculateProgramPrice(bundle.winter) + calculateProgramPrice(bundle.spring)
    : calculateProgramPrice(p) * 3;
  const fallPrice = calculateProgramPrice(p);
  const vipSavings = standardTotal - VIP_TOTAL_CENTS;

  return (
    <div className={wrapperCls}>
      {/* Program header — #7: short description from DB */}
      <div className="bg-j2s-purple-soft/40 p-5 border-b border-j2s-purple/10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-titan text-xl text-j2s-ink">{p.curriculum}</h3>
            {p.short_description && (
              <p className="mt-1 text-sm text-j2s-ink/65 leading-snug">
                {p.short_description}
              </p>
            )}
            <p className="mt-1 text-sm text-j2s-ink/70">
              {p.day_of_week}s
              {p.start_time && <> · {p.start_time}{p.end_time && <>–{p.end_time}</>}</>}
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
        </div>
      </div>

      {/* Two-column pricing — #1: VIP on LEFT, Fall Only on RIGHT */}
      <div className={`grid ${vipEligible ? 'sm:grid-cols-2' : ''} bg-white`}>

        {/* VIP column (LEFT) — only shown if eligible */}
        {vipEligible && bundle && (
          <div className="relative border-j2s-purple/10 bg-j2s-purple/[0.06] p-5 sm:border-r">
            {/* #10: Most popular pill */}
            <span className="inline-block rounded-full bg-j2s-purple px-3 py-1 text-xs font-bold uppercase tracking-widest text-white">
              Most popular
            </span>
            {/* #2: "All 3 Terms" label */}
            <p className="mt-3 font-titan text-xs uppercase tracking-widest text-j2s-purple-dark">
              All 3 Terms
            </p>
            {/* #5: $240/term is headline size */}
            <p className="mt-2 font-titan text-2xl text-j2s-ink">
              {formatMoney(VIP_PRICE_PER_TERM_CENTS).replace('.00', '')}
              <span className="text-base font-nunito text-j2s-ink/60">/term</span>
            </p>
            <p className="mt-1 text-sm text-j2s-ink/70">
              {formatMoney(VIP_TOTAL_CENTS)} total
            </p>
            {/* #4: "Save up to $X" badge */}
            <span className="mt-2 inline-block rounded-full bg-j2s-orange px-3 py-1 text-xs font-bold text-white">
              Save up to {formatMoney(vipSavings).replace('.00', '')}
            </span>
            {/* #8: Early-bird urgency on both cards */}
            {isLegacyActive() && (
              <p className="mt-2 text-xs font-semibold text-j2s-orange-dark">
                Early-bird pricing ends June 5
              </p>
            )}
            {/* #6: "Your child's full school year:" lead-in */}
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
              onClick={onOpenVip}
              className="btn-j2s-primary mt-4 w-full"
            >
              Lock in VIP spot →
            </button>
          </div>
        )}

        {/* Fall Only column (RIGHT, or full-width if no VIP) */}
        <div className="p-5">
          {/* #3: "Fall Only" label */}
          <p className="font-titan text-xs uppercase tracking-widest text-j2s-ink/50">
            Fall only
          </p>
          <div className="mt-2">
            {isLegacyActive() && LEGACY_PRICE_CENTS < fallPrice ? (
              <>
                <p className="font-titan text-3xl text-j2s-orange-dark">
                  {formatMoney(LEGACY_PRICE_CENTS)}
                </p>
                <p className="text-xs text-j2s-ink/60 line-through">
                  {formatMoney(fallPrice)}
                </p>
              </>
            ) : (
              <p className="font-titan text-3xl text-j2s-purple">
                {formatMoney(fallPrice)}
              </p>
            )}
          </div>
          <p className="mt-1 text-xs text-j2s-ink/60">Fall 2026</p>
          {/* #8: Early-bird urgency on both cards */}
          {isLegacyActive() && LEGACY_PRICE_CENTS < fallPrice && (
            <p className="mt-2 text-xs font-semibold text-j2s-orange-dark">
              Early-bird pricing ends June 5
            </p>
          )}
          {/* #9: Fall Only = outline/secondary button */}
          <button
            onClick={onSelect}
            className={`mt-4 w-full ${selected ? 'btn-j2s-primary' : 'btn-j2s-secondary'}`}
          >
            {selected ? '✓ Selected' : 'Register for fall only'}
          </button>
        </div>
      </div>
    </div>
  );
}
