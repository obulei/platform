import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The repo-root .env is the single source of local config; a server/.env wins.
config({ path: resolve(here, '../../.env') });
config({ path: resolve(here, '../.env'), override: true });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy env.example to .env at the repository root.`
    );
  }
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  port: Number(process.env.PORT ?? 8080),
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /**
   * Read once, by the migration that moves a pre-tenancy database's tables into
   * their own schema. After that the registry names the facilities and these are
   * never consulted again.
   */
  firstFacilitySlug: process.env.FIRST_FACILITY_SLUG ?? 'cyber-hospitals',
  firstFacilityName: process.env.FIRST_FACILITY_NAME ?? 'Cyber Hospitals'
};
