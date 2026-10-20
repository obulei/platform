const TOKEN_KEY = 'hms.token';
const USER_KEY = 'hms.user';
const FACILITY_KEY = 'hms.facility';
const PLATFORM_TOKEN_KEY = 'hms.platform.token';
const PLATFORM_ADMIN_KEY = 'hms.platform.admin';

/**
 * The wording and colour one hospital owns. Stored on its registry row, edited by
 * the operator's console and by that hospital's own administrators. An empty
 * string always means "use the app default", never "show nothing".
 */
export interface FacilityBranding {
  mark: string;
  tagline: string;
  accent: string;
  reportCaption: string;
  reportFootnote: string;
}

/** The hospital a session belongs to. Fixed by the sign-in token. */
export interface FacilityRef extends FacilityBranding {
  id: string;
  slug: string;
  name: string;
}

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
  facility: FacilityRef;
}

/**
 * The platform operator's own session. Stored under different keys from a clinic
 * session on purpose: the two tokens are different kinds of credential, and a
 * hospital administrator's token must never be attached to a `/api/platform` call
 * (or vice versa) just because both are sitting in the same browser.
 */
export interface PlatformAdmin {
  id: string;
  fullName: string;
  email: string;
}

export const platformSession = {
  token: () => localStorage.getItem(PLATFORM_TOKEN_KEY),
  admin(): PlatformAdmin | null {
    const raw = localStorage.getItem(PLATFORM_ADMIN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PlatformAdmin;
    } catch {
      return null;
    }
  },
  save(token: string, admin: PlatformAdmin) {
    localStorage.setItem(PLATFORM_TOKEN_KEY, token);
    localStorage.setItem(PLATFORM_ADMIN_KEY, JSON.stringify(admin));
  },
  clear() {
    localStorage.removeItem(PLATFORM_TOKEN_KEY);
    localStorage.removeItem(PLATFORM_ADMIN_KEY);
  }
};

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
      const parsed = JSON.parse(raw) as SessionUser;
      // A stored session from before tenancy has no hospital, so its token
      // cannot be honoured — drop it and let the person sign in again.
      return parsed.facility ? parsed : null;
    } catch {
      return null;
    }
  },
  save(token: string, user: SessionUser) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  /** Kept across sign-out so staff type their hospital code once per machine. */
  lastFacility: () => localStorage.getItem(FACILITY_KEY) ?? '',
  rememberFacility(slug: string) {
    localStorage.setItem(FACILITY_KEY, slug);
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
 * so an expired token cannot leave a screen full of dead forms. Each kind of
 * session goes back to its own sign-in page.
 */
function redirectTo(loginPath: string) {
  if (!window.location.pathname.startsWith(loginPath)) {
    window.location.assign(loginPath);
  }
}

async function request<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; query?: Query },
  token: string | null,
  onUnauthorized: () => void
): Promise<T> {
  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 401) {
    onUnauthorized();
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

export function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; query?: Query } = {}
): Promise<T> {
  return request<T>(path, options, session.token(), () => {
    session.clear();
    redirectTo('/login');
  });
}

/** The same call, authenticated as the platform operator instead of clinic staff. */
export function platformApi<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; query?: Query } = {}
): Promise<T> {
  return request<T>(path, options, platformSession.token(), () => {
    platformSession.clear();
    redirectTo('/platform/login');
  });
}

/** One hospital as the operator sees it. Counts come from that hospital's own database. */
export interface PlatformFacility {
  id: string;
  slug: string;
  name: string;
  branding: FacilityBranding;
  status: 'active' | 'suspended';
  createdAt: string;
  staffCount: number;
  patientCount: number;
  administrators: PlatformAdministrator[];
  activeAdministratorCount: number;
}

/** An administrator account inside one hospital, as the console lists it. */
export interface PlatformAdministrator {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
}

export interface PlatformAdministratorInput {
  fullName: string;
  email: string;
  password: string;
}

/** A platform operator: the account that adds hospitals, not a clinic role. */
export interface PlatformOperator {
  id: string;
  fullName: string;
  email: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export const platformFacilities = {
  list: () => platformApi<{ items: PlatformFacility[]; total: number }>('/api/platform/facilities'),
  create: (input: { slug: string; name: string; administrator: PlatformAdministratorInput }) =>
    platformApi<PlatformFacility>('/api/platform/facilities', { method: 'POST', body: input }),
  update: (slug: string, patch: { name?: string } & Partial<FacilityBranding>) =>
    platformApi<PlatformFacility>(`/api/platform/facilities/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: patch
    }),
  addAdministrator: (slug: string, input: PlatformAdministratorInput) =>
    platformApi<PlatformAdministrator>(
      `/api/platform/facilities/${encodeURIComponent(slug)}/administrators`,
      { method: 'POST', body: input }
    ),
  setAdministrator: (slug: string, staffId: string, patch: { fullName?: string; isActive?: boolean }) =>
    platformApi<PlatformAdministrator>(
      `/api/platform/facilities/${encodeURIComponent(slug)}/administrators/${staffId}`,
      { method: 'PATCH', body: patch }
    ),
  resetAdministratorPassword: (slug: string, staffId: string, password: string) =>
    platformApi<{ id: string; email: string; passwordChangedAt: string }>(
      `/api/platform/facilities/${encodeURIComponent(slug)}/administrators/${staffId}/reset-password`,
      { method: 'POST', body: { password } }
    ),
  setStatus: (slug: string, status: PlatformFacility['status']) =>
    platformApi<PlatformFacility>(`/api/platform/facilities/${encodeURIComponent(slug)}/status`, {
      method: 'PATCH',
      body: { status }
    })
};

export const platformOperators = {
  list: () => platformApi<{ items: PlatformOperator[]; total: number }>('/api/platform/operators'),
  add: (input: PlatformAdministratorInput) =>
    platformApi<PlatformOperator>('/api/platform/operators', { method: 'POST', body: input }),
  remove: (id: string) =>
    platformApi<{ removed: string }>(`/api/platform/operators/${id}`, { method: 'DELETE' })
};

/** This hospital's own identity, read and written with a clinic session by its administrators. */
export const facilitySettings = {
  read: () => api<{ facility: FacilityRef }>('/api/settings'),
  save: (branding: FacilityBranding) => api<FacilityRef>('/api/settings', { method: 'PATCH', body: branding })
};
