import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { initAnalytics } from './lib/analytics.js';
import { initMetaPixel } from './lib/metaPixel.js';
import { captureSignupUtm } from './lib/signupAttribution.js';
import './index.css';

// Stash utm_content BEFORE anything can redirect. Google OAuth and the magic
// link both return to `${origin}/signup` with the query string stripped, so if
// it is not captured on the landing hit it is gone by the time the org exists.
// Runs unconditionally and independently of the pixel: knowing which ad brought
// an operator is useful whether or not Meta measurement is switched on, and it
// must not be lost just because someone opted out of advertising cookies.
captureSignupUtm();

// Privacy-first PostHog init (no-ops if VITE_POSTHOG_KEY is unset).
initAnalytics();

// Meta advertising pixel (no-ops if VITE_META_PIXEL_ID is unset, which it is
// everywhere until deliberately configured). Also no-ops on a Global Privacy
// Control signal or a stored opt-out, which is why it runs here rather than as
// a raw snippet in index.html — that decision has to be made before fbq exists.
initMetaPixel();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
