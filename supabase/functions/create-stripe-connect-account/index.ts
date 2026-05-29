// create-stripe-connect-account — Function 10 (chunk 2).
//
// Instructor-facing. Creates a Stripe Connect Express account if the
// instructor doesn't have one yet, then returns a fresh Account Link the
// wizard redirects to. Calling again returns a fresh link against the
// existing account (handles "refresh expired link" + retry).
//
// Body (optional): { origin: "https://..." } — the wizard's base URL.
// Used to build return_url + refresh_url. Defaults to https://enrops.com
// when not provided so prod still works if the client forgets to send it.
//
// Dispatch on org.instructor_pay_model:
//   - 'legacy_own_platform' (J2S): instructor's Express account is created
//     under the operator's OWN Stripe Connect platform.
//     STRIPE_INSTRUCTOR_PLATFORM_KEY points there.
//   - 'enrops_platform' (default, future tenants): instructor's Express
//     account is created under Enrops's main Stripe (which IS the Connect
//     platform that already hosts the operator's connected account for
//     Receivables). STRIPE_SECRET_KEY points there.
//
// Env vars required: STRIPE_SECRET_KEY (enrops_platform path),
// STRIPE_INSTRUCTOR_PLATFORM_KEY (legacy_own_platform path).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

type InstructorPayModel = 'legacy_own_platform' | 'enrops_platform';

// Build the Stripe client for the platform that should host this org's
// instructor Express accounts. Per-call (not module-level) so the dispatch
// reads the org row at request time.
function getInstructorPlatformStripe(model: InstructorPayModel): Stripe {
  const key = model === 'legacy_own_platform'
    ? Deno.env.get('STRIPE_INSTRUCTOR_PLATFORM_KEY')
    : Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) {
    throw new Error(
      `missing Stripe key for instructor_pay_model='${model}' — set ${
        model === 'legacy_own_platform' ? 'STRIPE_INSTRUCTOR_PLATFORM_KEY' : 'STRIPE_SECRET_KEY'
      }`,
    );
  }
  return new Stripe(key, {
    apiVersion: '2023-10-16',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

interface RequestBody {
  origin?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      // Body is optional; default origin to enrops.com.
    }
    const origin = sanitizeOrigin(body.origin) || 'https://enrops.com';
    const slug = me.org_slug;

    const supabase = adminClient();

    // Look up existing stripe_connect_account_id, the org's website/name, and
    // the instructor's date_of_birth (the resolveInstructor result doesn't
    // include dob). We pre-fill as much of the Stripe Express form as we
    // already have on file so contractors aren't re-typing data we know.
    const [
      { data: existing, error: fetchErr },
      { data: org },
      { data: instructorExtras },
    ] = await Promise.all([
      supabase
        .from('contractor_onboarding_status')
        .select('stripe_connect_account_id')
        .eq('instructor_id', me.id)
        .maybeSingle(),
      supabase
        .from('organizations')
        .select('name, website, instructor_pay_model')
        .eq('id', me.organization_id)
        .maybeSingle(),
      supabase
        .from('instructors')
        .select('date_of_birth')
        .eq('id', me.id)
        .maybeSingle(),
    ]);
    if (fetchErr) {
      console.error('onboarding fetch failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Dispatch on the org's chosen pay architecture. Default to enrops_platform
    // if the column is somehow null (shouldn't happen — NOT NULL DEFAULT in DB).
    const payModel: InstructorPayModel =
      (org?.instructor_pay_model as InstructorPayModel | undefined) === 'legacy_own_platform'
        ? 'legacy_own_platform'
        : 'enrops_platform';

    let stripe: Stripe;
    try {
      stripe = getInstructorPlatformStripe(payModel);
    } catch (err) {
      console.error('stripe client init failed:', err);
      return json({ error: 'platform_misconfigured', detail: (err as Error).message }, 500);
    }

    let accountId = existing?.stripe_connect_account_id as string | null;
    let justCreated = false;

    // Create a new Express account if needed.
    if (!accountId) {
      // Belt-and-suspenders dedup: before creating, search Stripe for an
      // account already tagged with this instructor_id. Catches the case where
      // a prior call created a Stripe account but the DB write failed,
      // leaving an orphan our existing-row check can't see. Stripe's search
      // index has a delay (often seconds, sometimes minutes), so this won't
      // catch same-second retries — delete-on-fail below covers that.
      try {
        const search = await stripe.accounts.search({
          query: `metadata['instructor_id']:'${me.id}'`,
          limit: 2,
        });
        if (search.data.length === 1) {
          accountId = search.data[0].id;
          console.warn('recovered orphan stripe account', {
            instructor_id: me.id,
            account_id: accountId,
          });
        } else if (search.data.length > 1) {
          const ids = search.data.map((a) => a.id);
          console.error('multiple stripe accounts for instructor', me.id, ids);
          return json({ error: 'multiple_stripe_accounts', account_ids: ids }, 409);
        }
      } catch (err) {
        // Search failures are non-fatal — fall through to create. Worst case
        // we create a duplicate, which delete-on-fail / the next search will
        // catch.
        console.warn('stripe.accounts.search failed (non-fatal):', err);
      }
    }

    if (!accountId) {
      // Build the individual block from instructor data we already have.
      // Stripe still requires the contractor to confirm/complete (and add SSN
      // + address + bank), but every pre-filled field is one fewer question.
      const individual: Record<string, unknown> = {};
      if (me.first_name) individual.first_name = me.first_name;
      if (me.last_name) individual.last_name = me.last_name;
      if (me.email) individual.email = me.email;
      if (me.phone) individual.phone = me.phone;
      const dob = parseDob(instructorExtras?.date_of_birth as string | null | undefined);
      if (dob) individual.dob = dob;

      let account;
      try {
        account = await stripe.accounts.create({
          type: 'express',
          email: me.email,
          // We only USE transfers (paying contractors out), but Stripe doesn't
          // approve transfers-only Express accounts for new platforms without
          // a manual review process. Requesting card_payments alongside is the
          // standard Express pattern — it stays dormant since we never charge
          // through these accounts, and Stripe doesn't bill for unused
          // capabilities. Removing card_payments would require getting
          // platform approval from Stripe Support first.
          capabilities: {
            transfers: { requested: true },
            card_payments: { requested: true },
          },
          // business_type: 'individual' — contractors are individuals, not
          // registered businesses. Pre-selecting it removes one form question.
          business_type: 'individual',
          // Pre-fill business_profile with the org's data so contractors
          // (who don't have their own websites or MCC codes) aren't asked.
          // Stripe still lets the contractor edit these fields if they want.
          // mcc 8299 = Schools/Educational Services - Other.
          business_profile: {
            ...(org?.website ? { url: org.website } : {}),
            mcc: '8299',
            product_description: org?.name
              ? `Teaching enrichment classes through ${org.name}`
              : 'Teaching enrichment classes',
          },
          ...(Object.keys(individual).length > 0 ? { individual } : {}),
          metadata: {
            instructor_id: me.id,
            organization_id: me.organization_id,
            // Routing hint for webhook handlers — which platform this account
            // belongs to. Matches organizations.instructor_pay_model.
            instructor_pay_model: payModel,
          },
        });
      } catch (err) {
        // Surface the Stripe error message in the response so the wizard can
        // show a useful message instead of a generic "failed". Common causes:
        //   - "Your platform isn't yet able to create connected accounts..."
        //     -> platform setup incomplete in Stripe dashboard
        //   - "You must add at least one capability..."
        //     -> needs card_payments AND transfers in some setups
        //   - "Your account does not have Connect enabled..."
        //     -> Connect product not actually active for this key's account
        const stripeErr = err as { message?: string; raw?: { message?: string; code?: string; type?: string } };
        const errMsg = stripeErr.raw?.message ?? stripeErr.message ?? 'unknown';
        const errCode = stripeErr.raw?.code ?? stripeErr.raw?.type ?? 'unknown';
        console.error('stripe.accounts.create failed:', errCode, errMsg, err);
        return json({
          error: 'stripe_account_create_failed',
          stripe_code: errCode,
          stripe_message: errMsg,
        }, 502);
      }
      accountId = account.id;
      justCreated = true;
    }

    // Persist the account ID. Use update or insert depending on whether
    // the onboarding row exists yet. If this write fails AFTER we just
    // created a Stripe account, delete the Stripe account so we don't leave
    // an orphan that the next retry will skip past.
    const persistErr = await persistAccountId(supabase, me, accountId, existing);
    if (persistErr) {
      if (justCreated && accountId) {
        try {
          await stripe.accounts.del(accountId);
          console.warn('deleted orphan stripe account after persist failure', accountId);
        } catch (delErr) {
          // Account still exists in Stripe; flag for manual cleanup.
          console.error('failed to delete orphan stripe account', accountId, delErr);
        }
      }
      console.error('stripe account id persist failed:', persistErr);
      return json({ error: existing ? 'update_failed' : 'insert_failed' }, 500);
    }

    // Always create a fresh account link — old links expire fast.
    const returnUrl = `${origin}/${slug}/onboarding?return=true`;
    const refreshUrl = `${origin}/${slug}/onboarding?refresh=true`;

    let link;
    try {
      link = await stripe.accountLinks.create({
        account: accountId!,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
    } catch (err) {
      console.error('stripe.accountLinks.create failed:', err);
      return json({ error: 'stripe_link_create_failed' }, 502);
    }

    return json({ onboarding_url: link.url });
  } catch (err) {
    console.error('create-stripe-connect-account fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

// Update or insert the onboarding row to point at the Stripe account.
// Returns null on success, or the underlying error so the caller can decide
// whether to clean up a just-created Stripe account.
async function persistAccountId(
  supabase: ReturnType<typeof adminClient>,
  me: { id: string; organization_id: string },
  accountId: string,
  existing: { stripe_connect_account_id: string | null } | null,
): Promise<unknown> {
  if (existing) {
    const { error } = await supabase
      .from('contractor_onboarding_status')
      .update({
        stripe_connect_account_id: accountId,
        stripe_connect_status: 'onboarding_in_progress',
        updated_at: new Date().toISOString(),
      })
      .eq('instructor_id', me.id);
    return error;
  }
  const { error } = await supabase
    .from('contractor_onboarding_status')
    .insert({
      instructor_id: me.id,
      organization_id: me.organization_id,
      stripe_connect_account_id: accountId,
      stripe_connect_status: 'onboarding_in_progress',
      overall_status: 'in_progress',
    });
  return error;
}

// instructors.date_of_birth is a DATE column (YYYY-MM-DD). Stripe's
// individual.dob wants { day, month, year } as ints. Returns null if the
// input is missing or malformed so we just skip the field.
function parseDob(s: string | null | undefined): { day: number; month: number; year: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month, year };
}

function sanitizeOrigin(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  // Only accept https:// or http:// (for local dev). Reject anything else
  // (data: URIs, javascript:, etc.) so the return URL can't be hijacked.
  if (!/^https?:\/\/[^\s/]+$/i.test(t)) return null;
  return t.replace(/\/$/, '');
}
