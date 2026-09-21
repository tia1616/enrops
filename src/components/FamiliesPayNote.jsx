import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { formatMoney } from '../lib/pricing.js';
import { totalWithFee, feeOnCents } from '../lib/platformFee.js';

// FamiliesPayNote — under a price field, the number to put on a flyer.
//
// Money layer (17 Sept 2026) section 4, the operator price entry row:
//   "Families pay $247.20. Use $247.20 anywhere you advertise this program."
//   With "cover the fee" on: "Families pay $240.00."
//
// WHY THIS EXISTS AT ALL. An operator types 240 and has no way to know what a
// family is charged. Section 3 requires the all-in price on every surface
// enrops generates - and the surfaces enrops does NOT generate are the ones
// that matter most here: the flyer at the school gate, the newsletter, the
// text to a parent. The product cannot put the right number on those. It can
// only tell the operator what it is, which is what this does.
//
// IT ASKS THE SAME ENDPOINT THE FAMILY FLOW ASKS. Not the organizations row.
// org-fee-config resolves the negotiated-rate end date and substitutes platform
// defaults when it has passed, so this shows the price a family would be quoted
// TODAY. Reading the columns directly would skip that resolution and could
// print a number nobody is charged - and "use this anywhere you advertise"
// is a promise that has to hold.
//
// ONE COPY, THREE FIELDS. An operator can set a price in the full wizard, the
// quick builder, and the inline edit panel on the schedule. Three spellings of
// this sentence would be three chances to disagree about what a family pays.

/**
 * The org's effective fee config, from org-fee-config.
 *
 * Returns null while loading and on any failure. Every consumer must treat
 * null as "say nothing": a price note that guesses is worse than no note,
 * because the operator would put the guess on a flyer.
 */
export function useOrgFeeConfig(slug) {
  const [cfg, setCfg] = useState(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('org-fee-config', {
          body: { slug },
        });
        if (cancelled) return;
        setCfg(error ? null : (data ?? null));
      } catch {
        if (!cancelled) setCfg(null);
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  return cfg;
}

/**
 * The line under a price field.
 *
 * @param {number|null} priceCents  what the operator has typed, in cents
 * @param {object|null} feeConfig   from useOrgFeeConfig
 */
export default function FamiliesPayNote({ priceCents, feeConfig, style }) {
  // Nothing to say yet: no price typed, or the config did not load. Silence is
  // the honest state - see the note above.
  if (feeConfig == null) return null;
  if (priceCents == null || !(priceCents > 0)) return null;

  const familiesPay = totalWithFee(priceCents, feeConfig);
  const fee = feeOnCents(priceCents, feeConfig);

  const base = {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 1.5,
    ...(style || {}),
  };

  // THE OPERATOR COVERS IT. fee_pass_through false means the fee comes out of
  // their payout instead, so a family pays the price as typed and there is
  // nothing to add to a flyer. Said out loud rather than shown as an absent
  // line, because "did it not load, or is there no fee?" is exactly the
  // question a blank leaves open.
  if (fee <= 0) {
    return (
      <div style={base}>
        <strong>Families pay {formatMoney(priceCents)}.</strong>{' '}
        You cover the enrops service fee, so this is the price to advertise.
      </div>
    );
  }

  return (
    <div style={base}>
      <strong>Families pay {formatMoney(familiesPay)}.</strong>{' '}
      Use {formatMoney(familiesPay)} anywhere you advertise this program.
      That is your {formatMoney(priceCents)} plus the {formatMoney(fee)} enrops
      service fee.
    </div>
  );
}
