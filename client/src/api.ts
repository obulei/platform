const TOKEN_KEY = 'hms.token';
const USER_KEY = 'hms.user';

export interface SessionUser {
  id: string;
  fullName: string;
  email: string;
  /** The role this session is acting as. */
  role: string;
  /** Every role the account has been granted. */
  roles: string[];
  department?: string | null;
  specialty?: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: { field: string; message: string }[],
    /** Set when sign-in must choose between the roles this account holds. */
    readonly roles?: string[]
  ) {
    super(message);
  }
}

export const session = {
  token: () => localStorage.getItem(TOKEN_KEY),
  user(): SessionUser | null {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionUser;
    } catch {
      return null;
    }
  },
  save(token: string, user: SessionUser) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
};

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * On a 401 the stored session is dropped and the app is sent back to sign-in,
 * so an expired token cannot leave a screen full of dead forms.
 */
function handleUnauthorized() {
  session.clear();
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; query?: Query } = {}
): Promise<T> {
  const token = session.token();
  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError('Your session has expired. Please sign in again.', 401);
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(
      payload?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      payload?.error,
      payload?.details,
      payload?.roles
    );
  }

  return payload as T;
}
