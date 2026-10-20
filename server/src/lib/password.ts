import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const derive = promisify(scrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 10;

/**
 * One definition of a password worth hashing, used by every route that sets one.
 *
 * A bare length check accepts ten spaces: the account is created, the hash is
 * real, and nobody is ever told a password they can type — which reads as a broken
 * login rather than a form that was never checked. Edge spaces come from phones and
 * copy-paste just as silently and then look like a wrong password. Internal spaces
 * stay allowed, because a passphrase is still a passphrase.
 */
export const passwordField = z.string().superRefine((value, issue) => {
  if (value.trim().length < MIN_PASSWORD_LENGTH) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: `Use at least ${MIN_PASSWORD_LENGTH} characters that are not spaces.` });
    return;
  }
  if (value !== value.trim()) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: 'A password cannot start or end with a space.' });
  }
});

/**
 * Well-formed but unreachable. A sign-in that cannot possibly match — an unknown
 * hospital or unknown account — is still hashed against this, so the attempt costs
 * the same scrypt work as a wrong password and the response stays indistinguishable
 * in both message and timing.
 */
export const DECOY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = (await derive(password.normalize('NFKC'), salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = (await derive(password.normalize('NFKC'), salt, expected.length)) as Buffer;

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
