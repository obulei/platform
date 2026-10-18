import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, session, type SessionUser } from './api';

interface AuthState {
  user: SessionUser | null;
  signIn: (email: string, password: string, role?: string) => Promise<void>;
  /** Change which granted role the session acts as. Keeps every screen open. */
  switchRole: (role: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => session.user());

  const signIn = useCallback(async (email: string, password: string, role?: string) => {
    const result = await api<{ token: string; user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: { email, password, ...(role ? { role } : {}) }
    });
    session.save(result.token, result.user);
    setUser(result.user);
  }, []);

  const switchRole = useCallback(async (role: string) => {
    const result = await api<{ token: string; user: SessionUser }>('/api/auth/switch-role', {
      method: 'POST',
      body: { role }
    });
    session.save(result.token, result.user);
    setUser(result.user);
  }, []);

  const signOut = useCallback(() => {
    session.clear();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, signIn, switchRole, signOut }), [user, signIn, switchRole, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

/**
 * Mirrors the server's allow-lists so menus do not offer doomed actions. Only
 * the role the session is acting as counts, not the other roles the person
 * holds — the API checks the same thing.
 */
export function can(user: SessionUser | null, roles: string[]): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return roles.includes(user.role);
}
