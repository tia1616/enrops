import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import EnropsWordmark from '../../components/EnropsWordmark.jsx';

// enrops.com/signup — self-serve OPERATOR signup (Registration MVP, Chunk 1).
//
// Cold operators (dance studios, martial-arts gyms, music schools) arrive here
// from marketing campaigns. Flow, all card-free:
//   1. Passwordless auth (Google or magic link) — no credit card, no password.
//   2. Once signed in with NO org, they type ONLY their business name.
//   3. provision_operator_org() atomically stands up their org + owner + defaults
//      (fee model, a seeded waiver, the lean generic form) and returns their slug.
//   4. We reveal their live URL, then send them in to build their first program.
//
// A signed-in user who ALREADY owns an org is bounced straight to /admin (their
// account is one-org, so re-visiting /signup just resumes them).

const DEEP = '#1C004F';
const VIOLET = '#8C88FF';
const MINT = '#26D687';
const LILAC = '#F2F0FF';
const MUTED = '#9B9FBB';

// Map raw errors to plain operator-facing language (no jargon).
function friendly(err) {
  const m = (err?.message || String(err || '')).toLowerCase();
  if (m.includes('not authenticated')) return 'Your sign-in expired — please sign in again.';
  if (m.includes('email unavailable')) return "We couldn't read your email from sign-in. Please try signing in again.";
  if (m.includes('business name')) return 'Please enter your business name.';
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) return 'Network hiccup — please try again.';
  return "Sorry, that didn't work. Please try again.";
}

export default function OperatorSignup() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState('loading'); // loading | auth | name | done
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [createdSlug, setCreatedSlug] = useState('');

  // On mount: resolve where the visitor is in the flow. We check the current
  // session AND subscribe to auth changes, because after the Google OAuth
  // redirect the session may be parsed from the URL slightly after mount —
  // getSession() alone can miss it and flash the auth screen at a signed-in user.
  useEffect(() => {
    let cancelled = false;
    async function resolve(session) {
      if (cancelled) return;
      if (!session?.user) { setPhase('auth'); return; }
      try {
        // Signed in — do they already own an org?
        const { data: member } = await supabase
          .from('org_members')
          .select('organization_id')
          .eq('auth_user_id', session.user.id)
          .eq('role', 'owner')
          .maybeSingle();
        if (cancelled) return;
        if (member) { navigate('/admin', { replace: true }); return; }
        setPhase('name');
      } catch (err) {
        if (!cancelled) { console.error('[OperatorSignup] resolve failed', err); setPhase('auth'); }
      }
    }
    supabase.auth.getSession()
      .then(({ data: { session } }) => resolve(session))
      .catch(() => { if (!cancelled) setPhase('auth'); });
    const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) resolve(session);
    });
    return () => { cancelled = true; authSub?.subscription?.unsubscribe?.(); };
  }, [navigate]);

  async function handleGoogle() {
    setLoading(true); setError('');
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/signup` },
    });
    if (err) { setError(friendly(err)); setLoading(false); }
    // On success the browser redirects to Google; we return to /signup after.
  }

  async function handleMagicLink() {
    if (!email) return;
    setLoading(true); setError(''); setMsg('');
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('auth-send-magic-link', {
        body: { email, redirect_to: `${window.location.origin}/signup`, context: 'signup' },
      });
      if (fnErr) throw fnErr;
      if (data?.error) throw new Error(data.error);
      setMsg(`Check ${email} for your sign-in link, then you're one step from live.`);
    } catch (err) {
      setError(friendly(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    const name = businessName.trim();
    if (!name) { setError('Please enter your business name.'); return; }
    setLoading(true); setError('');
    const { data, error: err } = await supabase.rpc('provision_operator_org', { p_business_name: name });
    setLoading(false);
    if (err) { setError(friendly(err)); return; }
    if (data?.already_existed) { navigate('/admin', { replace: true }); return; }
    setCreatedSlug(data.slug);
    setPhase('done');
  }

  return (
    <div className="enr-signup">
      <style>{`
        .enr-signup {
          --deep:${DEEP}; --violet:${VIOLET}; --mint:${MINT}; --lilac:${LILAC}; --muted:${MUTED};
          min-height:100vh; background:var(--deep); color:#fff;
          font-family:'Poppins',system-ui,sans-serif; -webkit-font-smoothing:antialiased;
          display:flex; flex-direction:column; align-items:center; justify-content:center;
          padding:24px; box-sizing:border-box;
        }
        .enr-signup .logo { margin-bottom:36px; }
        .enr-signup .card {
          width:100%; max-width:440px; background:rgba(255,255,255,0.06);
          border:1px solid rgba(255,255,255,0.1); border-radius:16px;
          padding:36px 34px; box-sizing:border-box;
        }
        .enr-signup .chip {
          display:inline-flex; align-items:center; gap:8px; background:rgba(38,214,135,0.12);
          border:1px solid rgba(38,214,135,0.3); border-radius:100px; padding:6px 14px; margin-bottom:20px;
        }
        .enr-signup .chip .dot { width:7px; height:7px; border-radius:50%; background:var(--mint); }
        .enr-signup .chip span { font-size:12px; font-weight:500; color:var(--mint); }
        .enr-signup h1 { font-size:23px; font-weight:700; line-height:1.3; margin:0 0 8px; }
        .enr-signup p.lede { font-size:14px; line-height:1.6; color:var(--muted); margin:0 0 24px; }
        .enr-signup label { display:block; font-size:12px; font-weight:600; letter-spacing:0.04em;
          text-transform:uppercase; color:var(--lilac); margin-bottom:6px; }
        .enr-signup input {
          width:100%; padding:12px 14px; background:rgba(255,255,255,0.06); color:#fff;
          border:1px solid rgba(255,255,255,0.18); border-radius:10px; font-size:15px;
          font-family:inherit; box-sizing:border-box; margin-bottom:16px;
        }
        .enr-signup input::placeholder { color:rgba(255,255,255,0.35); }
        .enr-signup input:focus { outline:none; border-color:var(--violet); }
        .enr-signup .btn-mint {
          display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:14px 20px;
          background:var(--mint); color:var(--deep); font-family:inherit; font-size:15px; font-weight:700;
          border:none; border-radius:10px; cursor:pointer; transition:opacity .15s, transform .1s; margin-bottom:12px;
        }
        .enr-signup .btn-mint:disabled { opacity:0.55; cursor:default; }
        .enr-signup .btn-mint:not(:disabled):hover { opacity:0.92; transform:translateY(-1px); }
        .enr-signup .btn-ghost {
          display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:12px 20px;
          background:#fff; color:#1a1a1a; font-family:inherit; font-size:14px; font-weight:600;
          border:none; border-radius:10px; cursor:pointer; margin-bottom:16px;
        }
        .enr-signup .divider { display:flex; align-items:center; gap:12px; margin:4px 0 16px;
          color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.06em; }
        .enr-signup .divider::before, .enr-signup .divider::after {
          content:''; flex:1; height:1px; background:rgba(255,255,255,0.1); }
        .enr-signup .note { font-size:12.5px; color:var(--muted); margin:2px 0 0; }
        .enr-signup .url-reveal {
          background:rgba(38,214,135,0.08); border:1px solid rgba(38,214,135,0.25); border-radius:10px;
          padding:14px 16px; margin:4px 0 20px; word-break:break-all; }
        .enr-signup .url-reveal .u { color:var(--mint); font-weight:700; font-size:15px; }
        .enr-signup .alert { margin-top:14px; padding:11px 13px; border-radius:8px; font-size:13px; }
        .enr-signup .alert.err { background:rgba(255,120,140,0.12); border:1px solid rgba(255,120,140,0.3); color:#ffb3c0; }
        .enr-signup .alert.ok { background:rgba(38,214,135,0.12); border:1px solid rgba(38,214,135,0.3); color:var(--mint); }
        .enr-signup .foot { margin-top:26px; font-size:12px; color:rgba(255,255,255,0.3); }
        .enr-signup .foot a { color:var(--violet); text-decoration:none; }
        @media (max-width:480px){ .enr-signup .card{ padding:26px 20px; } .enr-signup h1{ font-size:20px; } }
      `}</style>

      <div className="logo"><EnropsWordmark height={30} color="#FFFFFF" /></div>

      <div className="card">
        {phase === 'loading' && <p className="lede" style={{ margin: 0 }}>Loading&hellip;</p>}

        {phase === 'auth' && (
          <>
            <div className="chip"><span className="dot" /><span>Free to start &mdash; no credit card</span></div>
            <h1>Get your registration page live in minutes.</h1>
            <p className="lede">Sign in to start &mdash; then just name your program and share your link. Free for operators.</p>

            <button type="button" className="btn-ghost" onClick={handleGoogle} disabled={loading}>
              <GoogleG /> Continue with Google
            </button>

            <div className="divider">or</div>

            <label htmlFor="su-email">Email</label>
            <input id="su-email" type="email" value={email} placeholder="you@yourstudio.com"
              autoComplete="email" onChange={e => setEmail(e.target.value)} />
            <button type="button" className="btn-mint" onClick={handleMagicLink} disabled={loading || !email}>
              {loading ? 'Sending…' : 'Email me a sign-in link'}
            </button>

            {error && <div className="alert err">{error}</div>}
            {msg && <div className="alert ok">{msg}</div>}
          </>
        )}

        {phase === 'name' && (
          <form onSubmit={handleCreate}>
            <div className="chip"><span className="dot" /><span>One step from live</span></div>
            <h1>What&rsquo;s your business called?</h1>
            <p className="lede">This names your registration page. You can change your page address later in Settings.</p>

            <label htmlFor="su-name">Business name</label>
            <input id="su-name" type="text" value={businessName} placeholder="e.g. Sarah&rsquo;s Dance Studio"
              autoFocus onChange={e => setBusinessName(e.target.value)} />
            <button type="submit" className="btn-mint" disabled={loading || !businessName.trim()}>
              {loading ? 'Creating your page…' : 'Create my free page →'}
            </button>

            {error && <div className="alert err">{error}</div>}
          </form>
        )}

        {phase === 'done' && (
          <>
            <div className="chip"><span className="dot" /><span>You&rsquo;re live</span></div>
            <h1>Your registration page is ready.</h1>
            <div className="url-reveal">
              <span className="u">enrops.com/{createdSlug}</span>
            </div>
            <p className="note" style={{ marginBottom: 20 }}>You can change this address anytime in Settings.</p>
            <button type="button" className="btn-mint" onClick={() => navigate('/admin', { replace: true })}>
              Build your first program →
            </button>
          </>
        )}
      </div>

      <p className="foot">Questions? <a href="mailto:hello@enrops.com">hello@enrops.com</a></p>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
  );
}
