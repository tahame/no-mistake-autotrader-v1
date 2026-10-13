import { withSystem } from './db/db.js';
import * as approvals from './modules/approvals/index.js';
import { deliverPush, notify, orgSetting } from './modules/notifications/index.js';
import { usersWithPermission } from './modules/identity/index.js';
import { dispatchPending } from './modules/orders/index.js';
import { localDate, localTime } from './modules/tenancy/index.js';

// Background work, run in-process: deliver order events, push notifications, and the reminders
// (daily close, approval follow-ups, unanswered questions). Each step is safe to repeat.

type Log = { error: (o: unknown, msg?: string) => void };

/** Evening reminder to the stall lead if the day is still open (sales not closed out). */
export async function dailyCloseReminders(): Promise<number> {
  return withSystem(async (tx) => {
    const days = await tx<{ id: string; tenant_id: string; org_id: string; location_id: string; business_date: string; timezone: string; name: string }[]>`
      select d.id, d.tenant_id, d.org_id, d.location_id, d.business_date, o.timezone, l.name
      from finance.business_days d join core.organizations o on o.id = d.org_id join core.locations l on l.id = d.location_id
      where d.status = 'open'`;
    let n = 0;
    for (const d of days) {
      const s = await orgSetting(tx, d.org_id, 'daily_close_reminder');
      if (!s.enabled) continue;
      const time = String(s.config.time ?? '23:00');
      const today = localDate(d.timezone);
      // Remind once the configured time has passed on the business date, or any time on a later date.
      if (today === d.business_date && localTime(d.timezone) < time) continue;
      const users = await usersWithPermission(tx, d.org_id, 'day.close', d.location_id);
      n += await notify(tx, { tenantId: d.tenant_id, orgId: d.org_id, userIds: users, type: 'daily_close_reminder',
        title: `Close the day at ${d.name}`, body: `Enter the cash count and submit the close for ${d.business_date}.`,
        link: '/day', dedupeKey: `close:${d.id}:${today}` });
    }
    return n;
  });
}

export function startWorkers(log: Log): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let busy = false;
    timers.push(setInterval(() => {
      if (busy) return;
      busy = true;
      fn().catch((err) => log.error(err, `worker ${name} failed`)).finally(() => { busy = false; });
    }, ms));
  };
  every(5_000, 'outbox', dispatchPending);
  every(5_000, 'push', deliverPush);
  every(60_000, 'approval-reminders', () => withSystem((tx) => approvals.sendReminders(tx)));
  every(60_000, 'question-followups', () => withSystem((tx) => approvals.questionFollowups(tx)));
  every(300_000, 'close-reminders', dailyCloseReminders);
  return () => timers.forEach(clearInterval);
}
