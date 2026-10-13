// AnalyticsBridge — invisible component that keeps analytics in sync with the app:
//  - identifies the operator on login / resets on logout
//  - gates session replay to /admin/* and fires a $pageview on each route change
//  - sends the Meta pixel's PageView on each route change
//
// Mounted once inside the Router (App.jsx). No-ops when analytics is disabled.
//
// The two are deliberately side by side but NOT merged. PostHog is our own
// product analytics and runs everywhere; the Meta pixel is advertising
// measurement, is off unless a dataset id is configured, and stops dead on a
// Global Privacy Control signal or an opt-out. Same trigger, different rules.

import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  identifyUser,
  resetAnalytics,
  syncRecording,
  capturePageview,
} from "../../lib/analytics.js";
import { pixelPageview } from "../../lib/metaPixel.js";
import { captureAttribution } from "../../lib/attribution.js";

export default function AnalyticsBridge() {
  const location = useLocation();
  const { user, loading } = useAuth();

  // Identify on login, reset on logout (clears the prior person from this device).
  useEffect(() => {
    if (loading) return;
    if (user) identifyUser(user);
    else resetAnalytics();
  }, [user?.id, loading]);

  // Start/stop replay per route + record the pageview.
  //
  // This fires on FIRST mount as well as on every change, which is why
  // initMetaPixel deliberately does not send a PageView of its own — the
  // landing page would otherwise be counted twice.
  useEffect(() => {
    syncRecording(location.pathname);
    capturePageview(location.pathname);
    pixelPageview();
  }, [location.pathname]);

  // Remember which campaign email a visitor arrived from (utm_* on the link), so
  // checkout can hand it to create-registration. Not analytics and not tracking of
  // a person: it stores our own campaign/touchpoint ids on this device and nothing
  // else. Runs on landing AND on every later URL change, because the tagged link
  // can open any route. A URL with no tags leaves what is stored alone.
  useEffect(() => {
    captureAttribution(location.search);
  }, [location.search]);

  return null;
}
