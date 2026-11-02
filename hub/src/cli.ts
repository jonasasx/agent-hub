// Hub CLI: node dist/cli.js <command>. Needs DATABASE_URL (and OIDC_ALLOWED_EMAILS for the default runner owner;
// S3_BUCKET_DATA, AWS_REGION, S3_PREFIX and AWS credentials for events:backfill-blobs).
import { createDb, createPool } from './db/db.js';
import { migrate } from './db/migrate.js';
import { runCli } from './cliCommands.js';
import { S3Store } from './storage/objectStore.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url);
  const db = createDb(pool);
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === 'migrate') {
      const applied = await migrate(pool);
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
      process.exitCode = 0;
    } else {
      const bucket = process.env.S3_BUCKET_DATA;
      const store = bucket ? new S3Store(bucket, process.env.AWS_REGION ?? 'eu-central-1', process.env.S3_PREFIX ?? '') : undefined;
      process.exitCode = await runCli(argv, db, s => console.log(s), process.env, { store });
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
