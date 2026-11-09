// Task 3.10 (design D10 `GET /metrics`, spec replication «Метрики и предупреждение о диске»): Prometheus text with the
// database size, free space of the Postgres data volume, online runners and replication lag; a Telegram warning when
// the volume has less than DISK_ALERT_FREE_PCT free, at most once in 12 h while it lasts (the time survives restarts).
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { countUnlinked } from '../subagents/repo.js';
import { sql } from 'kysely';
import type { Db } from '../db/db.js';

export interface DiskStat {
  /** Free bytes available to the database (statfs bavail × bsize). */
  free: number;
  total: number;
}

export async function diskStat(path: string): Promise<DiskStat> {
  const s = await statfs(path);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}

export type StatFn = (path: string) => Promise<DiskStat>;

/** Telegram Bot API sendMessage; resolves false (and logs) when not configured or refused. */
export type SendTelegram = (text: string) => Promise<boolean>;

export function telegramSender(token: string | undefined, chatId: string | undefined, log: { warn(o: object, m: string): void }, fetchFn: typeof fetch = fetch): SendTelegram {
  return async text => {
    if (!token || !chatId) {
      log.warn({}, 'telegram alert not sent: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set');
      return false;
    }
    try {
      const r = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) log.warn({ status: r.status }, 'telegram alert refused');
      return r.ok;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'telegram alert failed');
      return false;
    }
  };
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** The Prometheus exposition of the hub (text format 0.0.4). */
export async function renderMetrics(
  db: Db,
  o: { dataPath: string; stat?: StatFn; online: (runnerId: string) => boolean; lag: () => Promise<Array<{ runnerId: string; bytes: number; files: number }>> },
): Promise<string> {
  const out: string[] = [];
  const metric = (name: string, help: string, type: 'gauge', samples: Array<[Record<string, string>, number]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) {
      const l = Object.entries(labels)
        .map(([k, x]) => `${k}="${esc(x)}"`)
        .join(',');
      out.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(v) ? v : 'NaN'}`);
    }
  };
  const size = await sql<{ n: string }>`SELECT pg_database_size(current_database()) AS n`.execute(db);
  metric('agenthub_db_bytes', 'Size of the hub database.', 'gauge', [[{}, Number(size.rows[0]!.n)]]);
  try {
    const d = await (o.stat ?? diskStat)(o.dataPath);
    metric('agenthub_disk_free_ratio', 'Free share of the Postgres data volume (0..1).', 'gauge', [[{}, d.total ? d.free / d.total : NaN]]);
    metric('agenthub_disk_free_bytes', 'Free bytes of the Postgres data volume.', 'gauge', [[{}, d.free]]);
  } catch {
    metric('agenthub_disk_free_ratio', 'Free share of the Postgres data volume (0..1).', 'gauge', [[{}, NaN]]);
  }
  const runners = await db.selectFrom('runners').select(['id']).orderBy('id').execute();
  metric(
    'agenthub_runner_online',
    '1 when the agent of the runner is connected.',
    'gauge',
    runners.map(r => [{ runner: r.id }, o.online(r.id) ? 1 : 0]),
  );
  // The agent reports each transcript's size on disk (repl.files after connect); lag = bytes not acked by the hub.
  const lag = await o.lag();
  metric(
    'agenthub_replication_lag_bytes',
    'Bytes of transcripts on the machine (last listing) not yet stored by the hub.',
    'gauge',
    lag.map(r => [{ runner: r.runnerId }, r.bytes]),
  );
  metric(
    'agenthub_replication_lag_files',
    'Transcripts of the machine with bytes not yet stored by the hub.',
    'gauge',
    lag.map(r => [{ runner: r.runnerId }, r.files]),
  );
  // change `subagents`: transcripts of subagents linked neither to a call nor to a meta.json (unknown format, lost call)
  metric('agenthub_subagent_unlinked', 'Subagent transcripts with neither a call nor a meta.json in the registry.', 'gauge', [[{}, await countUnlinked(db)]]);
  return `${out.join('\n')}\n`;
}

export const DISK_ALERT_KEY = 'disk_free_low';
export const DISK_ALERT_EVERY_MS = 12 * 3600_000;

/**
 * Period of the disk check: 0 (off) when the data volume is not mounted — a platform pod has no database volume
 * (paas-deployment D2). An injected stat (tests) always counts as mounted.
 */
export function diskCheckPeriodMs(o: { dataPath: string; periodMs: number; injectedStat: boolean; exists?: (path: string) => boolean }): number {
  if (o.injectedStat) return o.periodMs;
  return (o.exists ?? existsSync)(o.dataPath) ? o.periodMs : 0;
}

/** One check of the data volume: sends the warning when free < threshold and the last one is 12 h old or more. */
export async function checkDisk(
  db: Db,
  o: { dataPath: string; thresholdPct: number; hostLabel: string; stat?: StatFn; send: SendTelegram; now?: () => Date },
): Promise<'ok' | 'sent' | 'suppressed' | 'failed'> {
  const d = await (o.stat ?? diskStat)(o.dataPath);
  const pct = d.total ? (d.free / d.total) * 100 : 100;
  if (pct >= o.thresholdPct) {
    // The condition is over: the next drop below the threshold warns at once, not 12 h after the last warning.
    await db.deleteFrom('alert_state').where('key', '=', DISK_ALERT_KEY).execute();
    return 'ok';
  }
  const now = o.now?.() ?? new Date();
  const last = await db.selectFrom('alert_state').select('last_sent_at').where('key', '=', DISK_ALERT_KEY).executeTakeFirst();
  if (last && now.getTime() - last.last_sent_at.getTime() < DISK_ALERT_EVERY_MS) return 'suppressed';
  const size = await sql<{ n: string }>`SELECT pg_database_size(current_database()) AS n`.execute(db);
  const gb = (Number(size.rows[0]!.n) / 1024 ** 3).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const text = `Agent Hub: ${o.hostLabel} has ${Math.floor(pct)}% of disk free, DB ${gb} GB`;
  if (!(await o.send(text))) return 'failed';
  await db
    .insertInto('alert_state')
    .values({ key: DISK_ALERT_KEY, last_sent_at: now, detail: text })
    .onConflict(oc => oc.column('key').doUpdateSet({ last_sent_at: now, detail: text }))
    .execute();
  return 'sent';
}

/**
 * The periodic disk check of the hub (every 10 min): «suppressed» is logged at debug, a failed send (Telegram down,
 * no token) waits before the next try — 10 min, doubling, at most 1 h — instead of retrying every tick.
 */
export class DiskWatch {
  private failures = 0;
  private nextTryAt = 0;
  constructor(
    private readonly db: Db,
    private readonly o: Parameters<typeof checkDisk>[1] & { log: { debug(o: object, m: string): void; info(o: object, m: string): void; warn(o: object, m: string): void }; baseRetryMs?: number },
  ) {}

  async tick(): Promise<'ok' | 'sent' | 'suppressed' | 'failed' | 'waiting'> {
    const now = (this.o.now?.() ?? new Date()).getTime();
    if (now < this.nextTryAt) return 'waiting';
    const r = await checkDisk(this.db, this.o);
    if (r === 'failed') {
      this.failures++;
      const wait = Math.min(3600_000, (this.o.baseRetryMs ?? 10 * 60_000) * 2 ** (this.failures - 1));
      this.nextTryAt = now + wait;
      this.o.log.warn({ failures: this.failures, retryInMs: wait }, 'disk warning not sent');
    } else {
      this.failures = 0;
      this.nextTryAt = 0;
      if (r === 'sent') this.o.log.info({}, 'disk warning sent');
      if (r === 'suppressed') this.o.log.debug({}, 'disk low, warning already sent within 12 h');
    }
    return r;
  }
}
