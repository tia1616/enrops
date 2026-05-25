import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';

// PwaInstallButton intentionally NOT mounted on the Enrops marketing landing.
// First-time visitors haven't signed up yet — installing a SaaS app shell
// they can't actually use is friction without value. The install affordance
// lives on the authenticated portals (admin, instructor, J2S parent) where
// the user already has a reason to come back.
//
// Smart-redirect: when a signed-in user lands on '/', we route them to the
// portal that matches their role. PWA-installed users tap their home-screen
// icon to start working, not to read marketing copy — sending them to '/'
// (the manifest start_url) and bouncing them to their portal is the cleanest
// way to make the icon "just work" without per-role manifests.
//   - org_member (admin/owner)                  -> /admin
//   - instructor (active in instructors table)  -> /:slug/instructor
//   - signed-in but neither (parent / family)   -> stay on marketing
//   - not signed in                             -> stay on marketing
export default function EnropsLanding() {
  const navigate = useNavigate();
  // Track whether we've finished the role check so we don't flash marketing
  // copy for a split second before the redirect lands.
  const [roleChecked, setRoleChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!session?.user) {
          // PWA-installed user tapped the home-screen icon while signed out.
          // The marketing page is dead weight for them — bounce to the
          // sign-in flow. After sign-in we land back on /admin (admin login
          // default), and from there the layout's auth check routes them
          // correctly based on org_members / instructor role.
          //
          // Detection: display-mode: standalone fires inside an installed
          // PWA on Android + desktop Chrome; navigator.standalone is the
          // iOS Safari equivalent.
          const inPwa =
            window.matchMedia?.('(display-mode: standalone)').matches ||
            window.navigator.standalone === true;
          if (inPwa) {
            navigate('/admin/login', { replace: true });
            return;
          }
          setRoleChecked(true);
          return;
        }

        // Admin check first — owners and admins go to /admin even if they
        // also happen to be in the instructors table (rare but possible).
        const { data: member } = await supabase
          .from('org_members')
          .select('accepted_at')
          .eq('auth_user_id', session.user.id)
          .maybeSingle();
        if (cancelled) return;
        if (member?.accepted_at) {
          navigate('/admin', { replace: true });
          return;
        }

        // Instructor check.
        const { data: instructor } = await supabase
          .from('instructors')
          .select('id, organization_id')
          .eq('auth_user_id', session.user.id)
          .eq('is_active', true)
          .maybeSingle();
        if (cancelled) return;
        if (instructor) {
          // Look up the org slug so multi-tenant works. For J2S today the
          // slug is just 'j2s' but we resolve it dynamically so a second
          // tenant doesn't require code changes.
          const { data: org } = await supabase
            .from('organizations')
            .select('slug')
            .eq('id', instructor.organization_id)
            .maybeSingle();
          if (cancelled) return;
          if (org?.slug) {
            navigate(`/${org.slug}/instructor`, { replace: true });
            return;
          }
        }

        // Signed in but neither admin nor instructor — likely a parent who
        // signed up via /j2s/login. Don't auto-route; the marketing site is
        // a fine landing for that case (and they've usually bookmarked /j2s
        // directly anyway).
        setRoleChecked(true);
      } catch (err) {
        // Auth check failed — show marketing rather than blocking on errors.
        console.error('[EnropsLanding] role check failed', err);
        if (!cancelled) setRoleChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  // Hide the marketing flash while we're still resolving the role. ~100ms
  // typical, much less if the session is empty.
  if (!roleChecked) {
    return (
      <div className="brand-enrops flex min-h-screen items-center justify-center bg-enrops-cream text-enrops-ink/60">
        Loading…
      </div>
    );
  }

  return (
    <div className="brand-enrops min-h-screen bg-enrops-cream">
      <header className="border-b border-enrops-purple/10 bg-enrops-cream">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-enrops-purple text-enrops-violet">
              <span className="font-grotesk text-xl font-bold">E</span>
            </span>
            <span className="font-grotesk text-xl font-bold tracking-tight text-enrops-purple">
              Enrops
            </span>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-enrops-ink">
            <a href="#features" className="hidden hover:text-enrops-purple sm:inline">
              Platform
            </a>
            <Link
              to="/j2s"
              className="rounded-md border border-enrops-purple px-4 py-2 font-medium text-enrops-purple transition hover:bg-enrops-purple hover:text-enrops-cream"
            >
              Visit J2S
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 -z-10 opacity-60">
            <svg
              className="h-full w-full"
              preserveAspectRatio="none"
              viewBox="0 0 1200 600"
            >
              <defs>
                <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#FBFBFB" />
                  <stop offset="1" stopColor="#F4E9C8" />
                </linearGradient>
              </defs>
              <rect width="1200" height="600" fill="url(#g1)" />
              <circle cx="1100" cy="100" r="180" fill="#8C88FF" opacity="0.18" />
              <circle cx="80" cy="500" r="140" fill="#1C004F" opacity="0.10" />
            </svg>
          </div>

          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <div className="max-w-3xl">
              <span className="inline-block rounded-full bg-enrops-purple/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-enrops-purple">
                The enrichment operations platform
              </span>
              <h1 className="mt-6 font-grotesk text-5xl font-bold leading-[1.05] tracking-tight text-enrops-ink sm:text-7xl">
                Registration is just the <span className="text-enrops-purple">front door.</span>
              </h1>
              <p className="mt-6 max-w-2xl font-grotesk text-xl leading-relaxed text-enrops-ink/80">
                Enrops runs the whole operation. Parent registration, instructor scheduling,
                school-ready rosters, session recaps, and re-enrollment &mdash; all from
                one place. Built by operators, for operators.
              </p>
              <div className="mt-10 flex flex-wrap gap-3">
                <a
                  href="mailto:hello@enrops.com"
                  className="btn-enrops-primary"
                >
                  Request a demo
                </a>
                <Link
                  to="/j2s"
                  className="inline-flex items-center justify-center gap-2 rounded-md border-2 border-enrops-purple bg-transparent px-6 py-3 font-medium text-enrops-purple transition hover:bg-enrops-purple hover:text-enrops-cream"
                >
                  See it live at J2S →
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="mb-12 max-w-2xl">
            <h2 className="font-grotesk text-3xl font-bold tracking-tight text-enrops-ink sm:text-4xl">
              One platform. Every part of the operation.
            </h2>
            <p className="mt-4 font-grotesk text-lg text-enrops-ink/70">
              Stop stitching together Activity Messenger, Sawyer, Jumbula, spreadsheets, Slack, and email.
              Enrops replaces your program manager, your admin, and your ops spreadsheets &mdash; not just registration.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: 'Parent registration',
                body:
                  'Multi-child carts, sibling discounts, VIP bundles, installments, waivers, and promo codes &mdash; all built in.',
              },
              {
                title: 'Instructor management',
                body:
                  'Schedule, pay, and communicate with mobile contractors. Sub coordination without the Slack chaos.',
              },
              {
                title: 'School-ready rosters',
                body:
                  'Automatic Excel delivery with class name, homeroom teacher, room, and instructor contact. The exact format schools want.',
              },
              {
                title: 'Cross-term intelligence',
                body:
                  'Identify your highest-LTV families, your cancel-rate hotspots, and where to double down next term.',
              },
              {
                title: 'Parent portal',
                body:
                  'Session recaps, automated reminders, re-enrollment prompts. LTV grows automatically.',
              },
              {
                title: 'Built for operators with a team',
                body:
                  'Not another generic SaaS. Designed for independent operators running their own programs.',
              },
            ].map((f) => (
              <div
                key={f.title}
                className="group rounded-lg border border-enrops-purple/15 bg-white p-8 transition hover:border-enrops-purple hover:shadow-card"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-enrops-violet/20 font-grotesk font-bold text-enrops-purple">
                  &bull;
                </div>
                <h3 className="mt-5 font-grotesk text-xl font-bold text-enrops-ink">
                  {f.title}
                </h3>
                <p
                  className="mt-3 font-grotesk leading-relaxed text-enrops-ink/70"
                  dangerouslySetInnerHTML={{ __html: f.body }}
                />
              </div>
            ))}
          </div>
        </section>

        {/* CTA band */}
        <section className="bg-enrops-purple text-enrops-cream">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <h2 className="font-grotesk text-3xl font-bold tracking-tight sm:text-4xl">
                Running an enrichment program?
              </h2>
              <p className="mt-3 max-w-xl font-grotesk text-enrops-cream/80">
                We're onboarding our Founding 50 operators now. Keep your current
                Stripe account, keep your brand, get your evenings back.
              </p>
            </div>
            <a
              href="mailto:hello@enrops.com"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-enrops-violet px-8 py-4 font-grotesk font-bold text-enrops-ink transition hover:bg-enrops-cream"
            >
              Get early access →
            </a>
          </div>
        </section>
      </main>

      <footer className="bg-enrops-ink text-enrops-cream/70">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 font-grotesk text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <span className="font-grotesk font-bold text-enrops-cream">Enrops</span>
            <span className="text-enrops-cream/50">
              &copy; {new Date().getFullYear()} &middot; The enrichment operations platform
            </span>
          </div>
          <div className="flex gap-6">
            <Link to="/j2s" className="hover:text-enrops-cream">
              Journey to STEAM
            </Link>
            <Link to="/privacy" className="hover:text-enrops-cream">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-enrops-cream">
              Terms
            </Link>
            <a href="mailto:hello@enrops.com" className="hover:text-enrops-cream">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
