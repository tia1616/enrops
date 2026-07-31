// How long connecting Stripe actually takes — stated once, read everywhere.
//
// MEASURED, not estimated. Jessica's own connect on staging (2026-07-30) took 48
// seconds from clicking Connect to landing back, entering nothing, because she
// was already signed in to Stripe. "About a minute" rather than "under a minute"
// allows for somebody signing in fresh with 2FA; the 5-to-10 covers creating an
// account from scratch.
//
// This file exists because the figure is now on two screens: the trust chips on
// Payments, and the first-program step strip. Two hardcoded copies of the same
// number is precisely how a product ends up telling an operator two different
// things about one task — which had already happened once here, when the
// success screen said "about 5 minutes" while Payments said a minute. One
// source, two capitalisations, no third copy.
//
// If this ever needs to become per-operator or data-driven, it changes HERE and
// both screens follow.

const CORE = 'about a minute if you already use Stripe, 5 to 10 minutes if not';

/** Mid-sentence form: "Connecting Stripe takes {STRIPE_CONNECT_ESTIMATE}." */
export const STRIPE_CONNECT_ESTIMATE = CORE;

/** Standalone form, e.g. a chip or its own sentence. */
export const STRIPE_CONNECT_ESTIMATE_SENTENCE = CORE.charAt(0).toUpperCase() + CORE.slice(1);
