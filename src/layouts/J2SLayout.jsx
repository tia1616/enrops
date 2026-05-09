import React, { useEffect, useState } from 'react';
import { Outlet, Link, useLocation, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase } from '../lib/supabase.js';

export default function J2SLayout() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [org, setOrg] = useState(null);

  // Fetch the J2S organization row once on mount so we can show the logo.
  // Designed to be multi-tenant: when other operators onboard, this same pattern
  // fetches their branding based on the URL slug.
  useEffect(() => {
    let cancelled = false;
    async function loadOrg() {
      const { data } = await supabase
        .from('organizations')
        .select('id, name, logo_url')
        .eq('slug', 'j2s')
        .single();
      if (!cancelled && data) setOrg(data);
    }
    loadOrg();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="brand-j2s min-h-screen flex flex-col bg-white">
      <header className="sticky top-0 z-30 border-b border-j2s-purple/10 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/j2s" className="flex items-center gap-3">
            {/* Reserve logo space always (h-16) so header height is stable.
                Image fades in when loaded. No text-badge fallback to prevent flash. */}
            <img
              src={org?.logo_url || ''}
              alt={org?.name || ''}
              className={`h-16 w-auto transition-opacity duration-150 ${
                org?.logo_url ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </Link>
          <nav className="flex items-center gap-2 text-sm font-semibold sm:gap-6">
            {user ? (
              <>
                <NavLink
                  to="/j2s/dashboard"
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-2 transition ${
                      isActive
                        ? 'bg-j2s-purple-soft text-j2s-purple-dark'
                        : 'text-j2s-ink hover:bg-j2s-purple-soft'
                    }`
                  }
                >
                  My account
                </NavLink>
                <button
                  onClick={() => signOut()}
                  className="text-j2s-ink/70 hover:text-j2s-ink"
                >
                  Sign out
                </button>
              </>
            ) : (
              !location.pathname.includes('/login') && (
                <Link
                  to="/j2s/login"
                  className="rounded-lg px-3 py-2 text-j2s-ink hover:bg-j2s-purple-soft"
                >
                  Sign in
                </Link>
              )
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="mt-12 border-t border-j2s-purple/10 bg-j2s-ink text-white/80">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="grid gap-8 sm:grid-cols-3">
            <div>
              <div className="flex items-center gap-3">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-white"
                  style={{ background: 'linear-gradient(135deg, #674EE8, #F8A638)' }}
                >
                  <span className="font-titan text-sm">J2S</span>
                </span>
                <span className="font-titan text-lg text-white">Journey to STEAM</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed">
                Hands-on STEAM enrichment across Portland-area schools.
              </p>
            </div>
            <div>
              <h4 className="font-titan text-sm uppercase tracking-wider text-j2s-orange">
                Contact
              </h4>
              <p className="mt-3 text-sm">
                <a href="mailto:info@journeytosteam.com" className="hover:text-white">
                  info@journeytosteam.com
                </a>
                <br />
                <a href="tel:+19712582178" className="hover:text-white">
                  (971) 258-2178
                </a>
              </p>
            </div>
            <div>
              <h4
                className="font-grotesk text-xs uppercase tracking-widest"
                style={{ color: '#CFB12F' }}
              >
                Powered by
              </h4>
              <Link
                to="/"
                className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-2 transition hover:opacity-90"
                style={{ background: '#691D39', color: '#EAEADD' }}
              >
                <span className="font-grotesk text-sm font-bold tracking-tight">Enrops</span>
                <span className="text-xs" style={{ color: '#CFB12F' }}>→</span>
              </Link>
              <p className="mt-2 text-xs text-white/50">
                The enrichment operations platform.
              </p>
            </div>
          </div>
          <div className="mt-8 flex flex-col items-start justify-between gap-2 border-t border-white/10 pt-6 text-xs text-white/50 sm:flex-row sm:items-center">
            <div>
              &copy; {new Date().getFullYear()} Journey to STEAM. Future-ready skills, right after school.
            </div>
            <div className="flex items-center gap-4">
              <Link to="/j2s/privacy" className="hover:text-white">
                Privacy Policy
              </Link>
              <Link to="/j2s/terms" className="hover:text-white">
                Terms of Service
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
