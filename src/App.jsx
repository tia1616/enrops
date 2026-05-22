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
import Schedule from './pages/admin/Schedule.jsx';
import ExtractionTest from './pages/admin/dev/ExtractionTest.jsx';
import CurriculaList from './pages/admin/curricula/CurriculaList.jsx';
import CurriculumNew from './pages/admin/curricula/CurriculumNew.jsx';
import CurriculumExtracting from './pages/admin/curricula/CurriculumExtracting.jsx';
import CurriculumReview from './pages/admin/curricula/CurriculumReview.jsx';
import ProgramsCalendar from './pages/admin/programs/ProgramsCalendar.jsx';
import LocationsList from './pages/admin/LocationsList.jsx';
import AdminBackgroundCheckUpload from './pages/admin/contractors/AdminBackgroundCheckUpload.jsx';
import InstructorPortal from './pages/j2s/InstructorPortal.jsx';
import ErrorPage from './pages/error/ErrorPage.jsx';
import OnboardingRouter from './pages/onboarding/OnboardingRouter.jsx';
import DeclinedPage from './pages/onboarding/DeclinedPage.jsx';
import AbandonedPage from './pages/onboarding/AbandonedPage.jsx';
import { CartProvider } from './context/CartContext.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<EnropsLanding />} />
      <Route path="/privacy" element={<PolicyPage policyType="privacy" orgSlug="enrops" />} />
      <Route path="/terms" element={<PolicyPage policyType="terms" orgSlug="enrops" />} />
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
      <Route path="/error" element={<ErrorPage />} />
      <Route path="/:slug/onboarding" element={<OnboardingRouter />} />
      <Route path="/:slug/onboarding/declined" element={<DeclinedPage />} />
      <Route path="/:slug/onboarding/abandoned" element={<AbandonedPage />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="marketing-v2" element={<AICampaignBuilder />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="curricula" element={<CurriculaList />} />
        <Route path="curricula/new" element={<CurriculumNew />} />
        <Route path="curricula/:id/extracting" element={<CurriculumExtracting />} />
        <Route path="curricula/:id/review" element={<CurriculumReview />} />
        <Route path="curricula/:id/edit" element={<CurriculumReview />} />
        <Route path="programs" element={<ProgramsCalendar />} />
        <Route path="locations" element={<LocationsList />} />
        <Route path="contractors/background-check-upload" element={<AdminBackgroundCheckUpload />} />
        <Route path="dev/extraction-test" element={<ExtractionTest />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
