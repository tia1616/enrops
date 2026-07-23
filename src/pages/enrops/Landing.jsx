import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { parentLandingPath } from '../../lib/tenants.js';
import EnropsWordmark from '../../components/EnropsWordmark.jsx';

// enrops.com home page.
//
// Per Arielle's homepage brief (2026-06-09): enrops.com is the PLATFORM entry
// point, NOT a marketing page (that's getenrops.com). State 1 (pre-launch /
// invite-only): cohort members log in; everyone else is sent to getenrops.com
// to request access. State 2 (self-serve, future) swaps the copy — Arielle will
// say when. Marketing-brand palette (deep purple / violet / mint), intentionally
// distinct from the app's indigo interior (Jessica's call 2026-06-09).
//
// Smart-redirect: when a signed-in user lands on '/', we route them to the
// portal that matches their role (better than the spec's generic /dashboard).
//   - org_member (admin/owner)                  -> /admin
//   - instructor (active in instructors table)  -> /:slug/instructor
//   - signed-in but neither (parent / family)   -> /j2s (parent portal)
//   - not signed in + PWA                       -> /admin/login (universal)
//   - not signed in + browser                   -> render State 1
export default function EnropsLanding({ signedOutTo = null } = {}) {
  const navigate = useNavigate();
  // Track whether we've finished the role check so we don't flash the State-1
  // card for a split second before a signed-in user's redirect lands.
  const [roleChecked, setRoleChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!session?.user) {
          // PWA-installed user tapped the home-screen icon while signed out.
          // The card is dead weight for them — bounce to the sign-in flow.
          // Detection: display-mode: standalone fires inside an installed PWA
          // on Android + desktop Chrome; navigator.standalone is iOS Safari.
          const inPwa =
            window.matchMedia?.('(display-mode: standalone)').matches ||
            window.navigator.standalone === true;
          const signedOutTarget = signedOutTo || (inPwa ? '/login' : null);
          if (signedOutTarget) {
            navigate(signedOutTarget, { replace: true });
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
          const { data: org } = await supabase
            .from('public_org_directory')
            .select('slug')
            .eq('id', instructor.organization_id)
            .maybeSingle();
          if (cancelled) return;
          if (org?.slug) {
            navigate(`/${org.slug}/instructor`, { replace: true });
            return;
          }
        }

        // Signed in but neither admin nor instructor — they're a parent.
        navigate(parentLandingPath(session.user.id), { replace: true });
        return;
      } catch (err) {
        // Auth check failed — show the card rather than blocking on errors.
        console.error('[EnropsLanding] role check failed', err);
        if (!cancelled) setRoleChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [navigate, signedOutTo]);

  // Deep-purple holding screen while we resolve the role — avoids a flash of
  // the card before a signed-in user redirects to their portal.
  if (!roleChecked) {
    return (
      <div style={{
        minHeight: '100vh', background: '#1C004F', color: 'rgba(255,255,255,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Poppins', system-ui, sans-serif",
      }}>
        Loading&hellip;
      </div>
    );
  }

  // State 1 — pre-launch / invite-only entry point.
  return (
    <div className="enr-home">
      <style>{`
        .enr-home {
          --deep-purple:#1C004F; --vivid-violet:#8C88FF; --mint-green:#26D687;
          --soft-lilac:#F2F0FF; --text-muted:#9B9FBB;
          min-height:100vh; background:var(--deep-purple); color:#fff;
          font-family:'Poppins',system-ui,sans-serif; -webkit-font-smoothing:antialiased;
          display:flex; flex-direction:column; align-items:center; justify-content:center;
          padding:24px; box-sizing:border-box;
        }
        .enr-home .home-logo { margin-bottom:48px; }
        .enr-home .home-card {
          width:100%; max-width:440px; background:rgba(255,255,255,0.06);
          border:1px solid rgba(255,255,255,0.1); border-radius:16px;
          padding:40px 36px; text-align:center; box-sizing:border-box;
        }
        .enr-home .status-chip {
          display:inline-flex; align-items:center; gap:8px;
          background:rgba(38,214,135,0.12); border:1px solid rgba(38,214,135,0.3);
          border-radius:100px; padding:6px 14px; margin-bottom:24px;
        }
        .enr-home .status-chip .dot {
          width:7px; height:7px; border-radius:50%; background:var(--mint-green);
          flex-shrink:0; animation:enrHomePulse 2s ease-in-out infinite;
        }
        .enr-home .status-chip span {
          font-size:12px; font-weight:500; color:var(--mint-green); letter-spacing:0.01em;
        }
        @keyframes enrHomePulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
        .enr-home h1 { font-size:24px; font-weight:700; line-height:1.35; margin-bottom:12px; color:#fff; }
        .enr-home p.lede { font-size:15px; font-weight:400; line-height:1.65; color:var(--text-muted); margin-bottom:32px; }
        .enr-home .btn-primary {
          display:block; width:100%; padding:14px 24px; background:var(--mint-green);
          color:var(--deep-purple); font-family:inherit; font-size:15px; font-weight:600;
          border:none; border-radius:10px; cursor:pointer; text-decoration:none; text-align:center;
          transition:opacity 0.15s ease, transform 0.1s ease; margin-bottom:12px;
        }
        .enr-home .btn-primary:hover { opacity:0.9; transform:translateY(-1px); }
        .enr-home .btn-primary:active { transform:translateY(0); }
        .enr-home .btn-secondary {
          display:block; width:100%; padding:14px 24px; background:transparent;
          color:var(--soft-lilac); font-family:inherit; font-size:15px; font-weight:500;
          border:1px solid rgba(255,255,255,0.2); border-radius:10px; cursor:pointer;
          text-decoration:none; text-align:center; transition:border-color 0.15s ease, color 0.15s ease;
        }
        .enr-home .btn-secondary:hover { border-color:rgba(255,255,255,0.45); color:#fff; }
        .enr-home .divider { display:flex; align-items:center; gap:12px; margin:16px 0; color:var(--text-muted); font-size:13px; }
        .enr-home .divider::before, .enr-home .divider::after { content:''; flex:1; height:1px; background:rgba(255,255,255,0.1); }
        .enr-home .footer-link { margin-top:32px; font-size:13px; color:var(--text-muted); }
        .enr-home .footer-link a { color:var(--vivid-violet); text-decoration:none; font-weight:500; }
        .enr-home .footer-link a:hover { text-decoration:underline; }
        .enr-home .bottom-wordmark { margin-top:24px; font-size:12px; color:rgba(255,255,255,0.2); letter-spacing:0.02em; }
        @media (max-width:480px){ .enr-home .home-card{ padding:28px 20px; } .enr-home h1{ font-size:20px; } }
      `}</style>

      <div className="home-logo">
        <EnropsWordmark height={32} color="#FFFFFF" />
      </div>

      <div className="home-card">
        <div className="status-chip">
          <span className="dot" />
          <span>Founding cohort &mdash; now open</span>
        </div>

        <h1>The platform is ready for<br />founding members.</h1>
        <p className="lede">
          If you&rsquo;re on the list, you can log in below.<br />
          Not on the list yet? Get early access at getenrops.com.
        </p>

        <Link to="/login" className="btn-primary">Log in to enrops</Link>

        <div className="divider">or</div>

        <a
          href="https://getenrops.com/join"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
        >
          Get early access &rarr;
        </a>
      </div>

      <p className="footer-link">
        Questions? <a href="mailto:jessica@enrops.com">jessica@enrops.com</a>
      </p>
      <p className="bottom-wordmark">enrops &middot; Everything your enrichment business runs on</p>
    </div>
  );
}
