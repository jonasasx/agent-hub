// Hub side of replication (design D4, D5, D7, D8): every .jsonl of every machine. A chunk is written to S3 as a
// raw segment, its stored lines (D4 selection) go to `events` with big payloads moved to `blobs/<sha256>`, the
// cursor advances in the same transaction, then repl.ack. Sessions started outside the hub appear here.
// Requirements: Слежение за .jsonl на машине; Доставка с подтверждением смещения; Хранение событий без больших
// полезных нагрузок; Метаданные сессии из реплики; Восстановление .jsonl из S3 перед resume.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Selectable, type Transaction } from 'kysely';
import { platformOfHome, type AgentMessage, type HubEvent, type PayloadOf, type Provider, type RunnerPlatform } from '@agent-hub/shared';
import type { Database, Db, TranscriptFilesTable } from '../db/db.js';
import type { AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { getRunner, type RunnerRow } from '../runners/repo.js';
import type { ObjectStore } from '../storage/objectStore.js';
import { findSessionByClaudeId, type SessionBase } from '../sessions/repo.js';
import { extractPayloads, searchText } from './extract.js';
import { scanLines } from '../subagents/extract.js';
import { applyFacts, applyHeldMeta, applyMeta as applyAgentMeta, holdAgentMeta, lockRegistry, runOfFile, subagentViews } from '../subagents/repo.js';
import { assemble, mergeSegments, rawLines, RawGapError, rawPrefix, writeSegment } from './raw.js';
import { lineSignals, sessionSource, type SourceSignals } from './source.js';
import { sideFileRefs } from './sideLinks.js';
import { stripUserinfo } from '../projects/catalog.js';
import { lockSessionTouches, runnerPaths, withDbRetry, type ProjectService } from '../projects/service.js';

/** Line types stored in Postgres (D4 «Отбор в Postgres»); the rest is acked and kept in raw S3 only. */
export const STORED_TYPES = new Set(['user', 'assistant', 'system', 'ai-title', 'custom-title', 'permission-mode', 'mode', 'pr-link', 'bridge-session']);

/**
 * A line kept in `events`: a type of STORED_TYPES, or an `attachment` of type `queued_command` — a message delivered
 * mid-turn (from the user, a teammate, a task notification; change `subagents`, design S6). Other attachments (hooks,
 * reminders) are not stored.
 */
export function isStoredLine(obj: Record<string, unknown>): boolean {
  if (STORED_TYPES.has(String(obj.type))) return true;
  // a message delivered mid-turn (change `subagents` S6). Not a task notification: on real transcripts (HP, 511
  // queued_command in 20 days) those repeat a user line or each other (18 of 345), and the registry reads them from
  // the unstored lines anyway; human, peer and coordinator messages are never repeated (review p. 6)
  const a = obj.attachment as { type?: unknown; origin?: { kind?: unknown } } | undefined;
  return obj.type === 'attachment' && a?.type === 'queued_command' && a.origin?.kind !== 'task-notification';
}

/** agent-providers D4: the provider of a transcript by its folder under ~/.claude/projects. */
export function providerOfRelPath(relPath: string): Provider {
  return /^agent-hub-codex[/\\]/i.test(relPath) ? 'codex' : 'claude';
}

/** See SessionService: lines this long after the hub's last knowledge of its process count as an external write. */
export const EXTERNAL_WRITE_MARGIN_MS = 120_000;

/** One-time restore links (D3): lifetime and how many may be held in memory at once. */
export const RESTORE_TTL_MS = 10 * 60_000;
export const RESTORE_LINKS = 20;

type FileRow = Selectable<TranscriptFilesTable>;

/** Removes NUL characters: jsonb cannot store \u0000. */
export function stripNul(v: unknown): unknown {
  if (typeof v === 'string') return v.includes('\u0000') ? v.replaceAll('\u0000', '�') : v;
  if (Array.isArray(v)) return v.map(stripNul);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = stripNul(x);
    return o;
  }
  return v;
}

/** D4: thinking blocks keep no `signature`. */
function dropThinkingSignatures(obj: Record<string, unknown>): void {
  const msg = obj.message as { content?: unknown } | undefined;
  if (!msg || !Array.isArray(msg.content)) return;
  for (const b of msg.content as Array<Record<string, unknown>>) if (b && b.type === 'thinking') delete b.signature;
}

function firstUserText(line: Record<string, unknown>): string | null {
  if (line.type !== 'user' || line.isMeta === true) return null;
  const t = searchText(line);
  return t && !t.startsWith('<') ? t : null;
}

/** Source signals stored on a session row (D5). */
export function rowSignals(
  s: Pick<SessionBase, 'cron_marker' | 'cwd' | 'seen_cli' | 'seen_sdk_cli' | 'seen_human' | 'seen_human_non_cli' | 'source' | 'origin_source' | 'is_drive_import'>,
  platform: RunnerPlatform | null,
): Omit<SourceSignals, 'isHubManaged'> {
  return {
    cronMarker: s.cron_marker,
    cwd: s.cwd,
    seenCli: s.seen_cli,
    seenSdkCli: s.seen_sdk_cli,
    seenHuman: s.seen_human,
    seenHumanNonCli: s.seen_human_non_cli,
    platform,
    driveImport: s.is_drive_import,
  };
}

/** Cron sessions are read-only; a session that stopped being cron gets writable again. */
export function cronReadOnly(source: string, current: SessionBase['read_only_reason']): { read_only_reason?: 'cron' | null } {
  if (source === 'cron' && !current) return { read_only_reason: 'cron' };
  if (source !== 'cron' && current === 'cron') return { read_only_reason: null };
  return {};
}

export function titleFromText(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/** rel_path key: case-insensitive on Windows runners (D4). */
export function relKey(runner: Pick<RunnerRow, 'home_dir'> | undefined, relPath: string): string {
  return platformOfHome(runner?.home_dir) === 'windows' ? relPath.toLowerCase() : relPath;
}

export interface ReplicationHooks {
  /** Re-reads the session and broadcasts session.upsert. */
  upsert(id: string): Promise<unknown>;
  /** Uuids of user lines of the main transcript the hub stored for the first time (delivery confirmation, D10). */
  userLines?(sessionId: string, uuids: string[]): Promise<void>;
}

export interface ReplicationOptions {
  db: Db;
  store: ObjectStore;
  agents: AgentGateway;
  ui: UiGateway;
  log: FastifyBaseLogger;
  hooks: ReplicationHooks;
  now?: () => Date;
  /** Path signals and project decisions (D9, M4); absent — no classification. */
  projects?: ProjectService;
}

interface RestoreTicket {
  runnerId: string;
  content: Buffer;
  expires: number;
}

/** Key prefix of transcripts imported from Drive with no live copy yet (import:drive, D16). */
export const DRIVE_IMPORT_DIR = 'drive-import';

/** A session written outside the hub within this window is «running outside the hub» (SessionView.externalActive). */
export const EXTERNAL_ACTIVE_MS = 3 * 60_000;
/**
 * An external line is activity only when the hub receives it within this delay of its own timestamp, corrected by the
 * offset of the runner's clock measured at hello (D9 p. 10b); later lines are history (first replication, backlog).
 */
export const EXTERNAL_LIVE_MS = 2 * 60_000;

export class Replication {
  /** Latest repl.files list per runner (relKey → size), complete after `final`. */
  private readonly machineFiles = new Map<string, Map<string, number>>();
  private readonly filesPaging = new Map<string, Map<string, number>>();
  /** repl.meta that arrived before the session row exists. */
  /** Last session.upsert sent for children's activity alone, per session (the UI sleep countdown follows it). */
  private readonly activityUpsertAt = new Map<string, number>();
  private readonly pendingMeta = new Map<string, { meta: PayloadOf<AgentMessage, 'repl.meta'>; at: number }>();
  private readonly restores = new Map<string, RestoreTicket>();
  private restoreTimer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly o: ReplicationOptions) {
    this.now = o.now ?? (() => new Date());
  }

  // ---------- repl.files ----------

  onFiles(runnerId: string, p: PayloadOf<AgentMessage, 'repl.files'>): void {
    const acc = this.filesPaging.get(runnerId) ?? new Map<string, number>();
    this.filesPaging.set(runnerId, acc);
    for (const f of p.files) acc.set(f.relPath, f.size);
    if (!p.final) return;
    this.filesPaging.delete(runnerId);
    void getRunner(this.o.db, runnerId)
      .then(async runner => {
        const keyed = new Map<string, number>();
        for (const [rel, size] of acc) keyed.set(relKey(runner, rel), size);
        this.machineFiles.set(runnerId, keyed);
        const known = await this.o.db.selectFrom('transcript_files').select(['rel_key']).where('runner_id', '=', runnerId).execute();
        const missing = known.filter(k => !keyed.has(k.rel_key)).length;
        this.o.log.info({ runnerId, onMachine: keyed.size, known: known.length, missingOnMachine: missing }, 'transcript list received');
      })
      .catch((err: unknown) => this.o.log.warn({ err, runnerId }, 'transcript list not processed'));
  }

  /** The list of the runner says the file is not on the machine (only after a complete repl.files). */
  missingOnMachine(runnerId: string, key: string): boolean {
    const files = this.machineFiles.get(runnerId);
    return files ? !files.has(key) : false;
  }

  /**
   * Replication lag per runner (`/metrics`, task 3.10): bytes of the machine's transcripts (the last complete repl.files
   * list) beyond what the hub acked, and how many files have such bytes. Runners without a list are absent.
   */
  async lag(): Promise<Array<{ runnerId: string; bytes: number; files: number }>> {
    const out: Array<{ runnerId: string; bytes: number; files: number }> = [];
    for (const [runnerId, files] of this.machineFiles) {
      const rows = await this.o.db.selectFrom('transcript_files').select(['rel_key', 'acked_byte']).where('runner_id', '=', runnerId).execute();
      const acked = new Map(rows.map(r => [r.rel_key, Number(r.acked_byte)]));
      let bytes = 0;
      let n = 0;
      for (const [key, size] of files) {
        const d = size - (acked.get(key) ?? 0);
        if (d > 0) {
          bytes += d;
          n++;
        }
      }
      out.push({ runnerId, bytes, files: n });
    }
    return out.sort((a, b) => a.runnerId.localeCompare(b.runnerId));
  }

  markPresent(runnerId: string, key: string): void {
    this.machineFiles.get(runnerId)?.set(key, 0);
  }

  forgetRunner(runnerId: string): void {
    this.filesPaging.delete(runnerId);
  }

  // ---------- side files ----------

  /** tool-results/* of a session → S3 side/<runner>/<session>/tool-results/<name> (D7), checked by sha256. */
  async onSide(runnerId: string, meta: PayloadOf<AgentMessage, 'side.file'>, data: Buffer): Promise<void> {
    const reject = (reason: 'bad_name' | 'sha_mismatch') => {
      this.o.log.warn({ runnerId, relPath: meta.relPath, reason }, 'side file refused');
      this.o.agents.get(runnerId)?.send('side.reject', { sessionId: meta.sessionId, relPath: meta.relPath, sha256: meta.sha256, reason });
    };
    if (createHash('sha256').update(data).digest('hex') !== meta.sha256 || data.length !== meta.size) return reject('sha_mismatch');
    const name = meta.relPath.replaceAll('\\', '/');
    if (!/^tool-results\/[^/]+$/.test(name) || name.includes('..')) return reject('bad_name');
    await this.o.store.put(`side/${runnerId}/${meta.sessionId}/${name}`, data);
    // The agent marks the file sent only on this ack; without it the file is offered again on the next walk.
    this.o.agents.get(runnerId)?.send('side.ack', { sessionId: meta.sessionId, relPath: meta.relPath, sha256: meta.sha256 });
  }

  // ---------- repl.meta ----------

  async onMeta(runnerId: string, p: PayloadOf<AgentMessage, 'repl.meta'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!s) {
      // Kept until the session row appears; bounded: 10 min, 2000 entries (a file of service lines only never makes one).
      const now = Date.now();
      for (const [k, v] of this.pendingMeta) if (now - v.at > 10 * 60_000) this.pendingMeta.delete(k);
      if (this.pendingMeta.size >= 2000) this.pendingMeta.delete(this.pendingMeta.keys().next().value!);
      this.pendingMeta.set(`${runnerId}:${p.sessionId}`, { meta: p, at: now });
      return;
    }
    await this.applyMeta(s, p);
  }

  private async applyMeta(s: SessionBase, p: PayloadOf<AgentMessage, 'repl.meta'>): Promise<void> {
    const cron = p.cronMarker === true;
    const next = {
      // Credentials never stored (an agent before M4 sends remote.origin.url as it is, D9 p. 7).
      ...(p.gitRemote ? { git_remote: stripUserinfo(p.gitRemote) } : {}),
      ...(p.gitBranch ? { git_branch: p.gitBranch } : {}),
      ...(!s.cwd && p.cwd ? { cwd: p.cwd } : {}),
      ...(cron ? { cron_marker: true } : {}),
    };
    if (!Object.keys(next).length) return;
    const merged = { ...s, ...next };
    const runner = await getRunner(this.o.db, s.runner_id);
    const signals = rowSignals(merged, platformOfHome(runner?.home_dir));
    const source = sessionSource({ ...signals, isHubManaged: merged.is_hub_managed });
    const origin = s.origin_source === 'hub' ? 'hub' : sessionSource({ ...signals, isHubManaged: false });
    await this.o.db
      .updateTable('sessions')
      .set({ ...next, source, origin_source: origin, ...cronReadOnly(source, s.read_only_reason) })
      .where('id', '=', s.id)
      .execute();
    await this.o.hooks.upsert(s.id);
    // cwd and remote are start signals: the decision may change.
    this.o.projects?.schedule(s.id);
  }

  // ---------- repl.agent_meta (1.3) ----------

  /**
   * `subagents/agent-<agentId>.meta.json` (change `subagents`, design S5): the registry row of the agent gets its type,
   * description, parent, teammate kind and the link to its call (toolUseId) before the call returns. A session not
   * known yet: dropped (the agent sends the file again after a reconnect).
   */
  async onAgentMeta(runnerId: string, p: PayloadOf<AgentMessage, 'repl.agent_meta'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    // Not known yet (its first chunk is still in the backlog): kept and applied when the session row appears.
    if (!s) return void (await holdAgentMeta(this.o.db, runnerId, p.sessionId, p.agentId.replace(/^agent-/, ''), p.meta));
    const changed = await withDbRetry(() => this.o.db.transaction().execute(tx => applyAgentMeta(tx, { userId: s.user_id, sessionId: s.id }, p.agentId.replace(/^agent-/, ''), p.meta)));
    for (const v of await subagentViews(this.o.db, [...changed])) this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'subagent.upsert', sessionId: s.id, subagent: v });
    // meta.json may end a subagent (finished): the parent's counters and sleep change
    if (changed.size) await this.o.hooks.upsert(s.id);
  }

  // ---------- repl.chunk ----------

  /**
   * `o.driveImport` (import:drive, D16): a session created by this chunk is flagged as imported and, on an unknown
   * machine, read-only (`unknown_runner`); its source is still computed by D5.
   */
  async onChunk(runnerId: string, p: PayloadOf<AgentMessage, 'repl.chunk'>, o: { driveImport?: boolean; readOnly?: 'unknown_runner' } = {}): Promise<void> {
    const conn = this.o.agents.get(runnerId);
    const ack = (generation: number, ackedLine: number, ackedByte: number) => conn?.send('repl.ack', { relPath: p.relPath, generation, ackedLine, ackedByte });
    const runner = await getRunner(this.o.db, runnerId);
    if (!runner) return;
    const key = relKey(runner, p.relPath);
    let before = await this.o.db.selectFrom('transcript_files').selectAll().where('runner_id', '=', runnerId).where('rel_key', '=', key).executeTakeFirst();
    // A new main transcript key: decided under a lock of (runner, session) shared by the live path and import:drive
    // (another process), so a session never gets two main transcripts (review M3c).
    if (!before && p.kind === 'main') {
      const claimed = await this.claimMainKey(runner, p, key, o);
      if (claimed === 'resend') return void ack(p.generation, 0, 0);
      before = claimed;
    }

    // Cursor position this chunk is applied against (a rewrite or a newer generation starts from 0).
    const gen = before?.generation ?? 0;
    if (before && p.generation < gen) return void ack(gen, Number(before.acked_line), Number(before.acked_byte));
    const newGen = !before ? p.generation !== 0 || !!p.rewrite : p.generation > gen || !!p.rewrite;
    const acked = before && !newGen ? Number(before.acked_line) : 0;
    if (p.fromLine > acked) return void ack(before && !newGen ? gen : p.generation, acked, before && !newGen ? Number(before.acked_byte) : 0);
    if (p.fromLine + p.lines.length <= acked && !newGen) return void ack(gen, acked, Number(before!.acked_byte));
    const skip = acked - p.fromLine; // lines already stored
    const fresh = p.lines.slice(skip);
    const fromLine = p.fromLine + skip;

    // Parse, find the stored lines and what they say about the session.
    const parsed: Array<{ lineNo: number; obj: Record<string, unknown> | null }> = fresh.map((l, i) => {
      try {
        const v = JSON.parse(l) as unknown;
        return { lineNo: fromLine + i, obj: v && typeof v === 'object' && !Array.isArray(v) ? (stripNul(v) as Record<string, unknown>) : null };
      } catch {
        return { lineNo: fromLine + i, obj: null };
      }
    });
    const stored = parsed.filter(x => x.obj && isStoredLine(x.obj));
    let session = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!session && stored.length) session = await this.createSession(runner, p, parsed, o);

    // Keyed by rel_key: stable when the name on disk changes case (D4).
    const prefix = rawPrefix(runnerId, p.sessionId, key, p.generation);

    // Big payloads: each blob is uploaded before the event that references it is acked. A failed upload keeps the
    // event (with its $blob reference) but holds the cursor, so the agent re-sends and the upload is retried.
    const rows: Array<{ lineNo: number; obj: Record<string, unknown>; ts: Date; type: string }> = [];
    let prevTs: Date | null = session?.last_event_at ?? null;
    const blobRows: Array<{ sha256: string; s3_key: string; size: number; mime: string; width: number | null; height: number | null }> = [];
    let s3Ok = true;
    /** Blobs in S3 referenced by this chunk: readable by the session's user (GET /api/blobs, D19). */
    const ownedShas = new Set<string>();
    for (const x of parsed) {
      const obj = x.obj;
      const ts = obj && typeof obj.timestamp === 'string' && !Number.isNaN(Date.parse(obj.timestamp)) ? new Date(obj.timestamp) : (prevTs ?? this.now());
      prevTs = ts;
      if (!obj || !session || !isStoredLine(obj)) continue;
      if (obj.type === 'assistant') dropThinkingSignatures(obj);
      const ex = extractPayloads(obj);
      const up = await this.storeBlobs(ex.blobs);
      if (up.failed) s3Ok = false;
      for (const sha of up.present) ownedShas.add(sha);
      for (const b of ex.blobs) {
        if (up.ok.has(b.sha256)) blobRows.push({ sha256: b.sha256, s3_key: `blobs/${b.sha256}`, size: b.bytes.length, mime: b.mime, width: b.width, height: b.height });
      }
      rows.push({ lineNo: x.lineNo, obj: ex.line, ts, type: String(obj.type) });
    }

    // 1) Events first (design D4 «Порядок записи»): the chat does not depend on S3. ON CONFLICT drops lines a
    //    re-sent chunk already stored, so subscribers get each event once.
    const sessionId = session?.id ?? null;
    const inserted: HubEvent[] = [];
    // Timestamps of the lines stored by this chunk, main and subagent (external writes, QA M4a: a session whose
    // subagents write while the main transcript is quiet is running outside the hub too).
    const storedTs: number[] = [];
    // Change `subagents`: the items of a subagent's transcript (subagent.events) and the registry rows changed.
    const subInserted: HubEvent[] = [];
    let changedRuns = new Set<string>();
    let childActivity = false;
    let bgChanged = false;
    let okLines = new Set<string>();
    // A deadlock (40P01) or a serialization failure: the whole transaction again; what it collected is reset first.
    const applied = await withDbRetry(() =>
      this.o.db.transaction().execute(async tx => {
        inserted.length = 0;
        storedTs.length = 0;
        subInserted.length = 0;
        changedRuns = new Set<string>();
        childActivity = false;
        bgChanged = false;
        okLines = new Set<string>();
        // The touch lock of the session first (review M4a p. 7: projects:reclassify in another process, refreshStart):
        // before the FOR UPDATE of the file row, which refreshStart's insert waits for (KEY SHARE) while holding this lock.
        if (this.o.projects && sessionId) await lockSessionTouches(tx, sessionId);
        // Then the registry lock of the subagents (review `subagents` p. 1): also before the FOR UPDATE of the file row —
        // repl.agent_meta and subagents:backfill hold it while they link rows to transcript files (KEY SHARE).
        if (sessionId) await lockRegistry(tx, sessionId);
        // Rows in sha order: two chunks with the same blobs lock them in the same order (no deadlock).
        if (blobRows.length)
          await tx
            .insertInto('blobs')
            .values([...blobRows].sort((x, y) => (x.sha256 < y.sha256 ? -1 : x.sha256 > y.sha256 ? 1 : 0)))
            .onConflict(oc => oc.column('sha256').doNothing())
            .execute();
        if (ownedShas.size) {
          await tx
            .insertInto('blob_owners')
            .values([...ownedShas].sort().map(sha256 => ({ sha256, user_id: runner.user_id })))
            .onConflict(oc => oc.columns(['sha256', 'user_id']).doNothing())
            .execute();
        }
        let file: FileRow | undefined = await tx.selectFrom('transcript_files').selectAll().where('runner_id', '=', runnerId).where('rel_key', '=', key).forUpdate().executeTakeFirst();
        let oldGeneration: number | null = null;
        if (!file) {
          file = await tx
            .insertInto('transcript_files')
            .values({
              user_id: runner.user_id,
              session_id: sessionId,
              runner_id: runnerId,
              claude_session_id: p.sessionId,
              rel_path: p.relPath,
              rel_key: key,
              kind: p.kind,
              agent_id: p.agentId ?? null,
              generation: p.generation,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        } else if (p.generation > file.generation || p.rewrite) {
          oldGeneration = p.generation > file.generation ? file.generation : null;
          await tx.deleteFrom('events').where('file_id', '=', file.id).where('generation', '<', p.generation).execute();
          file = await tx
            .updateTable('transcript_files')
            .set({ generation: p.generation, acked_line: '0', acked_byte: '0', raw_segments: 0 })
            .where('id', '=', file.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        if (Number(file.acked_line) !== acked) return { file, stale: true, oldGeneration };
        if (rows.length && sessionId) {
          const ins = await tx
            .insertInto('events')
            .values(
              rows.map(r => ({
                file_id: file.id,
                generation: file.generation,
                line_no: r.lineNo,
                session_id: sessionId,
                uuid: typeof r.obj.uuid === 'string' ? r.obj.uuid : null,
                parent_uuid: typeof r.obj.parentUuid === 'string' ? r.obj.parentUuid : null,
                type: r.type,
                subtype: typeof r.obj.subtype === 'string' ? r.obj.subtype : null,
                ts: r.ts,
                is_sidechain: r.obj.isSidechain === true,
                payload: JSON.stringify(r.obj),
                search_text: searchText(r.obj),
              })),
            )
            .onConflict(oc => oc.columns(['file_id', 'generation', 'line_no']).doNothing())
            .returning(['line_no'])
            .execute();
          const ok = new Set(ins.map(r => String(r.line_no)));
          for (const r of rows) if (ok.has(String(r.lineNo))) storedTs.push(r.ts.getTime());
          // Path signals of the stored lines (D9 p. 5), in the same transaction: a re-sent chunk adds none.
          if (this.o.projects && session) {
            const fresh = rows.filter(r => ok.has(String(r.lineNo)));
            const touches = this.o.projects.touchesFor(session, runnerPaths(runner), file.id, fresh);
            if (touches.length) await this.o.projects.insertTouches(tx, touches);
          }
          for (const r of rows) {
            if (!ok.has(String(r.lineNo))) continue;
            const sideFiles = sessionId ? sideFileRefs(sessionId, r.obj) : undefined;
            const item: HubEvent = { kind: 'line', id: `l:${file.id}:${file.generation}:${r.lineNo}`, ts: r.ts.toISOString(), line: r.obj, ...(sideFiles ? { sideFiles } : {}) };
            (p.kind === 'main' ? inserted : subInserted).push(item);
          }
          okLines = ok;
        }
        // Subagents (change `subagents`, design S2): facts of the lines as they came (before big fields moved to S3);
        // a stored line counts once (a re-sent chunk adds nothing), lines the hub does not store (hooks, the queue) are
        // past the cursor already. A file without a session gives no facts.
        if (sessionId) {
          const scan = parsed.filter(x => x.obj && (!isStoredLine(x.obj) || okLines.has(String(x.lineNo))));
          const facts = scanLines({ kind: p.kind, agentIdOfFile: p.kind === 'subagent' ? agentIdOf(p) : null }, scan);
          if (facts.length) changedRuns = await applyFacts(tx, { userId: runner.user_id, sessionId, fileId: file.id }, facts);
          // an event of a monitor moves the sleep like activity of a subagent (change `background-tasks` D3)
          childActivity = facts.some(f => f.t === 'activity' || f.t === 'bgevent');
          // a background command or a monitor started or ended (a notification may also end a subagent: that one is in changedRuns)
          bgChanged = facts.some(f => f.t === 'bgstart' || f.t === 'notify' || f.t === 'bgstop' || f.t === 'bgexpire');
        }
        await tx
          .updateTable('transcript_files')
          .set({
            // The name on disk wins (an M2 cursor C--… moves to c--… once the agent reports the real name, D4).
            rel_path: p.relPath,
            ...(sessionId && !file.session_id ? { session_id: sessionId } : {}),
          })
          .where('id', '=', file.id)
          .execute();
        return { file, stale: false, oldGeneration };
      }),
    );
    if (applied.stale) return void ack(applied.file.generation, Number(applied.file.acked_line), Number(applied.file.acked_byte));
    if (session) await this.updateSession(session, p, parsed, inserted, storedTs);
    if (session) await this.sendSubagents(session, applied.file.id, changedRuns, subInserted);
    // The parent's session.upsert (SessionView.subagents.working, sleepsAt): a subagent changed state — sendSubagents
    // above; a background command started or ended — right away; only activity of a subagent (its sleep moves) — at
    // most once a minute per session, the countdown is in minutes.
    if (session && bgChanged && !changedRuns.size) {
      this.activityUpsertAt.set(session.id, Date.now());
      await this.o.hooks.upsert(session.id);
    } else if (session && childActivity && !changedRuns.size) {
      const now = Date.now();
      if (now - (this.activityUpsertAt.get(session.id) ?? 0) >= 60_000) {
        // entries older than the throttle window are of no use: dropped here, so the map holds only sessions with
        // children active within the last minute (a stopped or sleeping session falls out by itself)
        for (const [k, at] of this.activityUpsertAt) if (now - at >= 60_000) this.activityUpsertAt.delete(k);
        this.activityUpsertAt.set(session.id, now);
        await this.o.hooks.upsert(session.id);
      }
    }
    if (session && this.o.projects && rows.length) this.o.projects.schedule(session.id);
    if (applied.oldGeneration !== null) void this.dropGeneration(runnerId, p.sessionId, key, applied.oldGeneration);

    // 2) Raw segment, 3) cursor and ack — only when S3 has everything: otherwise the agent re-sends the chunk later.
    if (fresh.length) {
      try {
        await writeSegment(this.o.store, prefix, fromLine, fresh);
      } catch (err) {
        s3Ok = false;
        this.o.log.warn({ err: (err as Error).message, runnerId, relPath: p.relPath }, 'raw segment not written, chunk not acked');
      }
    }
    if (!s3Ok) return;
    const line = fromLine + fresh.length;
    const moved = await this.o.db
      .updateTable('transcript_files')
      .set({
        acked_line: String(line),
        acked_byte: String(p.endByte),
        size: String(p.endByte),
        updated_at: sql`now()`,
        raw_segments: sql`raw_segments + ${fresh.length ? 1 : 0}`,
      })
      .where('id', '=', applied.file.id)
      .where('generation', '=', applied.file.generation)
      .where('acked_line', '=', String(acked))
      .executeTakeFirst();
    if (Number(moved.numUpdatedRows) !== 1) return;
    ack(applied.file.generation, line, p.endByte);
  }

  /**
   * The row of a new main transcript key (review M3c). Slow work goes before the lock: the import is compared with the
   * live chunk (S3, only the segments of the overlapping lines) and, when they match, its raw segments are copied to
   * the live key (idempotent). Under `pg_advisory_xact_lock(runner, session)` — shared by the live path and
   * import:drive in another process — only the rows are re-read and changed:
   * - the key appeared meanwhile — that row;
   * - import:drive while the session already has a main transcript — an error (the run reports it);
   * - the live copy of a session imported under drive-import/<sid>.jsonl — same lines: the import row moves to the
   *   live key (conditional UPDATE on the compared state); other lines, or a raw copy with a gap: the import is marked
   *   superseded (kept, hidden) and the live file starts its own row from line 0;
   * - otherwise a fresh row (acked 0), so a concurrent chunk of the same session finds it.
   * 'resend': the chunk does not start at line 0 or the import changed meanwhile — the agent sends from 0 again.
   * Copies go only into names that are not there; old objects are removed after the commit (see step 3).
   */
  private async claimMainKey(runner: RunnerRow, p: PayloadOf<AgentMessage, 'repl.chunk'>, key: string, o: { driveImport?: boolean }): Promise<FileRow | 'resend'> {
    const mainOf = (db: Db | Transaction<Database>) =>
      db
        .selectFrom('transcript_files')
        .selectAll()
        .where('runner_id', '=', runner.id)
        .where('claude_session_id', '=', p.sessionId)
        .where('kind', '=', 'main')
        .where('superseded_at', 'is', null)
        .executeTakeFirst();
    const isImport = (f: FileRow | undefined): boolean => !!f && f.rel_key.startsWith(`${DRIVE_IMPORT_DIR}/`);

    // 1) Before the lock: compare and copy.
    const seen = await mainOf(this.o.db);
    if (seen && o.driveImport) throw new Error(`the session already has a main transcript ${seen.rel_path}`);
    let verdict: 'none' | 'same' | 'other' = 'none';
    const copied: string[] = [];
    const oldKeys: string[] = [];
    if (seen && isImport(seen)) {
      if (p.fromLine !== 0) return 'resend';
      verdict = (await this.sameAsImport(runner, p, seen)) ? 'same' : 'other';
      if (verdict === 'same') {
        const from = rawPrefix(runner.id, p.sessionId, seen.rel_key, seen.generation);
        const to = rawPrefix(runner.id, p.sessionId, key, seen.generation);
        // Only into names that are not there: a live segment (or a copy of an earlier attempt) is never overwritten.
        const present = new Set(await this.o.store.list(to));
        for (const k of await this.o.store.list(from)) {
          oldKeys.push(k);
          const target = to + k.slice(from.length);
          if (present.has(target)) continue;
          const body = await this.o.store.get(k);
          if (!body) continue;
          await this.o.store.put(target, body);
          copied.push(target);
        }
      }
    }

    // 2) Under the lock: rows only.
    let outcome: 'same' | 'moved' | 'fresh' | 'resend' = 'resend';
    const tx0 = this.o.db.transaction().execute(async (tx): Promise<FileRow | 'resend'> => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${runner.id}), hashtext(${p.sessionId}))`.execute(tx);
      const same = await tx.selectFrom('transcript_files').selectAll().where('runner_id', '=', runner.id).where('rel_key', '=', key).executeTakeFirst();
      if (same) {
        outcome = 'same';
        return same;
      }
      const other = await mainOf(tx);
      if (other && o.driveImport) throw new Error(`the session already has a main transcript ${other.rel_path}`);
      if (other && isImport(other)) {
        // Compared with another state (an import chunk landed meanwhile, or no comparison at all): compare again.
        if (!seen || other.id !== seen.id || other.acked_line !== seen.acked_line || other.generation !== seen.generation || verdict === 'none') return 'resend';
        if (verdict === 'same') {
          const r = await tx
            .updateTable('transcript_files')
            .set({ rel_path: p.relPath, rel_key: key, updated_at: sql`now()` })
            .where('id', '=', other.id)
            .where('rel_key', '=', other.rel_key)
            .where('acked_line', '=', other.acked_line)
            .returningAll()
            .executeTakeFirst();
          if (!r) return 'resend';
          outcome = 'moved';
          return r;
        }
        await tx
          .updateTable('transcript_files')
          .set({ superseded_at: sql`now()` })
          .where('id', '=', other.id)
          .where('superseded_at', 'is', null)
          .execute();
        this.o.log.warn({ runnerId: runner.id, claudeSessionId: p.sessionId, relPath: p.relPath }, 'live file differs from the Drive import: the import is superseded');
      } else if (other) {
        this.o.log.warn({ runnerId: runner.id, claudeSessionId: p.sessionId, relPath: p.relPath, existing: other.rel_path }, 'a second main transcript key of the session');
      }
      outcome = 'fresh';
      return tx
        .insertInto('transcript_files')
        .values({
          user_id: runner.user_id,
          session_id: other?.session_id ?? null,
          runner_id: runner.id,
          claude_session_id: p.sessionId,
          rel_path: p.relPath,
          rel_key: key,
          kind: 'main',
          agent_id: null,
          generation: p.generation,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    const dropKeys = async (keys: string[]) => {
      if (keys.length) await this.o.store.delete(keys).catch((err: unknown) => this.o.log.warn({ err: (err as Error).message }, 'raw objects not removed'));
    };
    let row: FileRow | 'resend';
    try {
      row = await tx0;
    } catch (err) {
      await dropKeys(copied); // our copies of this attempt; nothing else of the live key is touched
      throw err;
    }
    // 3) After the commit. (`outcome` is set inside the transaction callback: TS cannot see it.)
    const done = outcome as 'same' | 'moved' | 'fresh' | 'resend';
    // moved: the import's old objects; same: the key belongs to a row already — nothing is removed; resend: our copies
    // of this attempt; fresh: the new key has no segments of its own yet, so whatever is under it is left over from
    // copies of an attempt whose transaction failed — removed before the first segment of the live file is written.
    if (done === 'moved') await dropKeys(oldKeys);
    else if (done === 'resend') await dropKeys(copied);
    else if (done === 'fresh') await dropKeys(await this.o.store.list(rawPrefix(runner.id, p.sessionId, key, p.generation)));
    if (done === 'moved' && row !== 'resend') this.o.log.info({ runnerId: runner.id, claudeSessionId: p.sessionId, lines: Number(row.acked_line) }, 'live copy continues the Drive import');
    return row;
  }

  /**
   * The live chunk (from line 0) and the import are the same file: every overlapping line is equal and the byte length
   * agrees — the import's part is `acked_byte` long. Only the segments of the first min(chunk, acked) lines are read
   * (one at a time). A raw copy with a gap cannot be compared: «other» (superseded, the live file from 0), not a retry.
   */
  private async sameAsImport(runner: RunnerRow, p: PayloadOf<AgentMessage, 'repl.chunk'>, imported: FileRow): Promise<boolean> {
    const acked = Number(imported.acked_line);
    if (!acked) return true;
    const overlap = Math.min(p.lines.length, acked);
    let i = 0;
    let bytes = 0;
    try {
      for await (const l of rawLines(this.o.store, rawPrefix(runner.id, p.sessionId, imported.rel_key, imported.generation), overlap)) {
        if (l !== p.lines[i]) return false;
        bytes += Buffer.byteLength(l, 'utf8') + 1;
        i++;
      }
    } catch (err) {
      if (err instanceof RawGapError) {
        this.o.log.warn({ runnerId: runner.id, claudeSessionId: p.sessionId, err: err.message }, 'Drive import raw copy has a gap: treated as another file');
        return false;
      }
      throw err;
    }
    if (i < overlap) return false;
    // \r before \n is not in the lines: a CRLF file differs here and counts as another file (the safe side).
    if (p.lines.length < acked) return p.endByte === bytes;
    const live = p.lines.slice(0, acked).reduce((a, l) => a + Buffer.byteLength(l, 'utf8') + 1, 0);
    return live === Number(imported.acked_byte) && bytes === Number(imported.acked_byte);
  }

  /** Raw objects of a replaced generation are useless (design D4): removed best effort after a rewrite. */
  private async dropGeneration(runnerId: string, claudeSessionId: string, key: string, generation: number): Promise<void> {
    try {
      const prefix = rawPrefix(runnerId, claudeSessionId, key, generation);
      await this.o.store.delete(await this.o.store.list(prefix));
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message, runnerId, generation }, 'old raw generation not removed');
    }
  }

  /** Uploads blobs not yet stored; failures are reported, not thrown. */
  private async storeBlobs(blobs: ReturnType<typeof extractPayloads>['blobs']): Promise<{ ok: Set<string>; present: Set<string>; failed: boolean }> {
    const ok = new Set<string>();
    if (!blobs.length) return { ok, present: new Set(), failed: false };
    const have = new Set(
      (
        await this.o.db
          .selectFrom('blobs')
          .select('sha256')
          .where(
            'sha256',
            'in',
            blobs.map(b => b.sha256),
          )
          .execute()
      ).map(r => r.sha256),
    );
    let failed = false;
    for (const b of blobs) {
      if (have.has(b.sha256)) continue;
      try {
        await this.o.store.put(`blobs/${b.sha256}`, b.bytes, b.mime);
        ok.add(b.sha256);
      } catch (err) {
        failed = true;
        this.o.log.warn({ err: (err as Error).message, sha256: b.sha256 }, 'blob not stored, chunk not acked');
      }
    }
    return { ok, present: new Set([...have, ...ok]), failed };
  }

  /** A session seen first by replication (terminal, Orca, desktop, cron): status closed, source by D5. */
  private async createSession(
    runner: RunnerRow,
    p: PayloadOf<AgentMessage, 'repl.chunk'>,
    parsed: Array<{ obj: Record<string, unknown> | null }>,
    o: { driveImport?: boolean; readOnly?: 'unknown_runner' } = {},
  ): Promise<SessionBase> {
    const objs = parsed.map(x => x.obj).filter((o): o is Record<string, unknown> => !!o);
    const cwd = objs.map(o => o.cwd).find((c): c is string => typeof c === 'string') ?? null;
    const id = randomUUID();
    await this.o.db
      .insertInto('sessions')
      .values({
        id,
        user_id: runner.user_id,
        runner_id: runner.id,
        claude_session_id: p.sessionId,
        cwd,
        source: 'terminal',
        status: 'closed',
        title: '',
        title_source: 'none',
        // agent-providers D4: the mirrors of Codex live in their own folder; a mirror seen first by replication (a
        // fork's copy) is a Codex session
        ...(providerOfRelPath(p.relPath) !== 'claude' ? { provider: providerOfRelPath(p.relPath) } : {}),
        ...(o.driveImport ? { is_drive_import: true } : {}),
        ...(o.readOnly ? { read_only_reason: o.readOnly } : {}),
      })
      .onConflict(oc => oc.columns(['runner_id', 'claude_session_id']).doNothing())
      .execute();
    // Files of this session that came before it (service lines only) belong to it now.
    await this.o.db
      .updateTable('transcript_files')
      .set({ session_id: sql`(SELECT id FROM sessions WHERE runner_id = ${runner.id} AND claude_session_id = ${p.sessionId})` })
      .where('runner_id', '=', runner.id)
      .where('claude_session_id', '=', p.sessionId)
      .where('session_id', 'is', null)
      .execute();
    const s = (await findSessionByClaudeId(this.o.db, runner.id, p.sessionId))!;
    const meta = this.pendingMeta.get(`${runner.id}:${p.sessionId}`);
    if (meta) {
      this.pendingMeta.delete(`${runner.id}:${p.sessionId}`);
      await this.applyMeta(s, meta.meta);
    }
    // meta.json of its subagents that came before the session (QA subagents)
    await withDbRetry(() => this.o.db.transaction().execute(tx => applyHeldMeta(tx, { userId: s.user_id, sessionId: s.id, runnerId: runner.id, claudeSessionId: p.sessionId })));
    return (await findSessionByClaudeId(this.o.db, runner.id, p.sessionId))!;
  }

  /**
   * After the commit (change `subagents`, design S8): changed registry rows to the windows of the parent session,
   * new items of a subagent's transcript to the windows where its chat is open.
   */
  private async sendSubagents(s: SessionBase, fileId: string, changed: Set<string>, items: HubEvent[]): Promise<void> {
    if (changed.size) {
      for (const v of await subagentViews(this.o.db, [...changed])) this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'subagent.upsert', sessionId: s.id, subagent: v });
      // the counter «Субагенты N · M работают» is in SessionView
      await this.o.hooks.upsert(s.id);
    }
    if (items.length) {
      const run = await runOfFile(this.o.db, fileId);
      if (run) this.o.ui.sendToSubscribers(s.user_id, run.id, { type: 'subagent.events', subagentId: run.id, events: items });
    }
  }

  private async updateSession(
    s0: SessionBase,
    p: PayloadOf<AgentMessage, 'repl.chunk'>,
    parsed: Array<{ obj: Record<string, unknown> | null }>,
    inserted: HubEvent[],
    storedTs: number[] = [],
  ): Promise<void> {
    const s = (await findSessionByClaudeId(this.o.db, s0.runner_id, s0.claude_session_id)) ?? s0;
    let cli = s.seen_cli;
    let sdk = s.seen_sdk_cli;
    let human = s.seen_human;
    let humanNonCli = s.seen_human_non_cli;
    let rc = s.remote_control;
    let title: { text: string; source: 'custom' | 'ai' | 'prompt' } | null = null;
    let cwd: string | null = null;
    let branch: string | null = null;
    let lastTs: number | null = null;
    let firstTs: number | null = null;
    for (const x of parsed) {
      const o = x.obj;
      if (!o) continue;
      if (p.kind === 'main') {
        // Source signals: main transcript only (subagent lines are sdk-cli/turnOrigin=sdk for any session, D5).
        const sig = lineSignals(o);
        cli ||= sig.cli;
        sdk ||= sig.sdkCli;
        human ||= sig.human;
        humanNonCli ||= sig.humanNonCli;
        rc ||= sig.remoteControl;
        if (o.type === 'custom-title' && typeof o.customTitle === 'string') title = { text: o.customTitle, source: 'custom' };
        else if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && title?.source !== 'custom' && s.title_source !== 'custom') title = { text: o.aiTitle, source: 'ai' };
        else if (!title && s.title_source === 'none') {
          const t = firstUserText(o);
          if (t) title = { text: titleFromText(t), source: 'prompt' };
        }
        if (typeof o.cwd === 'string') cwd = o.cwd;
        if (typeof o.gitBranch === 'string' && o.gitBranch) branch = o.gitBranch;
      }
      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
      if (!Number.isNaN(ts) && STORED_TYPES.has(String(o.type))) {
        lastTs = Math.max(lastTs ?? 0, ts);
        firstTs = Math.min(firstTs ?? ts, ts);
      }
    }
    if (title && title.source === 'prompt' && s.title_source !== 'none') title = null;
    const runner = await getRunner(this.o.db, s.runner_id);
    const signals = rowSignals({ ...s, cwd: s.cwd ?? cwd, seen_cli: cli, seen_sdk_cli: sdk, seen_human: human, seen_human_non_cli: humanNonCli }, platformOfHome(runner?.home_dir));
    const source = sessionSource({ ...signals, isHubManaged: s.is_hub_managed });
    // The source before the hub: kept when the hub resumes the session; 'hub' for sessions the hub started.
    const origin = s.origin_source === 'hub' ? 'hub' : sessionSource({ ...signals, isHubManaged: false });
    // External write (design D8): a new line written while the hub has no process of this session, later than
    // EXTERNAL_WRITE_MARGIN_MS after the hub's last knowledge of its own process.
    const hubNow = this.now();
    const ref = Math.max(s.slept_at?.getTime() ?? 0, s.last_turn_end_at?.getTime() ?? 0, s.last_input_at?.getTime() ?? 0);
    const extTs = s.process_alive ? null : storedTs.filter(t => t > ref + EXTERNAL_WRITE_MARGIN_MS).reduce<number | null>((a, b) => (a === null || b > a ? b : a), null);
    const changes = {
      ...(cli !== s.seen_cli ? { seen_cli: cli } : {}),
      ...(sdk !== s.seen_sdk_cli ? { seen_sdk_cli: sdk } : {}),
      ...(human !== s.seen_human ? { seen_human: human } : {}),
      ...(humanNonCli !== s.seen_human_non_cli ? { seen_human_non_cli: humanNonCli } : {}),
      ...(rc !== s.remote_control ? { remote_control: rc } : {}),
      ...(source !== s.source ? { source } : {}),
      ...(origin !== s.origin_source ? { origin_source: origin } : {}),
      ...cronReadOnly(source, s.read_only_reason),
      ...(title ? { title: title.text.slice(0, 200), title_source: title.source } : {}),
      ...(cwd && !s.cwd ? { cwd } : {}),
      ...(branch && branch !== s.git_branch ? { git_branch: branch } : {}),
      ...(lastTs !== null ? { last_event_at: sql<Date>`GREATEST(last_event_at, ${new Date(lastTs)})` } : {}),
      ...(firstTs !== null ? { first_event_at: sql<Date>`LEAST(COALESCE(first_event_at, ${new Date(firstTs)}), ${new Date(firstTs)})` } : {}),
      ...(extTs !== null ? { last_external_write_at: sql<Date>`GREATEST(last_external_write_at, ${new Date(extTs)})` } : {}),
      // «Идёт вне хаба» by the hub's clock (D9 p. 10b): when the hub received a live external write. Live — received
      // within EXTERNAL_LIVE_MS of the line's timestamp moved to the hub's clock by the offset measured at hello;
      // history (first replication, a backlog after reconnect) and the Drive import do not count.
      ...(extTs !== null && !s.is_drive_import && hubNow.getTime() - (extTs + (this.o.agents.get(s.runner_id)?.clockOffsetMs ?? 0)) < EXTERNAL_LIVE_MS
        ? {
            external_seen_at: hubNow,
            // A new streak when the hub saw no external write within the activity window.
            external_since: sql<Date>`CASE WHEN external_seen_at IS NULL OR external_seen_at < ${new Date(hubNow.getTime() - EXTERNAL_ACTIVE_MS)} THEN ${hubNow} ELSE external_since END`,
          }
        : {}),
    };
    if (Object.keys(changes).length) await this.o.db.updateTable('sessions').set(changes).where('id', '=', s.id).execute();
    if (inserted.length) this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'session.events', sessionId: s.id, events: inserted });
    if (Object.keys(changes).length) await this.o.hooks.upsert(s.id);
    if (p.kind === 'main' && this.o.hooks.userLines) {
      const uuids = inserted.flatMap(e => (e.kind === 'line' && e.line.type === 'user' && typeof e.line.uuid === 'string' ? [e.line.uuid] : []));
      if (uuids.length) await this.o.hooks.userLines(s.id, uuids);
    }
  }

  // ---------- restore (D3 «Восстановление», D8) ----------

  /** The main transcript of a session, or undefined. */
  async mainFile(s: SessionBase): Promise<FileRow | undefined> {
    return this.o.db
      .selectFrom('transcript_files')
      .selectAll()
      .where('runner_id', '=', s.runner_id)
      .where('claude_session_id', '=', s.claude_session_id)
      .where('kind', '=', 'main')
      .where('superseded_at', 'is', null)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst();
  }

  /** One-time link with the assembled raw file, for file.restore. */
  async prepareRestore(s: SessionBase, file: FileRow): Promise<{ url: string; sha256: string; lines: number }> {
    const a = await assemble(this.o.store, rawPrefix(s.runner_id, s.claude_session_id, file.rel_key, file.generation));
    const token = randomBytes(24).toString('base64url');
    this.sweepRestores();
    // Each link holds the whole file in memory: at most RESTORE_LINKS at a time, the oldest goes first.
    while (this.restores.size >= RESTORE_LINKS) this.restores.delete(this.restores.keys().next().value!);
    this.restores.set(token, { runnerId: s.runner_id, content: a.content, expires: Date.now() + RESTORE_TTL_MS });
    this.restoreTimer ??= setInterval(() => this.sweepRestores(), 60_000);
    this.restoreTimer.unref();
    return { url: `/agent-api/restore/${token}`, sha256: createHash('sha256').update(a.content).digest('hex'), lines: a.lines };
  }

  private sweepRestores(): void {
    const now = Date.now();
    for (const [k, v] of this.restores) if (v.expires < now) this.restores.delete(k);
    if (this.restores.size === 0 && this.restoreTimer) {
      clearInterval(this.restoreTimer);
      this.restoreTimer = null;
    }
  }

  close(): void {
    if (this.restoreTimer) clearInterval(this.restoreTimer);
    this.restoreTimer = null;
    this.restores.clear();
  }

  /** GET /agent-api/restore/<token>: one use, only by the runner it was made for. */
  takeRestore(token: string, runnerId: string): Buffer | null {
    const t = this.restores.get(token);
    if (!t || t.runnerId !== runnerId || t.expires < Date.now()) return null;
    this.restores.delete(token);
    return t.content;
  }

  // ---------- nightly merge ----------

  /** Joins the raw segments of files idle for 24 h into full.jsonl.zst. Returns the number of files merged. */
  async mergeIdle(): Promise<number> {
    const idle = await this.o.db
      .selectFrom('transcript_files')
      .selectAll()
      .where('raw_segments', '>', 1)
      .where('updated_at', '<', new Date(this.now().getTime() - 24 * 3600_000))
      .limit(200)
      .execute();
    let n = 0;
    for (const f of idle) {
      try {
        await mergeSegments(this.o.store, rawPrefix(f.runner_id, f.claude_session_id, f.rel_key, f.generation));
        await this.o.db.updateTable('transcript_files').set({ raw_segments: 0, raw_merged_at: this.now() }).where('id', '=', f.id).where('updated_at', '=', f.updated_at).execute();
        n++;
      } catch (err) {
        this.o.log.warn({ err: (err as Error).message, fileId: f.id }, 'raw merge failed');
      }
    }
    return n;
  }
}

/** agentId of a subagent transcript without the `agent-` prefix: from the chunk, else from the file name. */
export function agentIdOf(p: { agentId?: string | undefined; relPath: string }): string | null {
  const raw =
    p.agentId ??
    p.relPath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.jsonl$/i, '') ??
    null;
  return raw ? raw.replace(/^agent-/, '') : null;
}
