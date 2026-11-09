// Hub CLI: node dist/cli.js <command>. Needs DATABASE_URL (and OIDC_ALLOWED_EMAILS or HUB_ADMIN_EMAILS for the default
// runner owner; for events:backfill-blobs the S3 settings of the hub — S3_BUCKET_DATA, AWS_REGION, S3_ENDPOINT and the
// rest, with the same platform aliases and validation as the server).
import { createDb, createPool } from './db/db.js';
import { migrate } from './db/migrate.js';
import { runCli } from './cliCommands.js';
import { createS3Client, S3Store } from './storage/objectStore.js';
import { hubEnv, loadS3Settings } from './config.js';

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
      const env = hubEnv(process.env);
      const c = loadS3Settings(process.env);
      const s3 = createS3Client({
        region: c.AWS_REGION,
        endpoint: c.S3_ENDPOINT,
        forcePathStyle: c.S3_FORCE_PATH_STYLE,
        accessKeyId: c.S3_ACCESS_KEY_ID,
        secretAccessKey: c.S3_SECRET_ACCESS_KEY,
      });
      const store = c.S3_BUCKET_DATA ? new S3Store(c.S3_BUCKET_DATA, c.AWS_REGION, c.S3_PREFIX, s3) : undefined;
      process.exitCode = await runCli(argv, db, s => console.log(s), env, { store });
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
