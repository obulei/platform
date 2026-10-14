import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { can, useAuth } from './auth.js';
import type { SessionUser } from './api';
import { classList } from './utils.js';

interface NavItem {
  to: string;
  label: string;
  roles?: string[];
  icon: ReactNode;
}

const icon = (path: string) => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d={path} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: icon('M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z') },
  {
    to: '/patients',
    label: 'Patients',
    icon: icon('M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 7.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm11 11.5v-1a3.5 3.5 0 0 0-2.6-3.4M15.5 8a2.5 2.5 0 0 1 0-.01')
  },
  {
    to: '/appointments',
    label: 'Appointments',
    icon: icon('M8 3v3m8-3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z')
  },
  {
    to: '/wards',
    label: 'Wards & beds',
    roles: ['reception', 'doctor', 'nurse', 'lab_technician', 'billing', 'pharmacist'],
    icon: icon('M4 20V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v13M14 20V11h4a2 2 0 0 1 2 2v7M4 20h16M7 9h2m-2 4h2')
  },
  {
    to: '/pharmacy',
    label: 'Pharmacy',
    roles: ['doctor', 'nurse', 'pharmacist'],
    icon: icon('M10 4h4v4h4v4h-4v4h-4v-4H6V8h4V4Zm-4 16h12')
  },
  {
    to: '/lab',
    label: 'Laboratory',
    roles: ['doctor', 'nurse', 'lab_technician'],
    icon: icon('M9 3v6.5L4.8 17A2 2 0 0 0 6.5 20h11a2 2 0 0 0 1.7-3L15 9.5V3M8 3h8m-7 10h6')
  },
  {
    to: '/billing',
    label: 'Billing',
    roles: ['reception', 'billing'],
    icon: icon('M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 6h6m-6 4h4')
  },
  {
    to: '/staff',
    label: 'Staff',
    roles: [],
    icon: icon('M17 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M12 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm9 13v-1a3.5 3.5 0 0 0-2.6-3.4M15.5 7.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0Z')
  },
  {
    to: '/audit',
    label: 'Audit trail',
    roles: [],
    icon: icon('M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3Zm-2 9 2 2 4-4')
  }
];

/**
 * Mirrors the sidebar's visibility rule so a typed or bookmarked URL cannot
 * render a page the signed-in role is not shown. The API still enforces every
 * read and write; this only keeps the two in step.
 */
export function navAllows(path: string, user: SessionUser | null): boolean {
  const item = NAV.find((entry) => entry.to === path);
  if (!item) return true;
  if (!item.roles) return true;
  return can(user, item.roles);
}

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/patients': 'Patient registry',
  '/appointments': 'Appointments',
  '/wards': 'Wards and beds',
  '/pharmacy': 'Pharmacy',
  '/lab': 'Laboratory',
  '/billing': 'Billing',
  '/staff': 'Staff accounts',
  '/audit': 'Audit trail'
};

const ROLE_LABEL: Record<string, string> = {  admin: 'Administrator',
  reception: 'Reception',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacist: 'Pharmacist',
  lab_technician: 'Lab technician',
  billing: 'Billing clerk'
};

export function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const location = useLocation();

  const section = '/' + (location.pathname.split('/')[1] ?? '');
  const title = TITLES[section] ?? TITLES['/'];

  // An empty `roles` array means administrator-only; `can()` grants admins.
  const visible = NAV.filter((item) => !item.roles || can(user, item.roles));

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <span className="brand-text">
            <strong>Kisubi Medical</strong>
            <span>Hospital system</span>
          </span>
        </div>

        <span className="nav-group-label">Care</span>
        {visible
          .filter((item) => ['/', '/patients', '/appointments', '/wards'].includes(item.to))
          .map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => classList('nav-link', isActive && 'is-active')}>
              {item.icon}
              {item.label}
            </NavLink>
          ))}

        <span className="nav-group-label">Diagnostics & supplies</span>
        {visible
          .filter((item) => ['/pharmacy', '/lab'].includes(item.to))
          .map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => classList('nav-link', isActive && 'is-active')}>
              {item.icon}
              {item.label}
            </NavLink>
          ))}

        <span className="nav-group-label">Administration</span>
        {visible
          .filter((item) => ['/billing', '/staff', '/audit'].includes(item.to))
          .map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => classList('nav-link', isActive && 'is-active')}>
              {item.icon}
              {item.label}
            </NavLink>
          ))}

        <div className="sidebar-foot">
          <div className="who">
            <strong>{user?.fullName}</strong>
            <span>{user ? ROLE_LABEL[user.role] ?? user.role : ''}</span>
          </div>
          <button type="button" className="sign-out" onClick={signOut}>
            Sign out
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="crumb">Kisubi Medical · {user?.department ?? 'General'}</div>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <span className="subtle nowrap">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
