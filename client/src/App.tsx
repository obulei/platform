import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.js';
import { usePlatformAuth } from './platform-auth.js';
import { Layout, navAllows } from './layout.js';
import { EmptyState } from './components.js';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { PatientsPage } from './pages/PatientsPage.js';
import { PatientDetailPage } from './pages/PatientDetailPage.js';
import { AppointmentsPage } from './pages/AppointmentsPage.js';
import { WardsPage } from './pages/WardsPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { PharmacyPage } from './pages/PharmacyPage.js';
import { LabPage } from './pages/LabPage.js';
import { BillingPage } from './pages/BillingPage.js';
import { StaffPage } from './pages/StaffPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { PlatformLoginPage } from './pages/PlatformLoginPage.js';
import { PlatformHospitalsPage } from './pages/PlatformHospitalsPage.js';
import { PlatformOperatorsPage } from './pages/PlatformOperatorsPage.js';

/**
 * Two apps share this bundle: the hospital one staff use, and `/platform`, which
 * only the operator who adds hospitals can reach. They are separate route trees
 * because they are separate identities — each one ignores the other's token.
 */
export function App() {
  return (
    <Routes>
      <Route path="/platform/*" element={<PlatformApp />} />
      <Route path="/*" element={<ClinicApp />} />
    </Routes>
  );
}

function PlatformApp() {
  const { admin } = usePlatformAuth();

  useEffect(() => {
    const previous = document.title;
    document.title = 'Hospital platform';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<PlatformLoginPage />} />
      <Route
        path="/"
        element={admin ? <PlatformHospitalsPage /> : <Navigate to="/platform/login" replace />}
      />
      <Route
        path="/operators"
        element={admin ? <PlatformOperatorsPage /> : <Navigate to="/platform/login" replace />}
      />
      <Route path="*" element={<Navigate to="/platform" replace />} />
    </Routes>
  );
}

function ClinicApp() {
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
        <Route path="/reports" element={<Guard path="/reports"><ReportsPage /></Guard>} />
        <Route path="/pharmacy" element={<Guard path="/pharmacy"><PharmacyPage /></Guard>} />
        <Route path="/lab" element={<Guard path="/lab"><LabPage /></Guard>} />
        <Route path="/billing" element={<Guard path="/billing"><BillingPage /></Guard>} />
        <Route path="/staff" element={<Guard path="/staff"><StaffPage /></Guard>} />
        <Route path="/audit" element={<Guard path="/audit"><AuditPage /></Guard>} />
        <Route path="/settings" element={<Guard path="/settings"><SettingsPage /></Guard>} />
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
