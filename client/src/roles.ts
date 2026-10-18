/** Mirrors the `staff_role` enum in server/src/db/schema/enums.ts. */
export const ROLES = ['admin', 'reception', 'doctor', 'nurse', 'pharmacist', 'lab_technician', 'billing'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  reception: 'Reception',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacist: 'Pharmacist',
  lab_technician: 'Lab technician',
  billing: 'Billing clerk'
};

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'clinical';

export const ROLE_TONE: Record<string, Tone> = {
  admin: 'clinical',
  doctor: 'info',
  nurse: 'success',
  pharmacist: 'warning',
  lab_technician: 'info',
  reception: 'neutral',
  billing: 'neutral'
};

/** Server enum order, so two accounts with the same grants always look alike. */
export function sortRoles<R extends string>(roles: readonly R[]): R[] {
  return [...new Set(roles)].sort((a, b) => ROLES.indexOf(a as Role) - ROLES.indexOf(b as Role));
}

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}
