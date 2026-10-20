import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as registrySchema from './schema/registry.js';

/**
 * The deployment-wide connection. Its search_path is the default `public`, so it
 * reaches the facility registry and nothing clinical: once tenancy is applied the
 * clinical tables live in per-facility schemas and are not resolvable here at
 * all. A query that forgets its facility handle fails with
 * `relation "…" does not exist` rather than reading the wrong hospital.
 *
 * Clinical code uses `request.db` (see lib/auth.ts) or `tenantDb(facility)`.
 */
const publicClient = postgres(env.databaseUrl, { max: 10, idle_timeout: 20 });

export const publicDb = drizzle(publicClient, { schema: registrySchema });
export { publicClient };
export type PublicDatabase = typeof publicDb;
