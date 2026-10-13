import { execSync } from 'node:child_process';

// Fresh test database for every run: drop, create, migrate.
export default async function setup() {
  const admin = process.env.TEST_ADMIN_URL ?? 'postgres://kbay:kbay@localhost:5432/postgres';
  const { default: postgres } = await import('postgres');
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  await sql.unsafe('drop database if exists kbay_test with (force)');
  await sql.unsafe('create database kbay_test');
  await sql.end();
  execSync('npx tsx src/db/migrate.ts', { stdio: 'inherit', env: { ...process.env, ...testEnv() } });
}

export function testEnv() {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://kbay_app:test-app-password-123@localhost:5432/kbay_test',
    DATABASE_ADMIN_URL: process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://kbay:kbay@localhost:5432/kbay_test',
    APP_DB_PASSWORD: process.env.TEST_APP_DB_PASSWORD ?? 'test-app-password-123',
    RUN_WORKERS: 'false',
    LOG_LEVEL: 'warn',
  };
}
