import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db, pgClient } from './client.js';
import { applyAdvancedConstraints } from './advanced.js';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main() {
  // Must precede the generated migration: two tables default to nextval().
  await pgClient.unsafe(
    `create sequence if not exists patient_mrn_seq start 1 increment 1;
     create sequence if not exists invoice_number_seq start 1 increment 1;`
  );

  await migrate(db, { migrationsFolder });
  await applyAdvancedConstraints();

  console.log('migrations applied');
  await pgClient.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
