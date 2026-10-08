import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createDb(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // Railway's private network doesn't use TLS; its public proxy does.
    ssl: /sslmode=require|proxy\.rlwy\.net/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export async function runMigrations(db: Db) {
  // Works from source (server/db) and from the build (dist/server/db), where migrations are copied alongside.
  await migrate(db, { migrationsFolder: path.join(here, 'migrations') });
}
