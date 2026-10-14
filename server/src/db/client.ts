import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema/index.js';

const client = postgres(env.databaseUrl, { max: 10, idle_timeout: 20 });

export const db = drizzle(client, { schema });
export { client as pgClient };
export type Database = typeof db;
