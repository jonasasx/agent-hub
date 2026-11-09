import type { CatalogDetection } from './detection.js';
// Path signals of sessions (design D9 p. 5, 9; tasks 4.4, 4.7): touches extracted in the transaction that stores the
// events (replication and import), the start directory and its remote, and the full rebuild of projects:reclassify.
// The project of a session is decided only by the catalog detection (single-project-classifier): a debounced
// evaluation (2 s per session) after new events, re-evaluation after a catalog change. Pinned sessions are never changed.
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { platformOfHome, type I18nText } from '@agent-hub/shared';
import type { Database, Db } from '../db/db.js';
import type { RunnerRow } from '../runners/repo.js';
import { normalizeRemote, stripUserinfo } from './catalog.js';
import type { ProjectCatalog } from './catalogService.js';
import { DELETED_EVIDENCE, type Evidence } from './classify.js';
import { signalPath, toolPaths, toVaultRelative, type RunnerPaths } from './signals.js';
import { KeyedSerial } from '../util/serial.js';

/** Postgres NOTIFY channel: projects:reclassify (another process) moved sessions; payload — JSON array of user ids. */
export const PROJECTS_CHANNEL = 'agenthub_projects_changed';

/** Tool calls of an assistant line (projects:reclassify reads only them). */
const TOOL_USES = '$.message.content[*] ? (@.type == "tool_use")';

/**
 * Runs `fn` again after a deadlock (40P01) or a serialization failure (40001): up to 3 attempts in all, with a pause of
 * 100, 300 ms (review M4a p. A). Any other error, and the third failure, are thrown.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (i >= attempts || (code !== '40P01' && code !== '40001')) throw err;
      await new Promise(r => setTimeout(r, 100 * (2 * i - 1)));
    }
  }
}

/**
 * The touch lock of a session for the transaction (review M4a p. 7): the chunk intake, refreshStart and the rebuild of
 * projects:reclassify (another process) take it before they write path_touches of the session.
 */
export async function lockSessionTouches(tx: Transaction<Database>, sessionId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`path_touches:${sessionId}`}, 0))`.execute(tx);
}

export interface TouchRow {
  session_id: string;
  file_id: string;
  line_no: number;
  op: 'edit' | 'read' | 'cwd' | 'remote';
  path_norm: string;
  project_id: string | null;
}

interface SessionLike {
  id: string;
  user_id: string;
  cwd: string | null;
  git_remote: string | null;
}

export interface ProjectServiceOptions {
  db: Db;
  catalog: ProjectCatalog;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /** After any change of the project fields of a session (session.upsert). */
  onChanged?: (sessionId: string) => Promise<void>;
  debounceMs?: number;
}

/** session-folder D5: relative paths count from the machine's default folder (it replaced VAULT_ROOT). */
export function runnerPaths(r: Pick<RunnerRow, 'home_dir' | 'default_dir'> | null | undefined): RunnerPaths {
  return { windows: platformOfHome(r?.home_dir ?? null) === 'windows', homeDir: r?.home_dir ?? null, vaultRoot: r?.default_dir ?? null };
}

export class ProjectService {
  private detection?: CatalogDetection;
  setCatalogDetection(detection: CatalogDetection): void {
    this.detection = detection;
  }
  catalogChanged(userId: string): void {
    const detection = this.detection;
    const key = `catalog:${userId}`;
    if (detection)
      this.track(
        key,
        this.serialized(key, () => detection.catalogChanged(userId)),
      );
  }
  detectCatalog(sessionId: string, firstMessage: string): void {
    if (this.detection) this.track(sessionId, this.detection.evaluate(sessionId, firstMessage));
  }
  private async recomputeWithCatalog(sessionId: string): Promise<void> {
    await this.refreshStart(sessionId);
    await this.detection?.evaluate(sessionId);
  }
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly serial = new KeyedSerial();

  constructor(private readonly o: ProjectServiceOptions) {}

  get catalog(): ProjectCatalog {
    return this.o.catalog;
  }

  /** Touches of stored lines of one transcript file (tool calls; one per path and op on a line). */
  touchesFor(s: SessionLike, runner: RunnerPaths, fileId: string, rows: Array<{ lineNo: number; obj: Record<string, unknown> }>): TouchRow[] {
    const out: TouchRow[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const cwd = typeof r.obj.cwd === 'string' ? r.obj.cwd : s.cwd;
      for (const t of toolPaths(r.obj, runner.windows)) {
        const rel = signalPath(toVaultRelative(t.path, cwd, runner));
        if (!rel) continue;
        const pathNorm = rel;
        const k = `${r.lineNo}\u0000${t.op}\u0000${pathNorm.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ session_id: s.id, file_id: fileId, line_no: r.lineNo, op: t.op, path_norm: pathNorm, project_id: this.o.catalog.matchPath(s.user_id, pathNorm) });
      }
    }
    return out;
  }

  /** The start directory inside the vault (cwd) or its git remote outside it (remote); line 0 of the main file. */
  startTouches(s: SessionLike, runner: RunnerPaths, mainFileId: string): TouchRow[] {
    if (!s.cwd) return [];
    const rel = signalPath(toVaultRelative(s.cwd, null, runner));
    if (rel) {
      const pathNorm = rel;
      return [{ session_id: s.id, file_id: mainFileId, line_no: 0, op: 'cwd', path_norm: pathNorm, project_id: this.o.catalog.matchPath(s.user_id, pathNorm) }];
    }
    if (toVaultRelative(s.cwd, null, runner) !== null) return []; // the vault root: no signal
    const remote = normalizeRemote(stripUserinfo(s.git_remote));
    if (!remote) return [];
    return [{ session_id: s.id, file_id: mainFileId, line_no: 0, op: 'remote', path_norm: `remote:${remote}`, project_id: this.o.catalog.matchRemote(s.user_id, remote) }];
  }

  async insertTouches(db: Db | Transaction<Database>, input: TouchRow[]): Promise<void> {
    // An id that left the catalogue since the touch was matched is stored as «no project» (review M4a p. 6).
    const rows = input.map(r => (r.project_id && !this.o.catalog.has(r.project_id) ? { ...r, project_id: null } : r));
    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insertInto('path_touches')
        .values(rows.slice(i, i + 500))
        .onConflict(oc => oc.columns(['file_id', 'line_no', 'op', 'path_norm']).doNothing())
        .execute();
    }
  }

  /** Evaluation of the session after its events arrived: debounced (2 s). */
  schedule(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.track(sessionId, this.recomputeWithCatalog(sessionId));
    }, this.o.debounceMs ?? 2000);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  private track(sessionId: string, run: Promise<unknown>): void {
    const p = run.then(
      () => undefined,
      (err: unknown) => this.o.log.warn({ err, sessionId }, 'project recompute failed'),
    );
    this.pending.set(sessionId, p);
    void p.finally(() => {
      if (this.pending.get(sessionId) === p) this.pending.delete(sessionId);
    });
  }

  /** Deletion has committed. Reuse stored signals quietly and notify once after the batch. */
  reclassifyDeleted(ids: string[], done: () => void): void {
    const run = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      for (const id of ids) {
        const fail = (err: unknown) => this.o.log.warn({ err, sessionId: id }, 'deleted project reclassification failed');
        // Path and remote rules of the remaining catalog projects, never the model.
        await this.detection?.evaluate(id, undefined, true).catch(fail);
      }
      done();
    });
    this.track(`deleted:${ids.join(',')}`, run);
  }

  /** Waits for scheduled recomputes (tests, shutdown). */
  async flush(): Promise<void> {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(id);
      this.track(id, this.recomputeWithCatalog(id));
    }
    await Promise.all(this.pending.values());
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * Runs `fn` in the queue of the session's project decisions: evaluate, refreshStart, unpin, pin, rebuild of one
   * session never interleave in this process (review M4a p. 5). `fn` must not call the public methods of the same
   * session (they enqueue on the same key).
   */
  serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.serial.run(sessionId, fn);
  }

  /** The start-directory touch of the session brought up to date (cwd and remote can arrive after the first lines). */
  refreshStart(sessionId: string): Promise<void> {
    return this.serialized(sessionId, () => withDbRetry(() => this.refreshStartNow(sessionId)));
  }

  private async refreshStartNow(sessionId: string): Promise<void> {
    const s = await this.o.db
      .selectFrom('sessions as s')
      .innerJoin('runners as r', 'r.id', 's.runner_id')
      .select(['s.id', 's.user_id', 's.cwd', 's.git_remote', 'r.home_dir', 'r.default_dir'])
      .where('s.id', '=', sessionId)
      .executeTakeFirst();
    if (!s) return;
    const main = await this.o.db
      .selectFrom('transcript_files')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('kind', '=', 'main')
      .where('superseded_at', 'is', null)
      .orderBy('id')
      .executeTakeFirst();
    if (!main) return;
    const want = this.startTouches(s, runnerPaths(s), main.id);
    const have = await this.o.db.selectFrom('path_touches').select(['file_id', 'op', 'path_norm', 'project_id']).where('session_id', '=', sessionId).where('op', 'in', ['cwd', 'remote']).execute();
    const key = (r: Pick<TouchRow, 'file_id' | 'op' | 'path_norm' | 'project_id'>) => `${r.file_id}\u0000${r.op}\u0000${r.path_norm}\u0000${r.project_id ?? ''}`;
    if (have.length === want.length && have.every((h, i) => key(h) === key(want[i]!))) return;
    // Delete and insert in one transaction under the session's touch lock (no moment without the start signal).
    await this.o.db.transaction().execute(async tx => {
      await lockSessionTouches(tx, sessionId);
      await tx.deleteFrom('path_touches').where('session_id', '=', sessionId).where('op', 'in', ['cwd', 'remote']).execute();
      if (want.length) await this.insertTouches(tx, want);
    });
  }

  /** «Открепить» «Без проекта»: the label removed, the catalog detection decides afresh; the caller sends session.upsert. */
  async unpin(sessionId: string): Promise<void> {
    await this.serialized(sessionId, () =>
      this.o.db.transaction().execute(async tx => {
        await tx.deleteFrom('classification_labels').where('session_id', '=', sessionId).execute();
        await tx.updateTable('sessions').set({ project_source: 'none', project_id: null, secondary_project_id: null, project_evidence: null }).where('id', '=', sessionId).execute();
      }),
    );
    await this.detection?.evaluate(sessionId);
  }

  /**
   * Hub start (single-project-classifier D2): the legacy path project removed from every session; a pin to «Без проекта»
   * stays, a pin to a legacy group goes. The sessions without a catalog link are evaluated by the catalog detection in
   * the background. Idempotent: nothing writes the legacy fields any more. Returns the ids evaluated.
   */
  async dropLegacy(): Promise<string[]> {
    const linked = sql<boolean>`EXISTS (SELECT 1 FROM session_projects sp WHERE sp.user_id = sessions.user_id AND sp.session_id = sessions.id)`;
    const rows = await this.o.db
      .updateTable('sessions')
      .set({
        project_id: null,
        secondary_project_id: null,
        project_evidence: null,
        project_source: sql`CASE WHEN project_source = 'manual' AND (project_id IS NULL OR ${linked}) THEN 'manual' ELSE 'none' END`,
      })
      .where(eb => eb.or([eb('project_id', 'is not', null), eb('secondary_project_id', 'is not', null), eb('project_source', 'in', ['inherited', 'auto'])]))
      .returning(['id', sql<boolean>`${linked}`.as('linked')])
      .execute();
    if (rows.length) this.o.log.info({ sessions: rows.length }, 'legacy session projects dropped');
    const ids = rows.filter(r => !r.linked).map(r => r.id);
    // a copy: the caller may sort the result
    const pending = [...ids];
    if (this.detection)
      this.track(
        'legacy',
        this.reevaluateLegacy(
          this.detection,
          pending,
          rows.map(r => r.id),
        ),
      );
    return ids;
  }

  /** The sessions left without a link by dropLegacy are evaluated by the catalog; every changed session is announced. */
  private async reevaluateLegacy(detection: CatalogDetection, unlinked: string[], changed: string[]): Promise<void> {
    for (const id of unlinked) {
      await detection.evaluate(id).catch((err: unknown) => this.o.log.warn({ err, sessionId: id }, 'legacy session reclassification failed'));
    }
    for (const id of changed) await this.o.onChanged?.(id);
  }

  /**
   * projects:reclassify: the touches of the session rebuilt from its events (main and subagent, not superseded). Only
   * tool calls are read (jsonb_path_query); the events are read and the touches replaced in one transaction under the
   * session's touch lock, so a chunk the running hub stores meanwhile is not lost (review M4a p. 7, 8). The project is
   * decided by the catalog detection of the caller.
   */
  rebuild(sessionId: string): Promise<void> {
    return this.serialized(sessionId, () => withDbRetry(() => this.rebuildNow(sessionId)));
  }

  private async rebuildNow(sessionId: string): Promise<void> {
    const s = await this.o.db
      .selectFrom('sessions as s')
      .innerJoin('runners as r', 'r.id', 's.runner_id')
      .select(['s.id', 's.user_id', 's.cwd', 's.git_remote', 'r.home_dir', 'r.default_dir'])
      .where('s.id', '=', sessionId)
      .executeTakeFirst();
    if (!s) return;
    await this.o.db.transaction().execute(async tx => {
      await lockSessionTouches(tx, sessionId);
      const rows = await this.collect(tx, s);
      await tx.deleteFrom('path_touches').where('session_id', '=', sessionId).execute();
      await this.insertTouches(tx, rows);
    });
  }

  /** All touches of the session from its stored tool calls and its start directory. */
  private async collect(db: Db | Transaction<Database>, s: SessionLike & Pick<RunnerRow, 'home_dir' | 'default_dir'>): Promise<TouchRow[]> {
    const files = await db.selectFrom('transcript_files').select(['id', 'kind']).where('session_id', '=', s.id).where('superseded_at', 'is', null).orderBy('id').execute();
    if (!files.length) return [];
    const rp = runnerPaths(s);
    const ev = await sql<{ file_id: string; line_no: string; cwd: string | null; tools: unknown[] }>`
      SELECT e.file_id, e.line_no, e.payload->>'cwd' AS cwd, jsonb_path_query_array(e.payload, ${TOOL_USES}::jsonpath) AS tools
        FROM events e
       WHERE e.file_id IN (${sql.join(files.map(f => f.id))}) AND e.type = 'assistant' AND e.payload @? ${TOOL_USES}::jsonpath
       ORDER BY e.file_id, e.line_no`.execute(db);
    const byFile = new Map<string, Array<{ lineNo: number; obj: Record<string, unknown> }>>();
    for (const e of ev.rows) {
      const list = byFile.get(e.file_id) ?? [];
      list.push({ lineNo: Number(e.line_no), obj: { type: 'assistant', ...(e.cwd ? { cwd: e.cwd } : {}), message: { content: e.tools } } });
      byFile.set(e.file_id, list);
    }
    const rows: TouchRow[] = [];
    for (const [fileId, lines] of byFile) rows.push(...this.touchesFor(s, rp, fileId, lines));
    const main = files.find(f => f.kind === 'main');
    if (main) rows.push(...this.startTouches(s, rp, main.id));
    return rows;
  }
}

/** The «project removed» evidence as stored: English now, Russian in rows written before the texts were keyed. */
const isDeletedEvidence = (text: string | undefined): boolean => text === DELETED_EVIDENCE || text === 'проект удалён из справочника';

/** The evidence line of a session view (D9 p. 6). */
export function evidenceOf(source: string, evidence: unknown): string | null {
  const e = evidence as Partial<Evidence> | null;
  if (source === 'manual') return isDeletedEvidence(e?.text) ? DELETED_EVIDENCE : 'pinned manually';
  if (source === 'inherited') return 'inherited from the parent';
  return e?.text ?? null;
}

/** The same evidence line as a key (manual, inherited, deleted); null for an automatic one, whose text stays English. */
export function evidenceI18nOf(source: string, evidence: unknown): I18nText | null {
  const e = evidence as Partial<Evidence> | null;
  if (source === 'manual') return { key: isDeletedEvidence(e?.text) ? 'hub.projects.evidenceDeleted' : 'hub.projects.evidenceManual' };
  if (source === 'inherited') return { key: 'hub.projects.evidenceInherited' };
  return null;
}
