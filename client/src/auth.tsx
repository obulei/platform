import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, session, type SessionUser } from './api';

interface AuthState {
  user: SessionUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => session.user());

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api<{ token: string; user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    session.save(result.token, result.user);
    setUser(result.user);
  }, []);

  const signOut = useCallback(() => {
    session.clear();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, signIn, signOut }), [user, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

/** Roles mirror the server's allow-lists so menus do not offer doomed actions. */
export function can(user: SessionUser | null, roles: string[]): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return roles.includes(user.role);
}
