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
import MarketingShell from './pages/admin/marketing/MarketingShell.jsx';
import Schedule from './pages/admin/Schedule.jsx';
import ExtractionTest from './pages/admin/dev/ExtractionTest.jsx';
import CurriculaList from './pages/admin/curricula/CurriculaList.jsx';
import ProgramsCalendar from './pages/admin/programs/ProgramsCalendar.jsx';
import InstructorPortal from './pages/j2s/InstructorPortal.jsx';
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
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="marketing" element={<MarketingShell />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="curricula" element={<CurriculaList />} />
        <Route path="programs" element={<ProgramsCalendar />} />
        <Route path="dev/extraction-test" element={<ExtractionTest />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
