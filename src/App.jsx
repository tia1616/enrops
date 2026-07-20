import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import PublicLayout from './layouts/PublicLayout.jsx';
import AdminLayout from './layouts/AdminLayout.jsx';
import { CartProvider } from './context/CartContext.jsx';
import PwaUpdateToast from './components/pwa/PwaUpdateToast.jsx';
import AnalyticsBridge from './components/analytics/AnalyticsBridge.jsx';
import RouteFallback from './components/RouteFallback.jsx';
import ChunkErrorBoundary from './components/ChunkErrorBoundary.jsx';

// ---------------------------------------------------------------------------
// EAGER: the public + parent path.
//
// These are what an unauthenticated visitor or a registering parent hits first,
// so they stay in the initial bundle — a Suspense flash on the money path buys
// nothing. Both layouts are eager too, so admin/public chrome paints instantly
// and only the content area suspends.
// ---------------------------------------------------------------------------
import EnropsLanding from './pages/enrops/Landing.jsx';
import Home from './pages/portal/Home.jsx';
import Register from './pages/portal/Register.jsx';
import RegisterSuccess from './pages/portal/RegisterSuccess.jsx';
import Login from './pages/portal/Login.jsx';
import Dashboard from './pages/portal/Dashboard.jsx';
import PolicyPage from './pages/PolicyPage.jsx';
import Unsubscribed from './pages/Unsubscribed.jsx';
import AdminLogin from './pages/admin/AdminLogin.jsx';

// ---------------------------------------------------------------------------
// LAZY: everything behind a login.
//
// The admin tree is ~40 pages and was the bulk of a 3.14 MB initial bundle that
// every parent downloaded just to register a kid. Splitting it per-route means
// a parent downloads none of it, and an admin downloads only pages they open.
//
// This also pulls lottie-web (the Ennie animation) out of the initial payload
// for free: Ennie is only imported by AdminOverview and CurriculumReview, so
// once both are lazy, rollup hoists lottie into a chunk that loads with them.
// No dynamic import inside Ennie.jsx needed, and no loading-gap regression.
// ---------------------------------------------------------------------------
const AdminOverview = lazy(() => import('./pages/admin/AdminOverview.jsx'));
const AICampaignBuilder = lazy(() => import('./pages/admin/marketing-v2/AICampaignBuilder.jsx'));
const AutomationsTab = lazy(() => import('./pages/admin/marketing-v2/AutomationsTab.jsx'));
const ContactsTab = lazy(() => import('./pages/admin/marketing-v2/ContactsTab.jsx'));
const TemplatesTab = lazy(() => import('./pages/admin/marketing-v2/TemplatesTab.jsx'));
const Schedule = lazy(() => import('./pages/admin/Schedule.jsx'));
const SchedulePrint = lazy(() => import('./pages/admin/SchedulePrint.jsx'));
const ClassSchedule = lazy(() => import('./pages/admin/ClassSchedule.jsx'));
const ExtractionTest = lazy(() => import('./pages/admin/dev/ExtractionTest.jsx'));
const CurriculaList = lazy(() => import('./pages/admin/curricula/CurriculaList.jsx'));
const CurriculumNew = lazy(() => import('./pages/admin/curricula/CurriculumNew.jsx'));
const CurriculumExtracting = lazy(() => import('./pages/admin/curricula/CurriculumExtracting.jsx'));
const CurriculumReview = lazy(() => import('./pages/admin/curricula/CurriculumReview.jsx'));
const ProgramsCalendar = lazy(() => import('./pages/admin/programs/ProgramsCalendar.jsx'));
const ProgramWizardNew = lazy(() => import('./pages/admin/programs/ProgramWizardNew.jsx'));
const ProgramRoster = lazy(() => import('./pages/admin/programs/ProgramRoster.jsx'));
const SchoolsLocations = lazy(() => import('./pages/admin/SchoolsLocations.jsx'));
const InstructorsPage = lazy(() => import('./pages/admin/instructors/InstructorsPage.jsx'));
const SurveyResponses = lazy(() => import('./pages/admin/instructors/SurveyResponses.jsx'));
const Payroll = lazy(() => import('./pages/admin/Payroll.jsx'));
const Rosters = lazy(() => import('./pages/admin/Rosters.jsx'));
const ClassReports = lazy(() => import('./pages/admin/ClassReports.jsx'));
const Finances = lazy(() => import('./pages/admin/Finances.jsx'));
const Payouts = lazy(() => import('./pages/admin/Payouts.jsx'));
const Discounts = lazy(() => import('./pages/admin/Discounts.jsx'));
const TeamPage = lazy(() => import('./pages/admin/team/TeamPage.jsx'));
const AdminSettings = lazy(() => import('./pages/admin/AdminSettings.jsx'));
const SurveySettings = lazy(() => import('./pages/admin/SurveySettings.jsx'));
const RegistrationQuestions = lazy(() => import('./pages/admin/RegistrationQuestions.jsx'));
const WaiverManager = lazy(() => import('./pages/admin/WaiverManager.jsx'));
const EmailSenderSettings = lazy(() => import('./pages/admin/EmailSenderSettings.jsx'));
const BackgroundCheckSettings = lazy(() => import('./pages/admin/BackgroundCheckSettings.jsx'));
const TrainingSettings = lazy(() => import('./pages/admin/TrainingSettings.jsx'));
const BrandLogoSettings = lazy(() => import('./pages/admin/BrandLogoSettings.jsx'));
const PayRatesSettings = lazy(() => import('./pages/admin/PayRatesSettings.jsx'));
const TimeSavedPage = lazy(() => import('./pages/admin/TimeSavedPage.jsx'));

// Instructor + onboarding: a separate audience from the parent money path.
const InstructorPortal = lazy(() => import('./pages/portal/InstructorPortal.jsx'));
const GoogleAuthCallback = lazy(() => import('./pages/auth/GoogleAuthCallback.jsx'));
const ErrorPage = lazy(() => import('./pages/error/ErrorPage.jsx'));
const OnboardingRouter = lazy(() => import('./pages/onboarding/OnboardingRouter.jsx'));
const DeclinedPage = lazy(() => import('./pages/onboarding/DeclinedPage.jsx'));
const AbandonedPage = lazy(() => import('./pages/onboarding/AbandonedPage.jsx'));

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
    {/* One boundary around the whole route tree: a chunk that 404s after a
        deploy reloads the page instead of white-screening. See
        ChunkErrorBoundary.jsx for why this is load-bearing with a PWA. */}
    <ChunkErrorBoundary>
    <Suspense fallback={<RouteFallback />}>
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
        <Route index element={<Home />} />
        <Route path="register" element={<Register />} />
        <Route path="register/success" element={<RegisterSuccess />} />
        <Route path="login" element={<Login />} />
        <Route path="dashboard" element={<Dashboard />} />
        {/* No orgSlug prop: PolicyPage resolves the provider from the `:slug`
            URL param above. It used to be hardcoded to "j2s", which served
            Journey to STEAM LLC's privacy policy under every other provider's
            brand. The platform's own docs are the `/privacy` `/terms` routes
            further up, which pass orgSlug="enrops" explicitly. */}
        <Route path="privacy" element={<PolicyPage policyType="privacy" />} />
        <Route path="terms" element={<PolicyPage policyType="terms" />} />
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
        <Route path="availability" element={<SurveyResponses />} />
        <Route path="survey-responses" element={<Navigate to="/admin/availability" replace />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="rosters" element={<Rosters />} />
        <Route path="class-reports" element={<ClassReports />} />
        <Route path="finances" element={<Finances />} />
        <Route path="payouts" element={<Payouts />} />
        <Route path="discounts" element={<Discounts />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="time-saved" element={<TimeSavedPage />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="survey-settings" element={<SurveySettings />} />
        <Route path="registration-questions" element={<RegistrationQuestions />} />
        <Route path="waivers" element={<WaiverManager />} />
        <Route path="email-sender" element={<EmailSenderSettings />} />
        <Route path="pay-rates" element={<PayRatesSettings />} />
        <Route path="background-checks" element={<BackgroundCheckSettings />} />
        <Route path="training" element={<TrainingSettings />} />
        <Route path="branding" element={<BrandLogoSettings />} />
        <Route path="dev/extraction-test" element={<ExtractionTest />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </ChunkErrorBoundary>
    </>
  );
}
