import React from 'react';
import { Link } from 'react-router-dom';

// PwaInstallButton intentionally NOT mounted on the Enrops marketing landing.
// First-time visitors haven't signed up yet — installing a SaaS app shell
// they can't actually use is friction without value. The install affordance
// lives on the authenticated portals (admin, instructor, J2S parent) where
// the user already has a reason to come back.
export default function EnropsLanding() {
  return (
    <div className="brand-enrops min-h-screen bg-enrops-chalk">
      <header className="border-b border-enrops-plum/10 bg-enrops-chalk">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-6">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-enrops-plum text-enrops-gold">
              <span className="font-grotesk text-xl font-bold">E</span>
            </span>
            <span className="font-grotesk text-xl font-bold tracking-tight text-enrops-plum">
              Enrops
            </span>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-enrops-ink">
            <a href="#features" className="hidden hover:text-enrops-plum sm:inline">
              Platform
            </a>
            <Link
              to="/j2s"
              className="rounded-md border border-enrops-plum px-4 py-2 font-medium text-enrops-plum transition hover:bg-enrops-plum hover:text-enrops-chalk"
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
                  <stop offset="0" stopColor="#EAEADD" />
                  <stop offset="1" stopColor="#F4E9C8" />
                </linearGradient>
              </defs>
              <rect width="1200" height="600" fill="url(#g1)" />
              <circle cx="1100" cy="100" r="180" fill="#CFB12F" opacity="0.18" />
              <circle cx="80" cy="500" r="140" fill="#691D39" opacity="0.10" />
            </svg>
          </div>

          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <div className="max-w-3xl">
              <span className="inline-block rounded-full bg-enrops-plum/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-enrops-plum">
                The enrichment operations platform
              </span>
              <h1 className="mt-6 font-grotesk text-5xl font-bold leading-[1.05] tracking-tight text-enrops-ink sm:text-7xl">
                Registration is just the <span className="text-enrops-plum">front door.</span>
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
                  className="inline-flex items-center justify-center gap-2 rounded-md border-2 border-enrops-plum bg-transparent px-6 py-3 font-medium text-enrops-plum transition hover:bg-enrops-plum hover:text-enrops-chalk"
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
                className="group rounded-lg border border-enrops-plum/15 bg-white p-8 transition hover:border-enrops-plum hover:shadow-card"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-enrops-gold/20 font-grotesk font-bold text-enrops-plum">
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
        <section className="bg-enrops-plum text-enrops-chalk">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <h2 className="font-grotesk text-3xl font-bold tracking-tight sm:text-4xl">
                Running an enrichment program?
              </h2>
              <p className="mt-3 max-w-xl font-grotesk text-enrops-chalk/80">
                We're onboarding our Founding 50 operators now. Keep your current
                Stripe account, keep your brand, get your evenings back.
              </p>
            </div>
            <a
              href="mailto:hello@enrops.com"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-enrops-gold px-8 py-4 font-grotesk font-bold text-enrops-ink transition hover:bg-enrops-chalk"
            >
              Get early access →
            </a>
          </div>
        </section>
      </main>

      <footer className="bg-enrops-ink text-enrops-chalk/70">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 font-grotesk text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <span className="font-grotesk font-bold text-enrops-chalk">Enrops</span>
            <span className="text-enrops-chalk/50">
              &copy; {new Date().getFullYear()} &middot; The enrichment operations platform
            </span>
          </div>
          <div className="flex gap-6">
            <Link to="/j2s" className="hover:text-enrops-chalk">
              Journey to STEAM
            </Link>
            <Link to="/privacy" className="hover:text-enrops-chalk">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-enrops-chalk">
              Terms
            </Link>
            <a href="mailto:hello@enrops.com" className="hover:text-enrops-chalk">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
