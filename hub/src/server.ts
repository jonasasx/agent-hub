import { loadConfig } from './config.js';
import { startHub } from './start.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production' && !config.S3_BUCKET_DATA) throw new Error('S3_BUCKET_DATA is required in production (design D7)');
  // Migrations, then the hub, then listen (start.ts).
  const started = await startHub(config);
  const log = started.hub.app.log;
  // A stray rejected promise is logged, the hub keeps serving (review M3a).
  process.on('unhandledRejection', reason => log.error({ err: reason }, 'unhandled rejection'));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await started.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
