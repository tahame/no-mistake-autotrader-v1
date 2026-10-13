import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './db/db.js';
import { startWorkers } from './workers.js';

const app = await buildApp();
const stopWorkers = config.RUN_WORKERS ? startWorkers(app.log) : () => {};

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  stopWorkers();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
