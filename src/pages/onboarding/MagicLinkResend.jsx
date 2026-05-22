import React, { useState } from 'react';
import { supabase } from '../../lib/supabase.js';

// Magic link resend form embedded in /error?reason=link_expired.
//
// Anti-enumeration: we always show the same success message regardless of
// whether the email matched a real instructor. The resend-onboarding-invite
// edge function (chunk 2 Function 17) returns { success: true } in both
// cases. The function rate-limits at 60 minutes; we additionally disable the
// button for 60 seconds to prevent rapid-click double-sends.
//
// No tenant branding — we don't know which tenant this user belongs to.

export default function MagicLinkResend() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(0);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || busy) return;
    setBusy(true);
    try {
      await supabase.functions.invoke('resend-onboarding-invite', {
        body: { email: email.trim() },
      });
    } catch {
      // Swallow — anti-enumeration. We still want to show the generic success
      // message even on transport failure, so a network sniffer can't tell
      // whether the email exists by watching for retries.
    } finally {
      setSent(true);
      setBusy(false);
      setCooldownLeft(60);
      const interval = setInterval(() => {
        setCooldownLeft((n) => {
          if (n <= 1) {
            clearInterval(interval);
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    }
  }

  if (sent) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-700">
        <p className="font-semibold text-neutral-900">Check your inbox.</p>
        <p className="mt-2 leading-relaxed">
          If your email is registered, we&rsquo;ve sent a new link. It may take a minute
          to arrive.
        </p>
        <button
          type="button"
          onClick={() => {
            if (cooldownLeft > 0) return;
            setSent(false);
            setEmail('');
          }}
          disabled={cooldownLeft > 0}
          className="mt-4 text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cooldownLeft > 0 ? `Send another in ${cooldownLeft}s` : 'Send another'}
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-neutral-200 bg-white p-6"
    >
      <p className="text-base font-semibold text-neutral-900">This link has expired.</p>
      <p className="mt-1 text-sm text-neutral-600">
        Enter your email to get a new one.
      </p>
      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Email
      </label>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        required
        className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
        placeholder="you@example.com"
      />
      <button
        type="submit"
        disabled={busy || !email}
        className="mt-4 w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Send new link →'}
      </button>
    </form>
  );
}
