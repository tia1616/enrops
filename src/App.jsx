import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useOutletContext } from 'react-router-dom';
import { canReachCommsTab, canManageInstructors } from './lib/entitlements.js';
import PublicLayout from './layouts/PublicLayout.jsx';
import AdminLayout from './layouts/AdminLayout.jsx';
import { CartProvider } from './context/CartContext.jsx';
import PwaUpdateToast from './components/pwa/PwaUpdateToast.jsx';
import AnalyticsBridge from './components/analytics/AnalyticsBridge.jsx';
import AdChoiceNotice from './components/privacy/AdChoiceNotice.jsx';
import DoNotSell from './pages/DoNotSell.jsx';
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
import OperatorSignup from './pages/enrops/OperatorSignup.jsx';
import Home from './pages/portal/Home.jsx';
import Register from './pages/portal/Register.jsx';
import RegisterSuccess from './pages/portal/RegisterSuccess.jsx';
import WaitlistAccept from './pages/portal/WaitlistAccept.jsx';
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
const RefundWatch = lazy(() => import('./pages/admin/dev/RefundWatch.jsx'));
const OperatorOverview = lazy(() => import('./pages/admin/platform/OperatorOverview.jsx'));
const CurriculaList = lazy(() => import('./pages/admin/curricula/CurriculaList.jsx'));
const CurriculumNew = lazy(() => import('./pages/admin/curricula/CurriculumNew.jsx'));
const CurriculumExtracting = lazy(() => import('./pages/admin/curricula/CurriculumExtracting.jsx'));
const CurriculumReview = lazy(() => import('./pages/admin/curricula/CurriculumReview.jsx'));
const ProgramsCalendar = lazy(() => import('./pages/admin/programs/ProgramsCalendar.jsx'));
const ProgramWizardNew = lazy(() => import('./pages/admin/programs/ProgramWizardNew.jsx'));
const QuickProgramBuilder = lazy(() => import('./pages/admin/programs/QuickProgramBuilder.jsx'));
const ProgramRoster = lazy(() => import('./pages/admin/programs/ProgramRoster.jsx'));
const SchoolsLocations = lazy(() => import('./pages/admin/SchoolsLocations.jsx'));
const CalendarsList = lazy(() => import('./pages/admin/CalendarsList.jsx'));
const InstructorsPage = lazy(() => import('./pages/admin/instructors/InstructorsPage.jsx'));
const SurveyResponses = lazy(() => import('./pages/admin/instructors/SurveyResponses.jsx'));
// Payroll.jsx is no longer lazily imported here: /admin/payroll redirects and
// Payouts.jsx imports it directly. Leaving the lazy() behind would have kept a
// separate chunk in the build for a route that no longer renders it.
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
const InstructorDocuments = lazy(() => import('./pages/admin/InstructorDocuments.jsx'));
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

// Registration operators (enrops_platform) build programs in the lightweight
// QuickProgramBuilder. The classic wizard at /admin/programs/new hard-gates on a
// PUBLISHED CURRICULUM + a LOCATION (ProgramWizardNew's prereq empty-state) —
// neither of which a lean org has, so reaching it by a direct URL or a stale
// bookmark is an unresolvable dead end. Nothing links a lean op there, but the
// route was reachable; send them to the builder they can actually finish.
// org is loaded before AdminLayout renders <Outlet>, so this never flashes.
function ProgramWizardRoute() {
  const { org } = useOutletContext();
  if (org?.instructor_pay_model === 'enrops_platform') {
    return <Navigate to="/admin/programs/quick-new" replace />;
  }
  return <ProgramWizardNew />;
}

// Comms tabs an org isn't entitled to are not just hidden from the tab strip —
// they're unreachable by URL. Hiding a link is not a gate: a bookmark, a shared
// URL, or a browser autocomplete all still land on the page, and Campaigns
// would then let a registration_only operator compose a send they don't have.
// Sends this to their Comms home instead of a dead end. org is loaded before
// AdminLayout renders <Outlet>, so this never flashes.
function CommsTabRoute({ tab, children }) {
  const { org } = useOutletContext();
  if (canReachCommsTab(org, tab)) return children;
  // Contacts is the redirect TARGET, so sending it to itself would spin. It is
  // reachable on every tier today; this only matters if a future tier gates it,
  // and an infinite redirect is a far worse failure than landing on Programs.
  if (tab === "contacts") return <Navigate to="/admin/programs" replace />;
  return <Navigate to="/admin/family-comms/contacts" replace />;
}

// Instructor documents are an instructor-management surface, so an org that
// cannot manage instructors does not get the authoring page by URL.
//
// THIS GATE IS PRESENTATIONAL, and an earlier version of this comment implied
// otherwise by saying it stopped a non-entitled owner publishing "from a
// bookmark". It stops them reaching the PAGE. It does not stop the write:
// org_admins_write_legal_docs checks can_admin_org(organization_id), which proves
// the caller administers that org and carries no plan test — measured on staging
// as a real lean+free admin, a direct POST to /rest/v1/legal_documents with their
// own organization_id returns 201.
//
// Left that way on purpose. The boundary that matters holds — a CROSS-ORG write
// is refused with 42501 — so what remains is a commercial gate on an operator
// writing their own rows, and those documents are inert without the instructor
// surfaces, which are gated too. Enforcing the plan in SQL would put entitlement
// logic in a second place where it can drift from entitlements.js, which is a
// worse failure than the one it prevents. If that trade ever flips, change it
// here and in the policy together.
//
// org is loaded before AdminLayout renders <Outlet>, so this never flashes.
function InstructorDocsRoute({ children }) {
  const { org } = useOutletContext();
  if (canManageInstructors(org)) return children;
  return <Navigate to="/admin/settings" replace />;
}

// THE REST OF THE INSTRUCTORS SECTION, which was bare while its Settings page was
// wrapped — the exact shape the note above CommsTabRoute warns about ("wrapping
// only the gated ones made the bare form look like the norm, so the next route
// would copy a neighbour and quietly ship ungated").
//
// The nav fix on 2026-08-13 closed the ROLE hole (a staff or viewer typing
// /admin/payouts). It did not close the ENTITLEMENT hole: shapeNavForOrg drops the
// Instructors item out of navItems entirely for a lean org without the
// entitlement, and an item that is not in the array can never trigger the block
// card no matter what it matches. So Schedule, the roster, availability and class
// reports were all reachable by URL for an org that is not entitled to them.
//
// WHERE IT SENDS THEM IS PER-ORG, and hardcoding /admin/programs was wrong for
// exactly the orgs most likely to hit this. An org that brings its own
// registration has "Scheduled programs" greyed out with
// offReason: "You bring your own registration — use Class schedule instead."
// (AdminLayout marks a tab not-applicable on `t.regOnly && !usesReg`). So the
// redirect landed them on a page whose own tab tells them to go somewhere else —
// a second dead end, which is the thing the first draft of this comment claimed
// it was avoiding. Two of seven prod orgs match that shape today
// (mrs-richelle, shoreview-chess: enrops_platform, uses_enrops_registration
// false). /admin is not a fallback either — HIDE_TOP drops it for lean orgs and
// AdminOverview redirects it back to Programs.
//
// Picks the same way the nav does, off the same column, so the two cannot
// disagree. Same three-line shape as CommsTabRoute and InstructorDocsRoute.
function InstructorRoute({ children }) {
  const { org } = useOutletContext();
  if (canManageInstructors(org)) return children;
  return <Navigate to={org?.uses_enrops_registration ? "/admin/programs" : "/admin/class-schedule"} replace />;
}

export default function App() {
  return (
    <>
    <PwaUpdateToast />
    <AnalyticsBridge />
    {/* Outside the route tree on purpose: the pixel loads site-wide, so the
        chance to decline has to be available site-wide too, not only on
        whichever page someone happens to land on. Renders nothing at all when
        no dataset id is configured, which is every environment today. */}
    <AdChoiceNotice />
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
      <Route path="/signup" element={<OperatorSignup />} />
      <Route path="/privacy" element={<PolicyPage policyType="privacy" orgSlug="enrops" />} />
      <Route path="/terms" element={<PolicyPage policyType="terms" orgSlug="enrops" />} />
      <Route path="/acceptable-use" element={<PolicyPage policyType="acceptable-use" orgSlug="enrops" />} />
      <Route path="/cookies" element={<PolicyPage policyType="cookies" orgSlug="enrops" />} />
      {/* The CCPA/CPRA opt-out control. Platform-level, never tenant-scoped:
          the sharing is ours, not any operator's. */}
      <Route path="/do-not-sell" element={<DoNotSell />} />
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
        {/* Embeddable catalog for the operator's OWN website. Same component as
            the public catalog (one source of truth for the query + cards); Home
            renders a compact, chrome-less variant when it's in embed mode, and
            PublicLayout drops its header/footer for /embed and any ?embed=1
            route so the whole flow looks native inside the operator's page. */}
        <Route path="embed" element={<Home />} />
        <Route path="register" element={<Register />} />
        <Route path="register/success" element={<RegisterSuccess />} />
        {/* Where the waitlist invite email lands. Public by necessity: an invited
            family has no account, and the token in the URL is the credential. */}
        <Route path="waitlist/:token" element={<WaitlistAccept />} />
        <Route path="login" element={<Login />} />
        <Route path="dashboard" element={<Dashboard />} />
        {/* No orgSlug prop: PolicyPage resolves the provider from the `:slug`
            URL param above. It used to be hardcoded to "j2s", which served
            Journey to STEAM LLC's privacy policy under every other provider's
            brand. The platform's own docs are the `/privacy` `/terms` routes
            further up, which pass orgSlug="enrops" explicitly. */}
        <Route path="privacy" element={<PolicyPage policyType="privacy" />} />
        <Route path="terms" element={<PolicyPage policyType="terms" />} />
        {/* Linked from the pay step, so it must exist before checkout offers it. */}
        <Route path="cancellation" element={<PolicyPage policyType="cancellation" />} />
      </Route>
      {/* THE PORTAL RESOLVES ITS OWN TENANT. InstructorPortal looks the org up
          from the signed-in instructor's own record and sets the slug from that
          (see its public_org_directory read), so the slug in the address is
          decorative — it is never what decides whose portal you get.
          That is why all four spellings below can share one element. */}
      <Route path="/:slug/instructor" element={<InstructorPortal />} />
      {/* Tenant-less shortcuts: the ones people actually type on a phone.
          These used to REDIRECT to /j2s/instructor — one tenant's portal, hard-
          coded, for every provider's instructors. Harmless while one provider
          had all the instructors; wrong the moment a second one hires anybody.
          Now they render the portal directly and it resolves the right org.
          The explicit /j2s/instructor route is gone too: /:slug/instructor
          matches it, with the same component, so every magic link already in an
          inbox keeps working. */}
      <Route path="/instructor" element={<InstructorPortal />} />
      <Route path="/instructors" element={<InstructorPortal />} />
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
        {/* "Comms" — operator-facing name (renamed from "Family Comms"). The
            route path + internal folder stay family-comms / marketing-v2 to
            avoid touching dozens of imports and to keep old bookmarks working.
            Sub-routes:
              /admin/family-comms              -> redirects to /contacts (section home)
              /admin/family-comms/contacts     -> Contact list + CSV upload (the CRM spine)
              /admin/family-comms/marketing    -> AI campaign builder (was /marketing-v2)
              /admin/family-comms/automations  -> Lifecycle automations dashboard
              /admin/family-comms/templates    -> Reusable email templates
            /admin/marketing-v2 stays as a redirect for old bookmarks. */}
        <Route path="family-comms" element={<Navigate to="/admin/family-comms/contacts" replace />} />
        {/* ALL FOUR are wrapped, including the two that are reachable on every
            tier today. Wrapping only the gated ones made the bare form look like
            the norm, so the next Comms route would copy a neighbour and quietly
            ship ungated — and widening the gate later (a tier where Automations
            becomes paid) would silently leave two routes URL-reachable.
            canReachCommsTab already fails closed for an unknown tab, so these two
            are a no-op today and self-enforcing afterwards. */}
        <Route path="family-comms/marketing" element={<CommsTabRoute tab="marketing"><AICampaignBuilder /></CommsTabRoute>} />
        <Route path="family-comms/automations" element={<CommsTabRoute tab="automations"><AutomationsTab /></CommsTabRoute>} />
        <Route path="family-comms/contacts" element={<CommsTabRoute tab="contacts"><ContactsTab /></CommsTabRoute>} />
        <Route path="family-comms/templates" element={<CommsTabRoute tab="templates"><TemplatesTab /></CommsTabRoute>} />
        <Route path="marketing-v2" element={<Navigate to="/admin/family-comms/marketing" replace />} />
        <Route path="schedule" element={<InstructorRoute><Schedule /></InstructorRoute>} />
        <Route path="schedule/print" element={<InstructorRoute><SchedulePrint /></InstructorRoute>} />
        <Route path="class-schedule" element={<ClassSchedule />} />
        <Route path="curricula" element={<CurriculaList />} />
        <Route path="curricula/new" element={<CurriculumNew />} />
        <Route path="curricula/:id/extracting" element={<CurriculumExtracting />} />
        <Route path="curricula/:id/review" element={<CurriculumReview />} />
        <Route path="curricula/:id/edit" element={<CurriculumReview />} />
        <Route path="programs" element={<ProgramsCalendar />} />
        <Route path="programs/new" element={<ProgramWizardRoute />} />
        <Route path="programs/quick-new" element={<QuickProgramBuilder />} />
        <Route path="programs/:programId/roster" element={<ProgramRoster />} />
        <Route path="schools" element={<SchoolsLocations />} />
        {/* The classic Partners/Locations tabs were retired 2026-06-23; the
            unified venue surface (/admin/schools, titled "Locations" for every
            venue_model as of 2026-08-05) is the single home. Redirect every
            legacy URL there so bookmarks/email links still resolve. */}
        <Route path="locations" element={<Navigate to="/admin/schools" replace />} />
        {/* School calendar is its own page now (was a redirect into the venue
            surface's tab). Lean nav surfaces it as a peer tab under Programs;
            full nav keeps reaching it under Locations (that nav item's `match`
            includes it). */}
        <Route path="calendars" element={<CalendarsList />} />
        <Route path="contacts" element={<Navigate to="/admin/schools" replace />} />
        <Route path="instructors" element={<InstructorRoute><InstructorsPage /></InstructorRoute>} />
        <Route path="availability" element={<InstructorRoute><SurveyResponses /></InstructorRoute>} />
        <Route path="survey-responses" element={<Navigate to="/admin/availability" replace />} />
        {/* Two addresses served the same screen, and this one served it WORSE:
            Payroll.jsx has no heading of its own — it was written to render
            inside the Payouts shell — so /admin/payroll rendered a bare table
            with no title on the page. Nothing links here (checked: no nav item,
            no email from any edge function), so this is old-bookmark insurance,
            not a live route being retired out from under anyone. */}
        <Route path="payroll" element={<Navigate to="/admin/payouts" replace />} />
        <Route path="rosters" element={<Rosters />} />
        <Route path="class-reports" element={<InstructorRoute><ClassReports /></InstructorRoute>} />
        <Route path="finances" element={<Finances />} />
        {/* WRAPPED as of 2026-08-17, and the trigger was a nav change in this same
            branch. Giving the Money > Payroll calculator tab `instructorsOnly`
            (AdminLayout NAV) made /admin/payouts an instructor-ENTITLEMENT surface
            for the first time, and it was the only one still bare — schedule,
            schedule/print, instructors, availability, class-reports, pay-rates and
            instructor-documents are all wrapped. Hiding the tab does nothing for a
            typed URL: the org passes the `viewMoney` ROLE gate, so blockedItem never
            fires, and Payroll's own canManage is role-only — so Confirm, Approve,
            Withhold and Pay via Stripe were all live for an org with no entitlement
            to instructors at all. That is the nav-half-without-the-route-half shape
            adminRouteGuards.test.mjs exists to catch.
            Takes nothing away from anyone holding data: checked prod 17 Aug, only
            j2s has instructors, pay lines or payouts (25 / 221 / 50) and it is
            legacy_own_platform, for which canManageInstructors returns true. Every
            enrops_platform org is 0 / 0 / 0, and Jeff is `founding` so he stays
            entitled. */}
        <Route path="payouts" element={<InstructorRoute><Payouts /></InstructorRoute>} />
        <Route path="discounts" element={<Discounts />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="time-saved" element={<TimeSavedPage />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="survey-settings" element={<SurveySettings />} />
        <Route path="registration-questions" element={<RegistrationQuestions />} />
        <Route path="waivers" element={<WaiverManager />} />
        <Route path="email-sender" element={<EmailSenderSettings />} />
        <Route path="pay-rates" element={<InstructorRoute><PayRatesSettings /></InstructorRoute>} />
        <Route path="background-checks" element={<BackgroundCheckSettings />} />
        {/* Authoring the documents instructors read and sign.
            TWO independent gates, and an earlier version of this comment wrongly
            claimed one covered both. The Settings `match` entry gates ROLE
            (owner/admin) via AdminLayout's guard. It says nothing about the PLAN,
            so a non-entitled org could reach this page by URL and publish
            successfully — the RLS policy checks can_admin_org, which is role-only
            and carries no plan test. Hiding the Settings card is not a gate, the
            same lesson CommsTabRoute above exists for. */}
        <Route path="instructor-documents" element={<InstructorDocsRoute><InstructorDocuments /></InstructorDocsRoute>} />
        <Route path="training" element={<TrainingSettings />} />
        <Route path="branding" element={<BrandLogoSettings />} />
        <Route path="dev/extraction-test" element={<ExtractionTest />} />
        <Route path="dev/refund-watch" element={<RefundWatch />} />
        {/* Platform-admin console. No nav entry by design - the same reason
            dev/refund-watch has none: every nav item AdminLayout renders is
            visible to ordinary operators, and these screens are cross-tenant.
            Reached by URL, gated by platform_admins in the UI and again in the
            database. */}
        <Route path="platform/operators" element={<OperatorOverview />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </ChunkErrorBoundary>
    </>
  );
}
