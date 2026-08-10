import React, { useEffect, useState } from 'react';
import { useSearchParams, Link, useOutletContext } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useCart } from '../../context/CartContext.jsx';
import { supabase } from '../../lib/supabase.js';
import { emailIsValid } from '../../lib/validation.js';

export default function RegisterSuccess() {
  const { org } = useOutletContext();
  const ORG_SLUG = org.slug;
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const comp = searchParams.get('comp') === '1'; // $0 scholarship — no payment
  const { user, signInWithGoogle } = useAuth();
  const { clearCart, cart } = useCart();

  // The address the family checked out with, read once at mount and never changed -
  // nothing on this page writes it. Seeded from the cart, which is cleared 500ms
  // after mount and does not survive a reload, so on any refresh, back-button or
  // reopened link this is simply "".
  //
  // Its ONLY job is deciding whether the page may name an address in the copy below.
  // Naming one we do not have is how this page previously claimed "we sent a sign-in
  // link to your inbox" as a fact it could not back up.
  const [email] = useState(cart?.parent?.email || '');
  // The shared validator, not a hand-rolled regex - src/lib/validation.js already
  // exported emailIsValid with this exact pattern. It also returns false for "",
  // which is why no separate "did the cart have one?" flag is needed: an empty
  // address and an unusable one both mean the same thing here, don't name it.
  const emailLooksValid = emailIsValid(email);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // ACH/bank transfer settles over 1-3 business days. Ask Stripe whether this
  // session is still processing so we can tell the family accurately instead of
  // implying the payment is done (card settles instantly → processing=false).
  const [processing, setProcessing] = useState(false);
  // Tenant-neutral calendar invite (real, closure-aware session dates) built by
  // checkout-session-status. Lets the family add every class in one tap.
  const [calendar, setCalendar] = useState(null);
  // Operator-authored closing note (org_branding.confirmation_page_html), edited at
  // /admin/branding. This is where a provider links to their own shop or site —
  // Jeff's ask. Empty/absent renders nothing, so a tenant that never sets it gets
  // exactly the page it had before. Fetched here rather than in PublicLayout on
  // purpose: PublicLayout provides only `org` and does not read org_branding at
  // all, so putting it there would add a query to every public page to serve one.
  const [authoredHtml, setAuthoredHtml] = useState('');

  useEffect(() => {
    // Clear cart once we're on success
    setTimeout(() => clearCart(), 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.functions.invoke('checkout-session-status', {
        body: { session_id: sessionId },
      });
      if (cancelled) return;
      if (data?.processing) setProcessing(true);
      if (data?.calendar?.ics) setCalendar(data.calendar);
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      // Readable anonymously via the existing public_read_branding policy, which is
      // scoped to orgs in public_org_directory. A family on this page has no session,
      // so an authenticated-only read would come back empty and silently hide the note.
      const { data } = await supabase
        .from('org_branding').select('confirmation_page_html')
        .eq('organization_id', org.id).maybeSingle();
      if (!cancelled) setAuthoredHtml(data?.confirmation_page_html || '');
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  function downloadIcs() {
    if (!calendar?.ics) return;
    const blob = new Blob([calendar.ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'your-classes.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleGoogle() {
    setLoading(true);
    const { error: err } = await signInWithGoogle(
      `${window.location.origin}/${ORG_SLUG}/dashboard`,
    );
    if (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      {/* Success hero */}
      <div className="rounded-3xl bg-gradient-to-br from-j2s-purple to-j2s-purple-dark p-8 text-center text-white shadow-pop sm:p-12">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-j2s-orange text-4xl">
          ✓
        </div>
        <h1 className="mt-6 font-titan text-4xl sm:text-5xl">
          You're registered!
        </h1>
        <p className="mt-4 text-lg text-white/90">
          {comp
            /* Was "Sign in below to see your schedule and class details." A $0
               registration returns from create-checkout BEFORE Stripe (index.ts:182),
               so stripe-webhook never runs: no receipt, no magic link, and no account
               to sign in to. The page was inviting a family to do something that
               could not work. */
            /* Just the one sentence. Anything about the registration being saved
               belongs to the heading immediately below, which already says exactly
               that - on staging this rendered "Your registration is saved." and then
               "Your registration is saved" back to back. */
            ? 'Your spot is confirmed — no payment needed.'
            : 'Thanks for signing up. We just sent your receipt and class details to your email.'}
        </p>
        {sessionId && (
          /* The FULL id, and called the same thing the email calls it. This was
             "Confirmation ID: <first 16 chars>…" while the confirmation email prints
             the whole session id under the heading "Confirmation number" — so a family
             reading their screen quoted a truncated value under a different name, and
             nobody could match it to their order. Two names for one number, and only
             one of them usable. */
          <p className="mt-3 text-xs text-white/60">
            Confirmation number{' '}
            <span className="break-all font-mono text-white/80">{sessionId}</span>
          </p>
        )}
      </div>

      {processing && (
        <div
          className="mt-6 rounded-2xl border p-5"
          style={{ borderColor: '#F8A638', background: '#FFF7ED', color: '#7c4a03' }}
        >
          <p className="font-bold">🏦 Your bank transfer is processing.</p>
          <p className="mt-1 text-sm leading-relaxed">
            Bank transfers take 1–3 business days to clear. Your spot is held the whole time —
            we'll email you once your payment confirms. Nothing else to do right now.
          </p>
        </div>
      )}

      {/* Add-to-calendar — real, closure-aware sessions from the program. The
          .ics adds every session across all apps; Google links add the first. */}
      {calendar?.ics && (
        <div className="mt-6 rounded-3xl border border-j2s-purple/10 bg-white p-6 shadow-card sm:p-8">
          <h2 className="font-titan text-xl text-j2s-ink">Add your classes to your calendar</h2>
          <p className="mt-2 text-sm text-j2s-ink/70">
            Save {calendar.totalSessions === 1 ? 'your session' : `all ${calendar.totalSessions} sessions`} so you never miss a class.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={downloadIcs} className="btn-j2s-primary">
              Download calendar file (.ics)
            </button>
            {(calendar.events || [])
              .filter((e) => e.googleUrl)
              .map((e, i) => (
                <a
                  key={i}
                  href={e.googleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-xl border-2 border-j2s-ink/15 bg-white px-5 py-3 font-semibold text-j2s-ink transition hover:border-j2s-ink/30 hover:bg-j2s-ink/5"
                >
                  {(calendar.events || []).filter((x) => x.googleUrl).length > 1
                    ? `${e.programName} → Google`
                    : 'Add to Google Calendar'}
                </a>
              ))}
          </div>
          <p className="mt-3 text-xs text-j2s-ink/50">
            The .ics file adds every session and works with Apple Calendar, Google Calendar, and Outlook. Google links add your first session.
          </p>
        </div>
      )}

      {/* Account access — auto-account is created by stripe-webhook v15 + magic link sent */}
      {!user ? (
        <div className="mt-8 rounded-3xl border border-j2s-purple/10 bg-white p-8 shadow-card">
          <h2 className="font-titan text-2xl text-j2s-ink">
            {comp ? 'Your registration is saved' : 'Check your email'}
          </h2>
          {/* NAME THE ADDRESS ONLY WHEN WE HAVE A USABLE ONE. This used to read
              "We sent a sign-in link to your inbox" whenever the cart was gone,
              stating as fact something the page had no address for. Gated on
              usability rather than mere presence, so a malformed address - which the
              send would most likely have failed on anyway - does not get quoted back
              to the family as though it worked. */}
          <p className="mt-2 text-j2s-ink/70">
            {/* A $0 registration never reaches Stripe, so NOTHING was sent. Both
                branches below assert an email exists; for a comp family that is
                simply false, and it was the page's most confident sentence. The
                wider gap — comp families getting no confirmation and no dashboard
                at all — is a money-path change tracked separately; this only stops
                the page claiming otherwise. */}
            {comp ? (
              <>
                There was nothing to pay, so there&rsquo;s no receipt to send and no sign-in link
                yet. {org?.name || 'Your program provider'} has your registration and will be in
                touch with class details.
              </>
            ) : emailLooksValid ? (
              <>
                We sent a sign-in link to <span className="font-semibold text-j2s-ink">{email}</span>.
                Click the link to access your dashboard, view your child's schedule,
                and get session recaps.
              </>
            ) : (
              <>
                {/* "was sent", not "is on its way". This branch exists BECAUSE the
                    page was reloaded or reopened, so the send already happened,
                    possibly a while ago - "on its way" implies imminent and would
                    have a family waiting for something that already arrived. */}
                A sign-in link was sent to the email address you registered with.
                Click it to access your dashboard, view your child's schedule, and get
                session recaps.
              </>
            )}
          </p>

          {/* Hidden for comp: every control below is about an email that was never
              sent, or a sign-in that cannot reach a registration on prod (the
              claim_parent_record link is staging-only, verified 2026-08-10). Offering
              them would be the "silent wall" pattern - a door that opens onto nothing. */}
          {!comp && (
          <div className="mt-6 space-y-4">
            {/* NO RESEND BUTTON HERE, deliberately. Jessica, 2026-08-07, on being
                shown that the resend arrived from Supabase rather than the provider:
                "is this necessary though? we've established they already get a
                sign-in email."

                She is right, and the sign-in page is the one place that should own
                this. It already sends through auth-send-magic-link with the tenant's
                branding, already no-ops on unknown addresses, and already carries the
                anti-enumeration wording. A second resend control here was a second
                door to one action - and it was the door that could be opened by
                anyone, since this page needs no session and no login.
                See [[feedback_one_place_to_do_a_thing]].

                What was actually broken is fixed by removing it: the offer no longer
                outruns what the page can do, because the page no longer offers it. */}
            <p className="text-sm text-j2s-ink/60">
              Didn&rsquo;t get the email? Check your spam folder, or{' '}
              <Link to={`/${ORG_SLUG}/login`} className="font-semibold text-j2s-purple underline">
                sign in here
              </Link>{' '}
              and we&rsquo;ll send a fresh link.
            </p>

            {/* Google OAuth re-enabled 5/8/26 after Google verification approved. */}
            <div className="relative py-2 text-center">
              <span className="relative z-10 bg-white px-3 text-xs font-semibold uppercase tracking-widest text-j2s-ink/50">
                or
              </span>
              <span className="absolute left-0 right-0 top-1/2 z-0 h-px bg-j2s-purple/10" />
            </div>
            <button
              onClick={handleGoogle}
              disabled={loading}
              className="flex w-full items-center justify-center gap-3 rounded-xl border-2 border-j2s-ink/15 bg-white px-6 py-4 font-semibold text-j2s-ink transition hover:border-j2s-ink/30 hover:bg-j2s-ink/5"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>
          </div>
          )}

          {error && <p className="error-text mt-4">{error}</p>}
        </div>
      ) : (
        <div className="mt-8 rounded-3xl bg-j2s-purple-soft p-8 text-center">
          <p className="font-titan text-xl text-j2s-ink">Welcome back!</p>
          <Link to={`/${ORG_SLUG}/dashboard`} className="btn-j2s-primary mt-4 inline-block">
            Go to your dashboard →
          </Link>
        </div>
      )}

      {/* Points at the PROVIDER, not at us. A family with a question about their
          child's class should reach the person teaching it - and "reach us at
          support@enrops.com" sent them to the platform instead, contradicting
          the confirmation email, whose reply-to is already the provider's own
          address.
          Deliberately not a mailto: the public org record doesn't carry the
          provider's email, and inventing one risks a bounce. Replying to the
          confirmation lands with them either way, which is the outcome that
          matters. */}
      {/* Operator-authored closing note. Deliberately BELOW the class details, the
          calendar and the sign-in instructions: this is where a provider sells
          something (Jeff's ukuleles), and a family's own next steps come first. It is
          also why this is a note and not a redirect - Jessica's point was that a
          redirect pulls a family off this page before they have read any of it.

          Rendered as HTML because it is authored through RichBodyEditor, whose
          editableToHtml entity-escapes operator text and restricts hrefs to
          http/https/mailto. Only the org's own admins can write this column
          (members_write_branding -> can_admin_org), and it shows on that org's own
          confirmation page only. */}
      {authoredHtml.trim() !== '' && (
        <div className="mt-8 rounded-3xl border border-j2s-purple/10 bg-white p-6 shadow-card sm:p-8">
          <div
            className="text-j2s-ink/80 [&_a]:font-semibold [&_a]:text-j2s-purple [&_a]:underline [&_p]:mt-3 [&_p:first-child]:mt-0"
            dangerouslySetInnerHTML={{ __html: authoredHtml }}
          />
        </div>
      )}

      {/* Omitted entirely for comp rather than reworded. There is no confirmation
          email to reply to, so the sentence cannot be made true — and the block
          above already tells a comp family the provider will be in touch, so a
          second "they'll be in touch" here would just say it twice. */}
      {!comp && (
        <p className="mt-8 text-center text-sm text-j2s-ink/60">
          Questions? Just reply to your confirmation email
          {org?.name ? <> and it goes straight to {org.name}</> : <> and it goes straight to your program provider</>}.
        </p>
      )}

      {/* The platform attribution line used to live here as well, which meant
          this page rendered it twice - once here and once in PublicLayout's
          footer, which wraps this route. The checklist allows exactly one, so
          it now lives only in PublicLayout. */}
    </div>
  );
}
