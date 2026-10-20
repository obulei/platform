export const MIN_PASSWORD = 10;

/**
 * The client mirror of `passwordField` in server/src/lib/password.ts, worded the
 * same way so the person typing meets one rule, not two. Length alone is not the
 * rule: ten spaces is long enough to pass a counter yet impossible to type back,
 * so what counts is the characters left after the spaces are ignored.
 */
export function passwordProblem(value: string): string | null {
  if (value.trim().length < MIN_PASSWORD) {
    return `Use at least ${MIN_PASSWORD} characters that are not spaces.`;
  }
  if (value !== value.trim()) return 'A password cannot start or end with a space.';
  return null;
}

/** The line shown under every password field. */
export const PASSWORD_HINT = `At least ${MIN_PASSWORD} characters that are not spaces. Spaces are welcome inside.`;
