import type { OrderEvent } from '../../contracts/order-events.js';
import type { Tx } from '../../db/db.js';
import { withSystem, withTenant } from '../../db/db.js';

// Transactional outbox: events are written in the same transaction as the order, then delivered
// to subscribers after commit (and by a background sweep). Each subscriber is idempotent per
// event, and events are delivered in order — a failing event holds back later ones.

type Handler = (tx: Tx, event: OrderEvent) => Promise<void>;
const subscribers: { name: string; types: OrderEvent['type'][]; fn: Handler }[] = [];

export function subscribe(name: string, types: OrderEvent['type'][], fn: Handler) {
  if (subscribers.some((s) => s.name === name)) throw new Error(`duplicate subscriber ${name}`);
  subscribers.push({ name, types, fn });
}

type WithoutId<T> = T extends unknown ? Omit<T, 'eventId'> : never;

export async function publish(tx: Tx, tenantId: string, event: WithoutId<OrderEvent>): Promise<string> {
  const eventId = crypto.randomUUID();
  const payload = { ...event, eventId };
  await tx`insert into orders.outbox (id, tenant_id, type, payload) values (${eventId}, ${tenantId}, ${event.type}, ${tx.json(payload as never)})`;
  return eventId;
}

let running: Promise<number> | null = null;

/** Deliver pending events. Concurrent calls share one run (single process); returns events completed. */
export function dispatchPending(): Promise<number> {
  if (running) return running;
  running = run().finally(() => {
    running = null;
  });
  return running;
}

async function run(): Promise<number> {
  let done = 0;
  for (;;) {
    const batch = await withSystem((tx) => tx<{ id: string; tenant_id: string; type: string; payload: OrderEvent }[]>`
      select id, tenant_id, type, payload from orders.outbox where processed_at is null order by created_at, id limit 50`);
    if (batch.length === 0) return done;
    for (const ev of batch) {
      try {
        for (const s of subscribers) {
          if (!s.types.includes(ev.payload.type)) continue;
          await withTenant(ev.tenant_id, async (tx) => {
            const claimed = await tx`insert into core.event_handled (event_id, handler) values (${ev.id}, ${s.name})
              on conflict do nothing returning event_id`;
            if (claimed.length === 0) return;
            await s.fn(tx, ev.payload);
          });
        }
        await withSystem((tx) => tx`update orders.outbox set processed_at = now(), attempts = attempts + 1, last_error = null where id = ${ev.id}`);
        done++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await withSystem((tx) => tx`update orders.outbox set attempts = attempts + 1, last_error = ${msg.slice(0, 1000)} where id = ${ev.id}`);
        console.error(`[outbox] event ${ev.id} (${ev.type}) failed: ${msg}`);
        return done; // keep order: later events wait for this one
      }
    }
  }
}

/** Events not yet delivered for a business day (the close waits for these). */
export async function pendingForDay(tx: Tx, dayId: string): Promise<{ count: number; lastError: string | null }> {
  const [r] = await tx<{ n: number; err: string | null }[]>`
    select count(*)::int as n, max(last_error) as err from orders.outbox
    where processed_at is null and payload->>'businessDayId' = ${dayId}`;
  return { count: r?.n ?? 0, lastError: r?.err ?? null };
}
