import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import EnropsLanding from './pages/enrops/Landing.jsx';
import PublicLayout from './layouts/PublicLayout.jsx';
import J2SHome from './pages/j2s/Home.jsx';
import J2SRegister from './pages/j2s/Register.jsx';
import J2SRegisterSuccess from './pages/j2s/RegisterSuccess.jsx';
import J2SLogin from './pages/j2s/Login.jsx';
import J2SDashboard from './pages/j2s/Dashboard.jsx';
import PolicyPage from './pages/PolicyPage.jsx';
import Unsubscribed from './pages/Unsubscribed.jsx';
import AdminLayout from './layouts/AdminLayout.jsx';
import AdminLogin from './pages/admin/AdminLogin.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import AICampaignBuilder from './pages/admin/marketing-v2/AICampaignBuilder.jsx';
import AutomationsTab from './pages/admin/marketing-v2/AutomationsTab.jsx';
import ContactsTab from './pages/admin/marketing-v2/ContactsTab.jsx';
import TemplatesTab from './pages/admin/marketing-v2/TemplatesTab.jsx';
import Schedule from './pages/admin/Schedule.jsx';
import SchedulePrint from './pages/admin/SchedulePrint.jsx';
import ClassSchedule from './pages/admin/ClassSchedule.jsx';
import ExtractionTest from './pages/admin/dev/ExtractionTest.jsx';
import CurriculaList from './pages/admin/curricula/CurriculaList.jsx';
import CurriculumNew from './pages/admin/curricula/CurriculumNew.jsx';
import CurriculumExtracting from './pages/admin/curricula/CurriculumExtracting.jsx';
import CurriculumReview from './pages/admin/curricula/CurriculumReview.jsx';
import ProgramsCalendar from './pages/admin/programs/ProgramsCalendar.jsx';
import ProgramWizardNew from './pages/admin/programs/ProgramWizardNew.jsx';
import ProgramRoster from './pages/admin/programs/ProgramRoster.jsx';
import SchoolsLocations from './pages/admin/SchoolsLocations.jsx';
import InstructorsPage from './pages/admin/instructors/InstructorsPage.jsx';
import Payroll from './pages/admin/Payroll.jsx';
import Rosters from './pages/admin/Rosters.jsx';
import Finances from './pages/admin/Finances.jsx';
import Payouts from './pages/admin/Payouts.jsx';
import TeamPage from './pages/admin/team/TeamPage.jsx';
import AdminSettings from './pages/admin/AdminSettings.jsx';
import WaiverManager from './pages/admin/WaiverManager.jsx';
import EmailSenderSettings from './pages/admin/EmailSenderSettings.jsx';
import BrandLogoSettings from './pages/admin/BrandLogoSettings.jsx';
import TimeSavedPage from './pages/admin/TimeSavedPage.jsx';
import InstructorPortal from './pages/j2s/InstructorPortal.jsx';
import GoogleAuthCallback from './pages/auth/GoogleAuthCallback.jsx';
import ErrorPage from './pages/error/ErrorPage.jsx';
import OnboardingRouter from './pages/onboarding/OnboardingRouter.jsx';
import DeclinedPage from './pages/onboarding/DeclinedPage.jsx';
import AbandonedPage from './pages/onboarding/AbandonedPage.jsx';
import { CartProvider } from './context/CartContext.jsx';
import PwaUpdateToast from './components/pwa/PwaUpdateToast.jsx';
import AnalyticsBridge from './components/analytics/AnalyticsBridge.jsx';

// On the staging site, the public marketing landing at "/" just gets in the way
// (staging exists to exercise the app). Host-gated so prod (enrops.com) and any
// tenant domains keep the marketing page — only *.enrops-staging.netlify.app
// (primary, branch, and deploy-permalink subdomains) skip straight to admin login.
const IS_STAGING =
  typeof window !== 'undefined' &&
  window.location.hostname.endsWith('enrops-staging.netlify.app');

export default function App() {
  return (
    <>
    <PwaUpdateToast />
    <AnalyticsBridge />
    <Routes>
      {/* enrops.com home = the State 1 invite-only entry card (see Landing.jsx).
          Signed-in users smart-redirect to their portal; signed-out browser
          users see the card (with its own Log in button), so staging + prod
          behave the same now. */}
      <Route path="/" element={<EnropsLanding />} />
      <Route path="/privacy" element={<PolicyPage policyType="privacy" orgSlug="enrops" />} />
      <Route path="/terms" element={<PolicyPage policyType="terms" orgSlug="enrops" />} />
      <Route path="/acceptable-use" element={<PolicyPage policyType="acceptable-use" orgSlug="enrops" />} />
      <Route path="/cookies" element={<PolicyPage policyType="cookies" orgSlug="enrops" />} />
      <Route path="/data-retention" element={<PolicyPage policyType="data-retention" orgSlug="enrops" />} />
      <Route path="/subprocessors" element={<PolicyPage policyType="subprocessors" orgSlug="enrops" />} />
      <Route path="/dpa" element={<PolicyPage policyType="dpa" orgSlug="enrops" />} />
      {/* Public marketing-unsubscribe confirmation. The unsubscribe edge fn
          records the opt-out then 302s here (it can't render HTML itself —
          Supabase serves function HTML as text/plain). No auth. */}
      <Route path="/unsubscribed" element={<Unsubscribed />} />
      {/* Public per-tenant tree: /:slug/* resolves the org from the URL slug.
          J2S still hits this (slug='j2s') so /j2s/register etc. keep working
          unchanged. The `/:slug/instructor` and `/:slug/admin/*` routes below
          are matched explicitly (more-specific match wins), so they aren't
          shadowed by this wildcard. Per-tenant branding is handled inside
          PublicLayout; for now J2S renders its existing look and every other
          tenant gets the Enrops base brand. */}
      <Route
        path="/:slug"
        element={
          <CartProvider>
            <PublicLayout />
          </CartProvider>
        }
      >
        <Route index element={<J2SHome />} />
        <Route path="register" element={<J2SRegister />} />
        <Route path="register/success" element={<J2SRegisterSuccess />} />
        <Route path="login" element={<J2SLogin />} />
        <Route path="dashboard" element={<J2SDashboard />} />
        <Route path="privacy" element={<PolicyPage policyType="privacy" orgSlug="j2s" />} />
        <Route path="terms" element={<PolicyPage policyType="terms" orgSlug="j2s" />} />
      </Route>
      <Route path="/j2s/instructor" element={<InstructorPortal />} />
      {/* /:slug/instructor for multi-tenant — currently J2S only but the
          pattern is consistent with /:slug/onboarding so contractor-invite
          can use the slug from the tenant's org row. */}
      <Route path="/:slug/instructor" element={<InstructorPortal />} />
      {/* Tenant-less shortcut: /instructor and /instructors both bounce to
          the J2S portal. Contractors typed it on their phones expecting it
          to work; without this the catch-all sent them to the marketing
          landing. Once we have a second tenant we revisit (probably a
          subdomain split). */}
      <Route path="/instructor" element={<Navigate to="/j2s/instructor" replace />} />
      <Route path="/instructors" element={<Navigate to="/j2s/instructor" replace />} />
      {/* Same defensive pattern for admin — users type /j2s/admin
          expecting tenant-scoped paths to work. /admin is the canonical
          route (org context comes from the signed-in user's org_members
          row at runtime). */}
      <Route path="/:slug/admin" element={<Navigate to="/admin" replace />} />
      <Route path="/:slug/admin/*" element={<Navigate to="/admin" replace />} />
      <Route path="/auth/google/callback" element={<GoogleAuthCallback />} />
      <Route path="/error" element={<ErrorPage />} />
      {/* Onboarding is now part of the instructor portal at /j2s/instructor.
          /:slug/onboarding still resolves for backward compat with old magic
          links — OnboardingRouter detects the unified state and either
          renders inline or redirects to the portal. */}
      <Route path="/:slug/onboarding" element={<OnboardingRouter />} />
      <Route path="/:slug/onboarding/declined" element={<DeclinedPage />} />
      <Route path="/:slug/onboarding/abandoned" element={<AbandonedPage />} />
      {/* /login is the public, brand-stable sign-in URL (Arielle wires the
          getenrops.com Login button to it). Renders the same universal sign-in
          as /admin/login (which stays for back-compat + Stripe return_urls). */}
      <Route path="/login" element={<AdminLogin />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        {/* "Family Comms" — operator-facing name. Internal folder is still
            marketing-v2/ to avoid touching dozens of imports.
            Sub-routes:
              /admin/family-comms              -> redirects to /marketing (default)
              /admin/family-comms/marketing    -> AI campaign builder (was /marketing-v2)
              /admin/family-comms/automations  -> Lifecycle automations dashboard
              /admin/family-comms/contacts     -> Contact list + CSV upload
            /admin/marketing-v2 stays as a redirect for old bookmarks. */}
        <Route path="family-comms" element={<Navigate to="/admin/family-comms/marketing" replace />} />
        <Route path="family-comms/marketing" element={<AICampaignBuilder />} />
        <Route path="family-comms/automations" element={<AutomationsTab />} />
        <Route path="family-comms/contacts" element={<ContactsTab />} />
        <Route path="family-comms/templates" element={<TemplatesTab />} />
        <Route path="marketing-v2" element={<Navigate to="/admin/family-comms/marketing" replace />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="schedule/print" element={<SchedulePrint />} />
        <Route path="class-schedule" element={<ClassSchedule />} />
        <Route path="curricula" element={<CurriculaList />} />
        <Route path="curricula/new" element={<CurriculumNew />} />
        <Route path="curricula/:id/extracting" element={<CurriculumExtracting />} />
        <Route path="curricula/:id/review" element={<CurriculumReview />} />
        <Route path="curricula/:id/edit" element={<CurriculumReview />} />
        <Route path="programs" element={<ProgramsCalendar />} />
        <Route path="programs/new" element={<ProgramWizardNew />} />
        <Route path="programs/:programId/roster" element={<ProgramRoster />} />
        <Route path="schools" element={<SchoolsLocations />} />
        {/* The classic Partners/Locations tabs were retired 2026-06-23; the
            unified Partners surface (/admin/schools) is the single home. Redirect
            every legacy URL there so bookmarks/email links still resolve. */}
        <Route path="locations" element={<Navigate to="/admin/schools" replace />} />
        <Route path="calendars" element={<Navigate to="/admin/schools?tab=calendars" replace />} />
        <Route path="contacts" element={<Navigate to="/admin/schools" replace />} />
        <Route path="instructors" element={<InstructorsPage />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="rosters" element={<Rosters />} />
        <Route path="finances" element={<Finances />} />
        <Route path="payouts" element={<Payouts />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="time-saved" element={<TimeSavedPage />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="waivers" element={<WaiverManager />} />
        <Route path="email-sender" element={<EmailSenderSettings />} />
        <Route path="branding" element={<BrandLogoSettings />} />
        <Route path="dev/extraction-test" element={<ExtractionTest />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
