import postgres from 'postgres';
import { config } from '../config.js';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

// int8 columns hold money in minor units; parse them to JS numbers (safe far beyond any
// realistic balance) so the rest of the code works with plain integers.
const int8 = {
  to: 20,
  from: [20],
  serialize: (x: number | bigint) => x.toString(),
  parse: (x: string) => {
    const n = Number(x);
    if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${x}`);
    return n;
  },
};

// Calendar dates stay 'YYYY-MM-DD' strings: business dates must never shift with server timezones.
const date = {
  to: 1082,
  from: [1082],
  serialize: (x: string) => x,
  parse: (x: string) => x,
};

export function createSql(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    types: { int8, date } as never,
    onnotice: () => {},
    transform: { undefined: null },
  });
}

let pool: Sql | undefined;

export function db(): Sql {
  pool ??= createSql(config.DATABASE_URL);
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end({ timeout: 5 });
  pool = undefined;
}

/** Run fn in a transaction scoped to one tenant; row-level security enforces the scope. */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await db().begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  })) as T;
}

/** Platform-level transaction (login, owner portal, background jobs) that may see every tenant. */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await db().begin(async (tx) => {
    await tx`select set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  })) as T;
}
