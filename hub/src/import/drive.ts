// Task 3.12 (design D16, spec history-import): `import:drive` — the session exports of session_log.py in the Drive
// folder `vault-sessions` (`<session_id>__<host>.jsonl`) go into the hub by the path of live replication (repl.chunk:
// events, raw segments in S3, blobs), so a re-run adds nothing and a session already replicated live only gets the
// lines it lacks. The runner comes from the host name (runners.hostname); an unknown host gets the read-only runner
// «<host> (машина неизвестна)» of the importing user (multi-user: generated id, design M3). The report goes to import_runs.
import { readFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { LINE_HARD_LIMIT, SKIPPED_LINE_TYPE } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { DRIVE_IMPORT_DIR, Replication } from '../replication/ingest.js';
import type { ProjectService } from '../projects/service.js';
import type { AgentGateway } from '../runners/agentGateway.js';
import type { ObjectStore } from '../storage/objectStore.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { newRunnerId } from '../runners/repo.js';

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  size?: number;
}

export interface DriveClient {
  /** Files of the folder with this name (not trashed). Null when the folder is not there. */
  listFolder(name: string): Promise<DriveFile[] | null>;
  /** The file's bytes as a stream (an export is up to tens of MB: never held whole). */
  download(id: string): AsyncIterable<Uint8Array>;
}

/** Drive API v3 with the authorized-user token of session_log.py (refresh only in memory: the file is read-only). */
export async function googleDriveClient(tokenFile: string, fetchFn: typeof fetch = fetch): Promise<DriveClient> {
  const t = JSON.parse(await readFile(tokenFile, 'utf8')) as { refresh_token?: string; client_id?: string; client_secret?: string; token_uri?: string };
  if (!t.refresh_token || !t.client_id || !t.client_secret) throw new Error(`${tokenFile}: no refresh_token/client_id/client_secret`);
  let access = '';
  let until = 0;
  const token = async (): Promise<string> => {
    if (access && Date.now() < until - 60_000) return access;
    const r = await fetchFn(t.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: t.client_id!, client_secret: t.client_secret! }).toString(),
    });
    if (!r.ok) throw new Error(`Google token refresh failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    access = j.access_token;
    until = Date.now() + j.expires_in * 1000;
    return access;
  };
  const api = async (path: string): Promise<Response> => {
    const r = await fetchFn(`https://www.googleapis.com/drive/v3/${path}`, { headers: { authorization: `Bearer ${await token()}` } });
    if (!r.ok) throw new Error(`Drive ${path.split('?')[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r;
  };
  const q = (s: string) => encodeURIComponent(s);
  return {
    async listFolder(name) {
      const f = (await (await api(`files?q=${q(`name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)}&fields=files(id)`)).json()) as {
        files: Array<{ id: string }>;
      };
      if (!f.files.length) return null;
      const out: DriveFile[] = [];
      for (const folder of f.files) {
        let page: string | undefined;
        do {
          const r = (await (
            await api(`files?q=${q(`'${folder.id}' in parents and trashed = false`)}&fields=nextPageToken,files(id,name,size,modifiedTime)&pageSize=1000${page ? `&pageToken=${q(page)}` : ''}`)
          ).json()) as { nextPageToken?: string; files: Array<{ id: string; name: string; size?: string; modifiedTime: string }> };
          for (const x of r.files) out.push({ id: x.id, name: x.name, modifiedTime: x.modifiedTime, ...(x.size ? { size: Number(x.size) } : {}) });
          page = r.nextPageToken;
        } while (page);
      }
      return out;
    },
    async *download(id) {
      const r = await api(`files/${q(id)}?alt=media`);
      if (!r.body) return;
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
    },
  };
}

const NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__(.+)\.jsonl$/i;
const CHUNK_LINES = 500;

export interface ImportReport {
  folder: string;
  files: number;
  /** Distinct session ids among the export files. */
  driveSessions: number;
  sessionsNew: number;
  sessionsExtended: number;
  linesNew: number;
  skipped: Record<string, number>;
  unknownHosts: string[];
  errors: string[];
  /** Hub sessions with the Drive session ids, and how many Drive ids are not in the hub (task 3.13). */
  hubSessions: number;
  missingInHub: number;
  /** Per runner: new sessions, extended sessions, new lines. */
  byRunner: Record<string, { sessionsNew: number; sessionsExtended: number; linesNew: number }>;
}

/** Name of the runner of an unknown host; unique per owner, so a second run finds the same runner (design M3). */
export function unknownRunnerName(host: string): string {
  return `${host} (машина неизвестна)`;
}

/**
 * Lines of a stream cut as the agent cuts the file (shared LINE_HARD_LIMIT / SKIPPED_LINE_TYPE, tailer.ts): every
 * segment ending with \n is a line — an empty one too —, \r before \n is dropped, an unfinished tail is not a line, a
 * line over the limit becomes the marker line. `end` is the byte offset after the line's \n.
 */
export async function* streamLines(chunks: AsyncIterable<Uint8Array>, hardLimit = LINE_HARD_LIMIT): AsyncGenerator<{ text: string; end: number }> {
  let parts: Buffer[] = [];
  let partLen = 0;
  let overflow = 0; // bytes of a line beyond the limit (not kept)
  let offset = 0; // bytes consumed before the current chunk
  for await (const c of chunks) {
    const buf = Buffer.from(c.buffer, c.byteOffset, c.byteLength);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      const len = partLen + overflow + (nl - start);
      // A line of hardLimit bytes or more (\r counted, \n not) is a marker — the agent's window of hardLimit bytes
      // never holds its \n either (tailer.ts readLines → skipLongLine).
      if (overflow || len >= hardLimit) {
        yield { text: JSON.stringify({ type: SKIPPED_LINE_TYPE, bytes: len }), end: offset + nl + 1 };
      } else {
        const line = Buffer.concat([...parts, buf.subarray(start, nl)]).toString('utf8');
        yield { text: line.endsWith('\r') ? line.slice(0, -1) : line, end: offset + nl + 1 };
      }
      parts = [];
      partLen = 0;
      overflow = 0;
      start = nl + 1;
    }
    const rest = buf.length - start;
    if (rest > 0) {
      if (overflow || partLen + rest >= hardLimit) {
        overflow += partLen + rest;
        parts = [];
        partLen = 0;
      } else {
        parts.push(Buffer.from(buf.subarray(start)));
        partLen += rest;
      }
    }
    offset += buf.length;
  }
}

export async function importDrive(o: {
  db: Db;
  store: ObjectStore;
  client: DriveClient;
  folder?: string;
  userEmail?: string;
  log?: (s: string) => void;
  dryRun?: boolean;
  logger?: FastifyBaseLogger;
  /** Path signals and projects of the imported sessions (D9 p. 5), when the catalogue is available. */
  projects?: ProjectService;
}): Promise<ImportReport> {
  const out = o.log ?? (() => undefined);
  const folder = o.folder ?? 'vault-sessions';
  const report: ImportReport = {
    folder,
    files: 0,
    driveSessions: 0,
    sessionsNew: 0,
    sessionsExtended: 0,
    linesNew: 0,
    skipped: {},
    unknownHosts: [],
    errors: [],
    hubSessions: 0,
    missingInHub: 0,
    byRunner: {},
  };
  const skip = (reason: string) => (report.skipped[reason] = (report.skipped[reason] ?? 0) + 1);
  const count = (per: ImportReport['byRunner'][string], extended: boolean) => {
    if (extended) {
      report.sessionsExtended++;
      per.sessionsExtended++;
    } else {
      report.sessionsNew++;
      per.sessionsNew++;
    }
  };
  const run = o.dryRun
    ? null
    : await o.db
        .insertInto('import_runs')
        .values({ report: JSON.stringify({ folder, status: 'running' }) })
        .returning('id')
        .executeTakeFirstOrThrow();

  const user = o.userEmail
    ? await o.db.selectFrom('users').select('id').where('email', '=', o.userEmail.toLowerCase()).executeTakeFirst()
    : // design M3: without --user — the administrator (OIDC_ALLOWED_EMAILS), not the earliest user
      await o.db.selectFrom('users').select('id').where('role', '=', 'admin').orderBy('created_at').executeTakeFirst();
  if (!user) throw new Error('no hub user: start the hub once (bootstrap administrator) or pass --user');

  const noop = { get: () => undefined, isOnline: () => false } as unknown as AgentGateway;
  const ui = { sendToSubscribers: () => undefined } as unknown as UiGateway;
  const silent = (o.logger ?? { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined, child: () => silent }) as unknown as FastifyBaseLogger;
  const repl = new Replication({
    db: o.db,
    store: o.store,
    agents: noop,
    ui,
    log: silent,
    hooks: { upsert: async () => undefined, userLines: async () => undefined },
    ...(o.projects ? { projects: o.projects } : {}),
  });

  const listed = await o.client.listFolder(folder);
  if (!listed) throw new Error(`Drive folder «${folder}» not found`);
  // One file per (session, host): the newest wins if Drive holds duplicates of a name.
  const byKey = new Map<string, { file: DriveFile; sid: string; host: string }>();
  for (const f of listed) {
    const m = NAME.exec(f.name);
    if (!m) {
      skip('not_a_session_file');
      continue;
    }
    report.files++;
    const key = `${m[1]!.toLowerCase()}__${m[2]!.toLowerCase()}`;
    const prev = byKey.get(key);
    if (prev && prev.file.modifiedTime >= f.modifiedTime) {
      skip('duplicate_name');
      continue;
    }
    if (prev) skip('duplicate_name');
    byKey.set(key, { file: f, sid: m[1]!.toLowerCase(), host: m[2]! });
  }
  const sids = new Set([...byKey.values()].map(x => x.sid));
  report.driveSessions = sids.size;

  // Requirement: Разделение пространств — hostnames are matched among the runners of this user only (design M3).
  const runners = await o.db.selectFrom('runners').select(['id', 'hostname', 'name']).where('user_id', '=', user.id).execute();
  const runnerOf = async (host: string): Promise<{ id: string; unknown: boolean }> => {
    const known = runners.find(r => r.hostname && r.hostname.toLowerCase() === host.toLowerCase());
    if (known) return { id: known.id, unknown: false };
    if (!report.unknownHosts.includes(host)) report.unknownHosts.push(host);
    const name = unknownRunnerName(host);
    const existing = runners.find(r => r.name === name);
    if (existing) return { id: existing.id, unknown: true };
    // The id of an unknown machine is generated like any new runner (M1), not a global `unknown-<host>`.
    let id = newRunnerId();
    if (!o.dryRun) {
      const r = await o.db
        .insertInto('runners')
        .values({ id, user_id: user.id, name, kind: 'machine' })
        .onConflict(oc => oc.columns(['user_id', 'name']).doUpdateSet({ name }))
        .returning('id')
        .executeTakeFirstOrThrow();
      id = r.id;
    }
    runners.push({ id, hostname: null, name });
    return { id, unknown: true };
  };

  let n = 0;
  for (const { file, sid, host } of byKey.values()) {
    n++;
    try {
      const runner = await runnerOf(host);
      const before = await o.db
        .selectFrom('transcript_files')
        .selectAll()
        .where('runner_id', '=', runner.id)
        .where('claude_session_id', '=', sid)
        .where('kind', '=', 'main')
        .where('superseded_at', 'is', null)
        .executeTakeFirst();
      const existed = await o.db.selectFrom('sessions').select(['id']).where('runner_id', '=', runner.id).where('claude_session_id', '=', sid).executeTakeFirst();
      const acked = before ? Number(before.acked_line) : 0;
      // Known machine without a live copy: drive-import/<sid>.jsonl until the agent's live copy takes it over.
      const relPath = before?.rel_path ?? `${DRIVE_IMPORT_DIR}/${sid}.jsonl`;
      const generation = before?.generation ?? 0;
      let lineNo = 0;
      let batch: Array<{ text: string; end: number }> = [];
      let batchFrom = acked;
      let differs = false;
      const flush = async () => {
        if (!batch.length) return;
        if (!o.dryRun) {
          await repl.onChunk(
            runner.id,
            { relPath, kind: 'main', sessionId: sid, generation, fromLine: batchFrom, fromByte: batchFrom ? lastEndBefore : 0, lines: batch.map(l => l.text), endByte: batch.at(-1)!.end },
            { driveImport: true, ...(runner.unknown ? { readOnly: 'unknown_runner' as const } : {}) },
          );
          const cur = await o.db
            .selectFrom('transcript_files')
            .select('acked_line')
            .where('runner_id', '=', runner.id)
            .where('claude_session_id', '=', sid)
            .where('kind', '=', 'main')
            .where('superseded_at', 'is', null)
            .executeTakeFirst();
          if (!cur || Number(cur.acked_line) !== batchFrom + batch.length) throw new Error(`chunk at line ${batchFrom} was not stored (S3 or a cursor conflict)`);
        }
        lastEndBefore = batch.at(-1)!.end;
        batchFrom += batch.length;
        batch = [];
      };
      let lastEndBefore = 0;
      for await (const line of streamLines(o.client.download(file.id))) {
        lineNo++;
        if (lineNo <= acked) {
          // Lines before the hub's cursor must be the same bytes as the live copy, otherwise the export is another file.
          if (lineNo === acked && line.end !== Number(before!.acked_byte)) {
            differs = true;
            break;
          }
          if (lineNo === acked) lastEndBefore = line.end;
          continue;
        }
        batch.push(line);
        if (batch.length >= CHUNK_LINES) await flush();
      }
      if (differs) {
        skip('differs_from_live');
        continue;
      }
      if (lineNo <= acked) {
        skip(before ? 'already_complete' : 'empty');
        continue;
      }
      await flush();
      report.linesNew += lineNo - acked;
      const per = (report.byRunner[runner.id] ??= { sessionsNew: 0, sessionsExtended: 0, linesNew: 0 });
      per.linesNew += lineNo - acked;
      if (o.dryRun) {
        count(per, !!before);
        continue;
      }
      const s = await o.db.selectFrom('sessions').select(['id']).where('runner_id', '=', runner.id).where('claude_session_id', '=', sid).executeTakeFirst();
      if (!s) {
        skip('no_messages');
        continue;
      }
      // Source and read-only come from D5 in the write path (flag is_drive_import, unknown machine → unknown_runner).
      count(per, !!existed);
      if (n % 50 === 0) out(`… ${n}/${byKey.size}`);
    } catch (err) {
      report.errors.push(`${file.name}: ${(err as Error).message}`);
    }
  }

  // The projects of the imported sessions (scheduled per session while writing).
  await o.projects?.flush();
  if (sids.size) {
    const found = await o.db
      .selectFrom('sessions')
      .select('claude_session_id')
      .distinct()
      .where('claude_session_id', 'in', [...sids])
      .execute();
    report.hubSessions = found.length;
    report.missingInHub = sids.size - found.length;
  }
  if (run)
    await o.db
      .updateTable('import_runs')
      .set({ finished_at: new Date(), report: JSON.stringify(report) })
      .where('id', '=', run.id)
      .execute();
  return report;
}

export function formatReport(r: ImportReport, dryRun = false): string[] {
  const skipped =
    Object.entries(r.skipped)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || '0';
  return [
    `${dryRun ? 'dry run: ' : ''}Drive «${r.folder}»: файлов ${r.files}, сессий ${r.driveSessions}`,
    `новых ${r.sessionsNew}, дополнено ${r.sessionsExtended}, строк ${r.linesNew}; пропущено: ${skipped}; ошибок ${r.errors.length}`,
    ...Object.entries(r.byRunner)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, v]) => `  ${id}: новых ${v.sessionsNew}, дополнено ${v.sessionsExtended}, строк ${v.linesNew}`),
    ...(r.unknownHosts.length ? [`машины неизвестны (только чтение): ${r.unknownHosts.join(', ')}`] : []),
    `сверка: session_id в Drive ${r.driveSessions}, в хабе ${r.hubSessions}, расхождение ${r.missingInHub}`,
    ...r.errors.slice(0, 20).map(e => `ошибка: ${e}`),
  ];
}
