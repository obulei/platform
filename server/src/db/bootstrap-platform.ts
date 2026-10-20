/**
 * Creates the first platform administrator — the account that signs clinics up.
 *
 * There is no way to make one from inside the product: the platform screens are
 * what it protects, and hospital staff accounts cannot reach them. So the very
 * first one is made here, once, per deployment.
 *
 *   npm run platform:admin --workspace server -- --name "Moses Obulei" --email ops@cyber.org
 *
 * Run it from the repository root. From inside `server/`, drop the `--workspace server`.
 *
 * Password comes from `PLATFORM_ADMIN_PASSWORD`, or is generated and printed
 * once. Nothing is stored in the repository either way.
 */
import { randomBytes } from 'node:crypto';
import { publicClient } from './client.js';
import { createPlatformAdmin, findPlatformAdminByEmail } from './provision.js';
import { passwordField } from '../lib/password.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function password(): string {
  const fromEnv = process.env.PLATFORM_ADMIN_PASSWORD;
  if (fromEnv === undefined || fromEnv === '') return `${randomBytes(18).toString('base64url')}#A9`;
  const checked = passwordField.safeParse(fromEnv);
  if (!checked.success) {
    throw new Error(
      `PLATFORM_ADMIN_PASSWORD ${checked.error.issues[0].message} — or unset it to generate one.`
    );
  }
  return fromEnv;
}

async function main() {
  const fullName = flag('name');
  const email = flag('email');
  if (!fullName || !email) {
    throw new Error(
      'Usage: npm run platform:admin --workspace server -- --name "Full Name" --email address@example.org'
    );
  }

  const generated = process.env.PLATFORM_ADMIN_PASSWORD === undefined || process.env.PLATFORM_ADMIN_PASSWORD === '';
  const secret = password();

  if (await findPlatformAdminByEmail(email)) {
    throw new Error(`A platform administrator already uses ${email}.`);
  }

  const admin = await createPlatformAdmin({ fullName, email, password: secret });
  console.log(`Platform administrator created: ${admin.fullName} <${admin.email}>`);
  console.log(
    generated
      ? `Password (shown once, not stored anywhere): ${secret}`
      : 'Password: the PLATFORM_ADMIN_PASSWORD you supplied (not echoed here).'
  );
  console.log('Sign in at /platform. Create a second administrator before relying on this one.');

  await publicClient.end();
}

main().catch(async (error) => {
  console.error(error);
  await publicClient.end().catch(() => undefined);
  process.exit(1);
});
