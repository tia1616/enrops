import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function signInWithGoogle(redirectTo) {
    return supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
  }

  // signInWithMagicLink was REMOVED, deliberately. It called signInWithOtp with
  // `shouldCreateUser: true` and Supabase's default (unbranded) email, and its last
  // caller - the post-checkout confirmation page - now uses the `auth-send-magic-link`
  // edge function like every other sign-in surface in the app.
  //
  // Not left in place "in case someone needs it": it is the wrong door. Any future
  // caller reaching for a magic link from a public page would silently get arbitrary
  // account creation and an off-brand email, which is exactly the defect that led to
  // deleting it. Use `supabase.functions.invoke('auth-send-magic-link', { body: {
  // email, redirect_to, context, org_id } })` - it no-ops on unknown addresses and
  // sends through the tenant's own branding. See Login.jsx for the parent-facing
  // pattern, including the anti-enumeration wording its response requires.

  async function signOut() {
    return supabase.auth.signOut();
  }

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    signInWithGoogle,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
