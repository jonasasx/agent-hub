// `cli.js sessions:reclassify` (design D5, QA M3a): source signals are recomputed from the stored events of main
// transcripts only, then `source` (not for hub sessions), `origin_source` (not for sessions the hub created) and the
// cron read-only mark follow the D5 rules. Idempotent; --dry-run only reports.
import { sql } from 'kysely';
import { platformOfHome } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { cronReadOnly, rowSignals } from './ingest.js';
import { sessionSource } from './source.js';

interface Signals {
  session_id: string;
  cli: boolean;
  sdk: boolean;
  human: boolean;
  human_non_cli: boolean;
  rc: boolean;
}

export async function reclassifySessions(db: Db, o: { dryRun: boolean; log?: (s: string) => void }): Promise<{ scanned: number; changed: number; bySource: Record<string, number> }> {
  const human = sql`e.type = 'user' AND COALESCE((e.payload ->> 'isMeta')::boolean, false) = false
    AND (e.payload ->> 'turnOrigin' = 'human' OR e.payload -> 'origin' ->> 'kind' = 'human')`;
  const signals = await sql<Signals>`
    SELECT e.session_id,
           bool_or(e.payload ->> 'entrypoint' = 'cli') AS cli,
           bool_or(e.payload ->> 'entrypoint' = 'sdk-cli') AS sdk,
           bool_or(${human}) AS human,
           bool_or(${human} AND COALESCE(e.payload ->> 'entrypoint', '') <> 'cli') AS human_non_cli,
           bool_or(e.type = 'bridge-session') AS rc
      FROM events e
      JOIN transcript_files f ON f.id = e.file_id AND f.kind = 'main' AND f.superseded_at IS NULL
     GROUP BY e.session_id`.execute(db);
  const bySession = new Map(signals.rows.map(r => [r.session_id, r]));
  const runners = new Map((await db.selectFrom('runners').select(['id', 'home_dir']).execute()).map(r => [r.id, platformOfHome(r.home_dir)]));
  const sessions = await db.selectFrom('sessions').selectAll().execute();
  let changed = 0;
  const bySource: Record<string, number> = {};
  for (const s of sessions) {
    const g = bySession.get(s.id);
    const next = {
      seen_cli: g?.cli ?? false,
      seen_sdk_cli: g?.sdk ?? false,
      seen_human: g?.human ?? false,
      seen_human_non_cli: g?.human_non_cli ?? false,
      remote_control: g?.rc ?? false,
    };
    const sig = rowSignals({ ...s, ...next }, runners.get(s.runner_id) ?? null);
    const source = sessionSource({ ...sig, isHubManaged: s.is_hub_managed });
    const origin = s.origin_source === 'hub' ? 'hub' : sessionSource({ ...sig, isHubManaged: false });
    bySource[origin] = (bySource[origin] ?? 0) + 1;
    const changes = {
      ...(next.seen_cli !== s.seen_cli ? { seen_cli: next.seen_cli } : {}),
      ...(next.seen_sdk_cli !== s.seen_sdk_cli ? { seen_sdk_cli: next.seen_sdk_cli } : {}),
      ...(next.seen_human !== s.seen_human ? { seen_human: next.seen_human } : {}),
      ...(next.seen_human_non_cli !== s.seen_human_non_cli ? { seen_human_non_cli: next.seen_human_non_cli } : {}),
      ...(next.remote_control !== s.remote_control ? { remote_control: next.remote_control } : {}),
      ...(source !== s.source ? { source } : {}),
      ...(origin !== s.origin_source ? { origin_source: origin } : {}),
      ...cronReadOnly(source, s.read_only_reason),
    };
    if (!Object.keys(changes).length) continue;
    changed++;
    if (source !== s.source || origin !== s.origin_source)
      o.log?.(`${s.id} ${s.claude_session_id} ${s.runner_id}: ${s.origin_source ?? s.source} -> ${origin}${source !== origin ? ` (now ${source})` : ''}`);
    if (!o.dryRun) await db.updateTable('sessions').set(changes).where('id', '=', s.id).execute();
  }
  return { scanned: sessions.length, changed, bySource };
}
