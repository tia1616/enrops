// AnalyticsBridge — invisible component that keeps PostHog in sync with the app:
//  - identifies the operator on login / resets on logout
//  - gates session replay to /admin/* and fires a $pageview on each route change
//
// Mounted once inside the Router (App.jsx). No-ops when analytics is disabled.

import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  identifyUser,
  resetAnalytics,
  syncRecording,
  capturePageview,
} from "../../lib/analytics.js";

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
  useEffect(() => {
    syncRecording(location.pathname);
    capturePageview(location.pathname);
  }, [location.pathname]);

  return null;
}
