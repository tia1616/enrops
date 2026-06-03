import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import EnropsLanding from './pages/enrops/Landing.jsx';
import J2SLayout from './layouts/J2SLayout.jsx';
import J2SHome from './pages/j2s/Home.jsx';
import J2SRegister from './pages/j2s/Register.jsx';
import J2SRegisterSuccess from './pages/j2s/RegisterSuccess.jsx';
import J2SLogin from './pages/j2s/Login.jsx';
import J2SDashboard from './pages/j2s/Dashboard.jsx';
import PolicyPage from './pages/PolicyPage.jsx';
import AdminLayout from './layouts/AdminLayout.jsx';
import AdminLogin from './pages/admin/AdminLogin.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import AICampaignBuilder from './pages/admin/marketing-v2/AICampaignBuilder.jsx';
import AutomationsTab from './pages/admin/marketing-v2/AutomationsTab.jsx';
import Schedule from './pages/admin/Schedule.jsx';
import SchedulePrint from './pages/admin/SchedulePrint.jsx';
import ExtractionTest from './pages/admin/dev/ExtractionTest.jsx';
import CurriculaList from './pages/admin/curricula/CurriculaList.jsx';
import CurriculumNew from './pages/admin/curricula/CurriculumNew.jsx';
import CurriculumExtracting from './pages/admin/curricula/CurriculumExtracting.jsx';
import CurriculumReview from './pages/admin/curricula/CurriculumReview.jsx';
import ProgramsCalendar from './pages/admin/programs/ProgramsCalendar.jsx';
// ProgramWizardNew is being built in a separate chat; the .jsx file isn't
// committed yet. Importing it here was breaking every Netlify deploy since
// 2026-06-02 13:19 because the file doesn't exist in the git checkout. Re-add
// this import (and the /programs/new route below) when the wizard ships.
import LocationsList from './pages/admin/LocationsList.jsx';
import CalendarsList from './pages/admin/CalendarsList.jsx';
import AdminContacts from './pages/admin/contacts/AdminContacts.jsx';
import InstructorsPage from './pages/admin/instructors/InstructorsPage.jsx';
import Payroll from './pages/admin/Payroll.jsx';
import Rosters from './pages/admin/Rosters.jsx';
import Finances from './pages/admin/Finances.jsx';
import Payouts from './pages/admin/Payouts.jsx';
import TeamPage from './pages/admin/team/TeamPage.jsx';
import AdminSettings from './pages/admin/AdminSettings.jsx';
import InstructorPortal from './pages/j2s/InstructorPortal.jsx';
import GoogleAuthCallback from './pages/auth/GoogleAuthCallback.jsx';
import ErrorPage from './pages/error/ErrorPage.jsx';
import OnboardingRouter from './pages/onboarding/OnboardingRouter.jsx';
import DeclinedPage from './pages/onboarding/DeclinedPage.jsx';
import AbandonedPage from './pages/onboarding/AbandonedPage.jsx';
import { CartProvider } from './context/CartContext.jsx';
import PwaUpdateToast from './components/pwa/PwaUpdateToast.jsx';

export default function App() {
  return (
    <>
    <PwaUpdateToast />
    <Routes>
      <Route path="/" element={<EnropsLanding />} />
      <Route path="/privacy" element={<PolicyPage policyType="privacy" orgSlug="enrops" />} />
      <Route path="/terms" element={<PolicyPage policyType="terms" orgSlug="enrops" />} />
      <Route path="/acceptable-use" element={<PolicyPage policyType="acceptable-use" orgSlug="enrops" />} />
      <Route path="/cookies" element={<PolicyPage policyType="cookies" orgSlug="enrops" />} />
      <Route path="/data-retention" element={<PolicyPage policyType="data-retention" orgSlug="enrops" />} />
      <Route path="/subprocessors" element={<PolicyPage policyType="subprocessors" orgSlug="enrops" />} />
      <Route path="/dpa" element={<PolicyPage policyType="dpa" orgSlug="enrops" />} />
      <Route
        path="/j2s"
        element={
          <CartProvider>
            <J2SLayout />
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
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        {/* "Family Comms" — operator-facing name. Internal folder is still
            marketing-v2/ to avoid touching dozens of imports.
            Sub-routes:
              /admin/family-comms              -> redirects to /marketing (default)
              /admin/family-comms/marketing    -> AI campaign builder (was /marketing-v2)
              /admin/family-comms/automations  -> Lifecycle automations dashboard
            /admin/marketing-v2 stays as a redirect for old bookmarks. */}
        <Route path="family-comms" element={<Navigate to="/admin/family-comms/marketing" replace />} />
        <Route path="family-comms/marketing" element={<AICampaignBuilder />} />
        <Route path="family-comms/automations" element={<AutomationsTab />} />
        <Route path="marketing-v2" element={<Navigate to="/admin/family-comms/marketing" replace />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="schedule/print" element={<SchedulePrint />} />
        <Route path="curricula" element={<CurriculaList />} />
        <Route path="curricula/new" element={<CurriculumNew />} />
        <Route path="curricula/:id/extracting" element={<CurriculumExtracting />} />
        <Route path="curricula/:id/review" element={<CurriculumReview />} />
        <Route path="curricula/:id/edit" element={<CurriculumReview />} />
        <Route path="programs" element={<ProgramsCalendar />} />
        {/* <Route path="programs/new" element={<ProgramWizardNew />} /> — re-enable when ProgramWizardNew ships from the instructor-schedule-onboarding chat */}
        <Route path="locations" element={<LocationsList />} />
        <Route path="calendars" element={<CalendarsList />} />
        <Route path="contacts" element={<AdminContacts />} />
        <Route path="instructors" element={<InstructorsPage />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="rosters" element={<Rosters />} />
        <Route path="finances" element={<Finances />} />
        <Route path="payouts" element={<Payouts />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="dev/extraction-test" element={<ExtractionTest />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
