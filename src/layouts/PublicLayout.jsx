// PublicLayout — the parent-facing layout for any tenant.
//
// Replaces the J2S-hardcoded J2SLayout. Resolves the tenant from the URL slug
// (`/:slug/*`), fetches the org, provides it to children via Outlet context,
// and renders branding:
//   - When slug === 'j2s', use J2S brand (purple/orange, J2S name/contact/etc.)
//     to keep the live J2S experience identical.
//   - For any other tenant, render the Enrops base brand (clean platform shell).
//     Per-tenant branding (logo, colors, copy) is queued as the next pass —
//     see the backlog item on multi-tenant public-site branding.
//
// If the slug doesn't resolve to an active org, render a "not found" message
// rather than silently leaking another tenant's content.

import React, { useEffect, useState } from 'react';
import { Outlet, Link, useLocation, NavLink, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase } from '../lib/supabase.js';
import PwaInstallButton from '../components/pwa/PwaInstallButton.jsx';
import PortalSwitcher from '../components/PortalSwitcher.jsx';
import { fetchPublishedPolicyTypes, PLATFORM_LEGAL_LINKS } from '../lib/policies.js';

const ENROPS_PURPLE = '#1C004F';
const ENROPS_VIOLET = '#8C88FF';
const ENROPS_CREAM = '#FBFBFB';

export default function PublicLayout() {
  const { slug } = useParams();
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [org, setOrg] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ok | not_found
  // Which legal docs THIS provider has published. Most have none, so the footer
  // only links what actually renders. Enrops' platform docs link unconditionally.
  const [policyTypes, setPolicyTypes] = useState(new Set());

  useEffect(() => {
    if (!slug) { setLoadState('not_found'); return; }
    let cancelled = false;
    (async () => {
      setLoadState('loading');
      const { data, error } = await supabase
        .from('public_org_directory')
        .select('id, slug, name, logo_url, status, active_registration_term, instructor_pay_model')
        .eq('slug', slug)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) { setLoadState('not_found'); return; }
      // Resolve the published policy list BEFORE flipping to 'ok'. Setting
      // 'ok' first would render the footer with an empty set, so J2S's real
      // Privacy/Terms links would vanish for a frame and then pop back in.
      const types = await fetchPublishedPolicyTypes(data.id);
      if (cancelled) return;
      setPolicyTypes(types);
      setOrg(data);
      setLoadState('ok');
    })();
    return () => { cancelled = true; };
  }, [slug]);

  if (loadState === 'loading') {
    return (
      <div style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b6b6b' }}>
        Loading…
      </div>
    );
  }

  if (loadState === 'not_found') {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: '#1a1a1a' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>We couldn&rsquo;t find that page.</h1>
        <p style={{ color: '#6b6b6b', maxWidth: 480 }}>
          The link you followed may be old or the operator&rsquo;s URL may have changed.
        </p>
        <Link to="/" style={{ marginTop: 16, color: ENROPS_PURPLE, fontWeight: 600 }}>
          Back to Enrops →
        </Link>
      </div>
    );
  }

  // J2S keeps its existing brand to avoid disturbing the live experience.
  // Everyone else gets the Enrops base brand for now — per-tenant theming is
  // a separate backlog item.
  if (org.slug === 'j2s') {
    return <J2SBrandedShell org={org} user={user} signOut={signOut} location={location} policyTypes={policyTypes} />;
  }
  return <EnropsBrandedShell org={org} user={user} signOut={signOut} location={location} policyTypes={policyTypes} />;
}

// ─── J2S brand (unchanged behavior; lifted from the old J2SLayout) ──────────
function J2SBrandedShell({ org, user, signOut, location, policyTypes }) {
  const home = `/${org.slug}`;
  return (
    <div className="brand-j2s min-h-screen flex flex-col bg-white">
      <header className="sticky top-0 z-30 border-b border-j2s-purple/10 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to={home} className="flex items-center gap-3">
            <img
              src={org?.logo_url || ''}
              alt={org?.name || ''}
              className={`h-16 w-auto transition-opacity duration-150 ${org?.logo_url ? 'opacity-100' : 'opacity-0'}`}
            />
          </Link>
          <nav className="flex items-center gap-2 text-sm font-semibold sm:gap-6">
            <PwaInstallButton />
            {user ? (
              <>
                <PortalSwitcher current="family" slug={org.slug} />
                <NavLink to={`${home}/dashboard`} className={({ isActive }) => `rounded-lg px-3 py-2 transition ${isActive ? 'bg-j2s-purple-soft text-j2s-purple-dark' : 'text-j2s-ink hover:bg-j2s-purple-soft'}`}>
                  My account
                </NavLink>
                <button onClick={() => signOut()} className="text-j2s-ink/70 hover:text-j2s-ink">Sign out</button>
              </>
            ) : (
              !location.pathname.includes('/login') && (
                <Link to={`${home}/login`} className="rounded-lg px-3 py-2 text-j2s-ink hover:bg-j2s-purple-soft">Sign in</Link>
              )
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet context={{ org }} />
      </main>
      <footer className="mt-12 border-t border-j2s-purple/10 bg-j2s-ink text-white/80">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="grid gap-8 sm:grid-cols-3">
            <div>
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg text-white" style={{ background: 'linear-gradient(135deg, #674EE8, #F8A638)' }}>
                  <span className="font-titan text-sm">J2S</span>
                </span>
                <span className="font-titan text-lg text-white">Journey to STEAM</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed">Hands-on STEAM enrichment across Portland-area schools.</p>
            </div>
            <div>
              <h4 className="font-titan text-sm uppercase tracking-wider text-j2s-orange">Contact</h4>
              <p className="mt-3 text-sm">
                <a href="mailto:support@journeytosteam.com" className="hover:text-white">support@journeytosteam.com</a>
                <br />
                <a href="tel:+19712582178" className="hover:text-white">(971) 258-2178</a>
              </p>
            </div>
            <div>
              <h4 className="font-grotesk text-xs uppercase tracking-widest" style={{ color: '#8C88FF' }}>Powered by</h4>
              <Link to="/" className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-2 transition hover:opacity-90" style={{ background: '#1C004F', color: '#FBFBFB' }}>
                <span className="font-grotesk text-sm font-bold tracking-tight">Enrops</span>
                <span className="text-xs" style={{ color: '#8C88FF' }}>→</span>
              </Link>
              <p className="mt-2 text-xs text-white/50">The enrichment operations platform.</p>
              {/* Platform legal — governs every account regardless of provider,
                  so it sits with the "Powered by" badge, not mixed in with the
                  provider's own documents below. */}
              <div className="mt-3 flex items-center gap-3 text-xs text-white/40">
                {PLATFORM_LEGAL_LINKS.map((l) => (
                  <Link key={l.to} to={l.to} className="hover:text-white/70">{l.label}</Link>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-8 flex flex-col items-start justify-between gap-2 border-t border-white/10 pt-6 text-xs text-white/50 sm:flex-row sm:items-center">
            <div>&copy; {new Date().getFullYear()} Journey to STEAM. Future-ready skills, right after school.</div>
            {/* Only link what this provider has actually published. */}
            <div className="flex items-center gap-4">
              {policyTypes?.has('privacy') && (
                <Link to={`${home}/privacy`} className="hover:text-white">Privacy Policy</Link>
              )}
              {policyTypes?.has('terms') && (
                <Link to={`${home}/terms`} className="hover:text-white">Terms of Service</Link>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── Enrops base brand (used for every non-J2S tenant for now) ──────────────
// Intentionally clean and platform-neutral. Per-tenant branding (logos, colors,
// custom copy) is the next pass — captured as a backlog item.
function EnropsBrandedShell({ org, user, signOut, location, policyTypes }) {
  const home = `/${org.slug}`;
  return (
    <div className="brand-enrops-public" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: ENROPS_CREAM, color: '#1a1a1a', fontFamily: 'inherit' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 30, background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(6px)', borderBottom: '1px solid #e2dfd5' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <Link to={home} style={{ display: 'flex', alignItems: 'center', gap: 10, color: ENROPS_PURPLE, fontWeight: 700, fontSize: 18, textDecoration: 'none' }}>
            {org.logo_url ? (
              <img src={org.logo_url} alt={org.name} style={{ height: 40, width: 'auto' }} />
            ) : (
              <span style={{ fontWeight: 700 }}>{org.name}</span>
            )}
          </Link>
          <nav style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 14, fontWeight: 600 }}>
            <PwaInstallButton />
            {user ? (
              <>
                <PortalSwitcher current="family" slug={org.slug} />
                <NavLink to={`${home}/dashboard`} style={({ isActive }) => ({ padding: '6px 12px', borderRadius: 6, color: isActive ? ENROPS_PURPLE : '#1a1a1a', textDecoration: 'none', background: isActive ? `${ENROPS_VIOLET}22` : 'transparent' })}>
                  My account
                </NavLink>
                <button onClick={() => signOut()} style={{ background: 'transparent', border: 'none', color: '#6b6b6b', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                  Sign out
                </button>
              </>
            ) : (
              !location.pathname.includes('/login') && (
                <Link to={`${home}/login`} style={{ padding: '6px 12px', borderRadius: 6, color: '#1a1a1a', textDecoration: 'none' }}>
                  Sign in
                </Link>
              )
            )}
          </nav>
        </div>
      </header>

      <main style={{ flex: 1 }}>
        <Outlet context={{ org }} />
      </main>

      <footer style={{ marginTop: 48, background: ENROPS_PURPLE, color: 'rgba(255,255,255,0.8)' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13 }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>{org.name}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
            <div>
              &copy; {new Date().getFullYear()} {org.name}. Powered by{' '}
              <Link to="/" style={{ color: ENROPS_VIOLET, textDecoration: 'none' }}>Enrops</Link>.
            </div>
            {/* Provider's own docs only when published; Enrops platform docs
                always, since they govern the account either way. */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {policyTypes?.has('privacy') && (
                <Link to={`${home}/privacy`} style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none' }}>Privacy</Link>
              )}
              {policyTypes?.has('terms') && (
                <Link to={`${home}/terms`} style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none' }}>Terms</Link>
              )}
              {PLATFORM_LEGAL_LINKS.map((l) => (
                <Link key={l.to} to={l.to} style={{ color: 'rgba(255,255,255,0.45)', textDecoration: 'none' }}>{l.label}</Link>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
