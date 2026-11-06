import type { CatalogDetection } from './detection.js';
// Path signals and project decisions of sessions (design D9 p. 5–6, 9; tasks 4.4, 4.5, 4.7): touches extracted in the
// transaction that stores the events (replication and import), the start directory and its remote, a debounced
// recompute (2 s per session) with the toast «Проект определён», re-matching after a catalogue change without parsing
// events again, and the full rebuild of projects:reclassify. Pinned (manual) sessions are never changed.
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { platformOfHome, type I18nText } from '@agent-hub/shared';
import type { Database, Db } from '../db/db.js';
import type { RunnerRow } from '../runners/repo.js';
import { normalizeRemote, stripUserinfo } from './catalog.js';
import type { ProjectCatalog } from './catalogService.js';
import { classify, DELETED_EVIDENCE, type Decision, type Evidence, type Touch } from './classify.js';
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

export interface RecomputeOptions {
  toast?: boolean;
  fresh?: boolean;
  dryRun?: boolean;
  /** The start touches are already current (rebuild). */
  skipStart?: boolean;
  /** No session.upsert or toast (unpin answers with the view). */
  quiet?: boolean;
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
  /** A project decided or changed by the paths (not by a catalogue change or the CLI): toast + session.upsert. */
  onDecided?: (sessionId: string, projectId: string | null) => Promise<void>;
  /** After any change of the project fields of a session (session.upsert). */
  onChanged?: (sessionId: string) => Promise<void>;
  debounceMs?: number;
}

export function runnerPaths(r: Pick<RunnerRow, 'home_dir' | 'vault_root'> | null | undefined): RunnerPaths {
  return { windows: platformOfHome(r?.home_dir ?? null) === 'windows', homeDir: r?.home_dir ?? null, vaultRoot: r?.vault_root ?? null };
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
    await this.recompute(sessionId, { toast: true });
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

  /** Recompute of the session after its events arrived: debounced (2 s), the toast when the paths decide. */
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
        await this.recompute(id, { fresh: true, quiet: true, skipStart: true }).catch(fail);
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
   * Runs `fn` in the queue of the session's project decisions: recompute, refreshStart, unpin, pin, rebuild of one
   * session never interleave in this process (review M4a p. 5). `fn` must not call the public methods of the same
   * session (they enqueue on the same key).
   */
  serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.serial.run(sessionId, fn);
  }

  /** Touches of the session that count: not those of superseded files. */
  private async touchesOf(sessionId: string): Promise<Touch[]> {
    const rows = await this.o.db
      .selectFrom('path_touches as pt')
      .innerJoin('transcript_files as f', 'f.id', 'pt.file_id')
      .select(['pt.op', 'pt.project_id', 'pt.path_norm'])
      .where('pt.session_id', '=', sessionId)
      .where('f.superseded_at', 'is', null)
      .execute();
    return rows.map(r => ({ op: r.op, projectId: r.project_id, pathNorm: r.path_norm }));
  }

  /** The start-directory touch of the session brought up to date (cwd and remote can arrive after the first lines). */
  refreshStart(sessionId: string): Promise<void> {
    return this.serialized(sessionId, () => withDbRetry(() => this.refreshStartNow(sessionId)));
  }

  private async refreshStartNow(sessionId: string): Promise<void> {
    const s = await this.o.db
      .selectFrom('sessions as s')
      .innerJoin('runners as r', 'r.id', 's.runner_id')
      .select(['s.id', 's.user_id', 's.cwd', 's.git_remote', 'r.home_dir', 'r.vault_root'])
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

  /** Decision for the session; written unless pinned. `fresh` — no hysteresis (unpin). Returns the decision. */
  recompute(sessionId: string, opts: RecomputeOptions = {}): Promise<Decision | null> {
    return this.serialized(sessionId, () => withDbRetry(() => this.recomputeNow(sessionId, opts)));
  }

  private async recomputeNow(sessionId: string, opts: RecomputeOptions): Promise<Decision | null> {
    const s = await this.o.db
      .selectFrom('sessions')
      .select(['id', 'user_id', 'source', 'project_id', 'project_source', 'secondary_project_id', 'project_evidence'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!s || s.project_source === 'manual') return null;
    if (!opts.dryRun && !opts.skipStart) await this.refreshStartNow(sessionId);
    const current = !opts.fresh && s.project_source === 'auto' ? s.project_id : null;
    let d = classify(await this.touchesOf(sessionId), this.o.catalog.infos(s.user_id), current, { cron: s.source === 'cron' });
    // An inherited project (fork) stays until the paths name a leader.
    // (also with `fresh`: --fresh turns off the hysteresis of an auto project only, review M4b p. 7)
    if (s.project_source === 'inherited' && !d.projectId) d = { projectId: s.project_id, secondaryId: null, evidence: null };
    if (opts.dryRun) return d;
    const source = s.project_source === 'inherited' && d.projectId === s.project_id && !d.evidence ? 'inherited' : d.projectId ? 'auto' : 'none';
    const evidence = d.evidence ? JSON.stringify(d.evidence) : null;
    const same = s.project_id === d.projectId && s.secondary_project_id === d.secondaryId && s.project_source === source && JSON.stringify(s.project_evidence ?? null) === (evidence ?? 'null');
    if (same) return d;
    const r = await this.o.db
      .updateTable('sessions')
      .set({ project_id: d.projectId, secondary_project_id: d.secondaryId, project_source: source, project_evidence: evidence })
      .where('id', '=', sessionId)
      .where('project_source', '<>', 'manual')
      .executeTakeFirst();
    // Pinned meanwhile (another process): nothing written, no toast.
    if (!Number(r.numUpdatedRows)) return d;
    if (opts.quiet) return d;
    if (opts.toast && d.projectId && d.projectId !== s.project_id) await this.o.onDecided?.(sessionId, d.projectId);
    else await this.o.onChanged?.(sessionId);
    return d;
  }

  /** «Открепить»: the label removed, the classifier decides afresh (no hysteresis); the caller sends session.upsert. */
  unpin(sessionId: string): Promise<Decision | null> {
    return this.serialized(sessionId, async () => {
      await this.o.db.transaction().execute(async tx => {
        await tx.deleteFrom('classification_labels').where('session_id', '=', sessionId).execute();
        await tx.updateTable('sessions').set({ project_source: 'none', project_id: null, secondary_project_id: null, project_evidence: null }).where('id', '=', sessionId).execute();
      });
      return this.recomputeNow(sessionId, { fresh: true, quiet: true });
    });
  }

  /**
   * projects:reclassify: the touches of the session rebuilt from its events (main and subagent, not superseded). Only
   * tool calls are read (jsonb_path_query); the events are read and the touches replaced in one transaction under the
   * session's touch lock, so a chunk the running hub stores meanwhile is not lost (review M4a p. 7, 8).
   */
  rebuild(sessionId: string, dryRun: boolean, fresh = false): Promise<Decision | null> {
    return this.serialized(sessionId, () => withDbRetry(() => this.rebuildNow(sessionId, dryRun, fresh)));
  }

  /** `fresh` (projects:reclassify --fresh): decided from scratch, the stored auto project not taken into account. */
  private async rebuildNow(sessionId: string, dryRun: boolean, fresh: boolean): Promise<Decision | null> {
    const s = await this.o.db
      .selectFrom('sessions as s')
      .innerJoin('runners as r', 'r.id', 's.runner_id')
      .select(['s.id', 's.user_id', 's.cwd', 's.git_remote', 's.source', 's.project_id', 's.project_source', 'r.home_dir', 'r.vault_root'])
      .where('s.id', '=', sessionId)
      .executeTakeFirst();
    if (!s) return null;
    if (dryRun) {
      if (s.project_source === 'manual') return null;
      const rows = await this.collect(this.o.db, s);
      // The same decision as the live recompute (review of the M4a prod sample: a session the live path kept by
      // hysteresis came out «Без проекта» from scratch): the auto project as `current`, an inherited one kept.
      let d = classify(
        rows.map(r => ({ op: r.op, projectId: r.project_id, pathNorm: r.path_norm })),
        this.o.catalog.infos(s.user_id),
        !fresh && s.project_source === 'auto' ? s.project_id : null,
        { cron: s.source === 'cron' },
      );
      if (s.project_source === 'inherited' && !d.projectId) d = { projectId: s.project_id, secondaryId: null, evidence: null };
      return d;
    }
    await this.o.db.transaction().execute(async tx => {
      await lockSessionTouches(tx, sessionId);
      const rows = await this.collect(tx, s);
      await tx.deleteFrom('path_touches').where('session_id', '=', sessionId).execute();
      await this.insertTouches(tx, rows);
    });
    return this.recomputeNow(sessionId, { toast: false, skipStart: true, fresh });
  }

  /** All touches of the session from its stored tool calls and its start directory. */
  private async collect(db: Db | Transaction<Database>, s: SessionLike & Pick<RunnerRow, 'home_dir' | 'vault_root'>): Promise<TouchRow[]> {
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
