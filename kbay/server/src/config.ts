import { z } from 'zod';

// All secrets and environment-specific values come from the environment, never from code.
const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8080),
  // Application connection: a non-superuser role so row-level security applies.
  DATABASE_URL: z.string().min(1),
  // Owner connection used only for migrations.
  DATABASE_ADMIN_URL: z.string().min(1).optional(),
  // Password for the restricted application role created by migrations.
  APP_DB_PASSWORD: z.string().min(12).optional(),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  COOKIE_SECURE: boolish.default(false),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 14),
  TRUST_PROXY: boolish.default(false),
  WEB_DIST: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
  RUN_WORKERS: boolish.default(true),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
