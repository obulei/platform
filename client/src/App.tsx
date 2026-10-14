import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.js';
import { Layout, navAllows } from './layout.js';
import { EmptyState } from './components.js';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { PatientsPage } from './pages/PatientsPage.js';
import { PatientDetailPage } from './pages/PatientDetailPage.js';
import { AppointmentsPage } from './pages/AppointmentsPage.js';
import { WardsPage } from './pages/WardsPage.js';
import { PharmacyPage } from './pages/PharmacyPage.js';
import { LabPage } from './pages/LabPage.js';
import { BillingPage } from './pages/BillingPage.js';
import { StaffPage } from './pages/StaffPage.js';
import { AuditPage } from './pages/AuditPage.js';

export function App() {
  const { user } = useAuth();

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/patients" element={<PatientsPage />} />
        <Route path="/patients/:patientId" element={<PatientDetailPage />} />
        <Route path="/appointments" element={<AppointmentsPage />} />
        <Route path="/wards" element={<WardsPage />} />
        <Route path="/pharmacy" element={<Guard path="/pharmacy"><PharmacyPage /></Guard>} />
        <Route path="/lab" element={<Guard path="/lab"><LabPage /></Guard>} />
        <Route path="/billing" element={<Guard path="/billing"><BillingPage /></Guard>} />
        <Route path="/staff" element={<Guard path="/staff"><StaffPage /></Guard>} />
        <Route path="/audit" element={<Guard path="/audit"><AuditPage /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

function Guard({ path, children }: { path: string; children: ReactNode }) {
  const { user } = useAuth();
  if (navAllows(path, user)) return <>{children}</>;
  return (
    <EmptyState
      title="Not available for your role"
      hint="This screen is hidden from your role in the navigation. Ask an administrator if you need it."
    />
  );
}
