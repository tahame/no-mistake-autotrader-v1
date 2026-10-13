import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createSql } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const APP_ROLE = 'kbay_app';

/**
 * Applies pending SQL migrations in filename order, each in its own transaction, then
 * (re)creates the restricted application role and its grants.
 */
export async function migrate(adminUrl = config.DATABASE_ADMIN_URL ?? config.DATABASE_URL, log = console.log) {
  const sql = createSql(adminUrl, 1);
  try {
    await sql`create table if not exists public.schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await sql<{ name: string }[]>`select name from public.schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const text = await readFile(path.join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into public.schema_migrations (name) values (${file})`;
      });
      log(`applied ${file}`);
    }
    await ensureAppRole(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ensureAppRole(sql: ReturnType<typeof createSql>) {
  const password = config.APP_DB_PASSWORD;
  const exists = (await sql`select 1 from pg_roles where rolname = ${APP_ROLE}`).length > 0;
  if (!exists && password) {
    await sql.unsafe(`create role ${APP_ROLE} login nosuperuser nobypassrls password '${password.replace(/'/g, "''")}'`);
  } else if (exists && password) {
    await sql.unsafe(`alter role ${APP_ROLE} with login nosuperuser nobypassrls password '${password.replace(/'/g, "''")}'`);
  }
  if (!exists && !password) return;
  const schemas = ['core', 'catalog', 'inventory', 'orders', 'finance', 'reporting'];
  for (const s of schemas) {
    await sql.unsafe(`grant usage on schema ${s} to ${APP_ROLE}`);
    await sql.unsafe(`grant select, insert, update, delete on all tables in schema ${s} to ${APP_ROLE}`);
    await sql.unsafe(`grant usage, select on all sequences in schema ${s} to ${APP_ROLE}`);
  }
  await sql.unsafe(`grant select on public.schema_migrations to ${APP_ROLE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => {
      console.log('migrations complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
