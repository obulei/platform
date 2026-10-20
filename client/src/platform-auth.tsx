import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { platformApi, platformSession, type PlatformAdmin } from './api';

interface PlatformAuthState {
  admin: PlatformAdmin | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const PlatformAuthContext = createContext<PlatformAuthState | null>(null);

/**
 * Sign-in for the operator who runs the platform, kept apart from `auth.tsx`
 * because it is a different identity: this one creates hospitals and holds no
 * clinical role in any of them. The two tokens live under separate keys and are
 * never sent to each other's routes.
 */
export function PlatformAuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<PlatformAdmin | null>(() => platformSession.admin());

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await platformApi<{ token: string; admin: PlatformAdmin }>('/api/platform/login', {
      method: 'POST',
      body: { email, password }
    });
    platformSession.save(result.token, result.admin);
    setAdmin(result.admin);
  }, []);

  const signOut = useCallback(() => {
    platformSession.clear();
    setAdmin(null);
  }, []);

  const value = useMemo(() => ({ admin, signIn, signOut }), [admin, signIn, signOut]);

  return <PlatformAuthContext.Provider value={value}>{children}</PlatformAuthContext.Provider>;
}

export function usePlatformAuth(): PlatformAuthState {
  const context = useContext(PlatformAuthContext);
  if (!context) throw new Error('usePlatformAuth must be used inside PlatformAuthProvider');
  return context;
}
