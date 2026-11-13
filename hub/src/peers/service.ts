// Messages between sessions (change `session-peers`, design D2–D6). A session reaches the hub through the agent-hub
// MCP tools of its agent (peers.request); the hub answers with peers.reply. The caller is the session of the connection
// (runner + Claude session id), its owner is the only scope: other owners' sessions do not exist for it (D3). Delivery is
// SessionService.sendMessage — the same path as a message typed in the web (live → session.send, sleeping → resume).
// Requirements: Каталог сессий для сессий; Отправка сообщения другой сессии; Метка отправителя и ответ; Защита от
// зацикливания и журнал; Совместимость с агентами. Change `hub-subagents`: a child session (spawn, D4) and the report of
// its turn to the parent (D5).
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import {
  PEERS_PROTOCOL,
  PROJECT_TOOLS_PROTOCOL,
  createUserProjectSchema,
  normalizeProjectFolder,
  patchUserProjectSchema,
  platformOfHome,
  projectDir,
  relativeFolder,
  type AgentProjectView,
  PEER_TEXT_MAX,
  SPAWN_LIVE_MAX,
  SPAWN_PROTOCOL,
  protocolAtLeast,
  wrapPeerMessage,
  type AgentMessage,
  type PayloadOf,
  type PeerErrorCode,
  type PeerSendResult,
  type PeerSession,
  type PeerSpawnResult,
  type PeersReply,
  type PeersRequest,
  type UiPermissionMode,
} from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { HubBus } from '../bus.js';
import type { AgentGateway } from '../runners/agentGateway.js';
import { getRunner, type RunnerRow } from '../runners/repo.js';
import { findSessionByClaudeId, getSession, type SessionBase } from '../sessions/repo.js';
import { HttpError, inheritMode, type SessionService } from '../sessions/service.js';
import { isLiveStatus } from '../sessions/status.js';
import { createCatalogProject, isNameConflict, linkSessionToProject, updateCatalogProject, type CatalogProjectRow } from '../projects/catalogWrite.js';
import { countRecent, peerCatalog, recordPeerMessage, type PeerJournalKind, type PeerResult } from './repo.js';

export interface PeersServiceOptions {
  db: Db;
  bus: HubBus;
  agents: AgentGateway;
  sessions: SessionService;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  now?: () => Date;
  /** Per ordered pair (from, to) in `windowMs`. */
  pairLimit?: number;
  /** Per sender, all addressees, in `windowMs`. */
  senderLimit?: number;
  windowMs?: number;
}

export const PEER_PAIR_LIMIT = 20;
export const PEER_SENDER_LIMIT = 60;
export const PEER_WINDOW_MS = 10 * 60_000;

/** hub-subagents D5: the end of a report cut to the peer limit; the text when the turn left none. */
export const REPORT_CUT_NOTE = '\n… (truncated, the full answer is in the session)';
export const REPORT_UNAVAILABLE = 'The result text is unavailable: open the session';

type SpawnRequest = Extract<PeersRequest, { op: 'spawn' }>;
type ProjectCreateRequest = Extract<PeersRequest, { op: 'project_create' }>;
type ProjectUpdateRequest = Extract<PeersRequest, { op: 'project_update' }>;
type TurnResult = PayloadOf<AgentMessage, 'session.result'>;

class PeerError extends Error {
  constructor(
    readonly code: PeerErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

const machineBase = (runner: RunnerRow): string => runner.default_dir ?? runner.home_dir ?? '';
const isWindows = (runner: RunnerRow): boolean => platformOfHome(runner.home_dir) === 'windows';

function projectView(p: CatalogProjectRow, runner: RunnerRow): AgentProjectView {
  const base = machineBase(runner);
  // the machine has not reported its folders yet: no path rather than one from the root
  const dir = base ? projectDir(base, p.folder, isWindows(runner)) : '';
  return { id: p.id, name: p.name, description: p.description, remote: p.remote, folder: p.folder, dir };
}

/**
 * agent-project-tools D3: a project folder from a tool — relative to the default folder of the caller's machine, or an
 * absolute path (or `~/…`) on that machine turned relative; outside the default folder or invalid — invalid_request.
 */
export function toProjectFolder(runner: RunnerRow, input: string | null): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const base = machineBase(runner);
  const windows = isWindows(runner);
  let folder = raw;
  const home = runner.home_dir ?? '';
  const tilde = /^~(?=$|[\\/])/.test(raw);
  if (tilde || /^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) {
    const abs = tilde ? home + raw.slice(1) : raw;
    const rel = base ? relativeFolder(base, abs, windows) : null;
    if (rel === null) throw new PeerError('invalid_request', `the folder ${raw} is outside the default folder of the machine ${base || '(unknown)'}; pass a folder inside it`);
    folder = rel;
  }
  try {
    return normalizeProjectFolder(folder);
  } catch (err) {
    throw new PeerError('invalid_request', `${(err as Error).message} (relative to the default folder of the machine ${base || '(unknown)'})`);
  }
}

function nameConflict(err: unknown): unknown {
  return isNameConflict(err) ? new PeerError('conflict', 'a project with this name already exists: find it with projects_list and change it with project_update') : err;
}

const baseName = (cwd: string | null): string => (cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? '') : '');

/** hub-subagents D5: a report longer than a peer message is cut with a note. */
export function cutReport(text: string): string {
  return text.length <= PEER_TEXT_MAX ? text : text.slice(0, PEER_TEXT_MAX - REPORT_CUT_NOTE.length) + REPORT_CUT_NOTE;
}

export class PeersService {
  private readonly now: () => Date;
  private readonly pairLimit: number;
  private readonly senderLimit: number;
  private readonly windowMs: number;
  private readonly running = new Set<Promise<unknown>>();
  /** Spawns of one caller go one after another: the limit of live children is a count, then an insert. */
  private readonly spawning = new Map<string, Promise<unknown>>();

  constructor(private readonly o: PeersServiceOptions) {
    this.now = o.now ?? (() => new Date());
    this.pairLimit = o.pairLimit ?? PEER_PAIR_LIMIT;
    this.senderLimit = o.senderLimit ?? PEER_SENDER_LIMIT;
    this.windowMs = o.windowMs ?? PEER_WINDOW_MS;
    o.bus.on('agent.message', (runnerId, m) => {
      if (m.type !== 'peers.request') return;
      this.track(this.onRequest(runnerId, m.id, m.payload).catch((err: unknown) => o.log.error({ err, runnerId }, 'peers request failed')));
    });
    o.sessions.setTurnReporter((s, p) => this.track(this.report(s, p).catch((err: unknown) => o.log.error({ err, sessionId: s.id }, 'peer report failed'))));
  }

  private track(p: Promise<unknown>): void {
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  /** Tests and shutdown: waits for the requests in flight. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private async onRequest(runnerId: string, reqId: string, req: PeersRequest): Promise<void> {
    const conn = this.o.agents.get(runnerId);
    if (!conn) return;
    let reply: PeersReply;
    try {
      reply = { ok: true, result: await this.handle(runnerId, req) };
    } catch (err) {
      if (err instanceof PeerError) reply = { ok: false, code: err.code, message: err.message, ...(err.retryAfterSec !== undefined ? { retryAfterSec: err.retryAfterSec } : {}) };
      else {
        this.o.log.error({ err, runnerId, op: req.op }, 'peers handler crashed');
        reply = { ok: false, code: 'send_failed', message: 'internal hub error' };
      }
    }
    conn.send('peers.reply', reply, { re: reqId });
  }

  private async handle(runnerId: string, req: PeersRequest): Promise<unknown> {
    // The agent speaks 1.9 if it sends this; the stored version guards a stale or forged connection.
    const runner = await getRunner(this.o.db, runnerId);
    if (!runner || !protocolAtLeast(runner.protocol_version, PEERS_PROTOCOL)) throw new PeerError('unsupported', 'the machine agent does not support messaging between sessions');
    const caller = await findSessionByClaudeId(this.o.db, runnerId, req.sessionId);
    if (!caller) throw new PeerError('not_found', 'the calling session is unknown to the hub');
    if (req.op === 'list')
      return {
        sessions: await peerCatalog(this.o.db, caller.user_id, caller.id, {
          machine: req.machine,
          project: req.project,
          status: req.status,
          query: req.query,
          withReadOnly: true,
          limit: req.limit ?? 50,
        }),
      };
    if (req.op === 'get') return this.get(caller, req.target);
    if (req.op === 'projects' || req.op === 'project_create' || req.op === 'project_update') {
      if (!protocolAtLeast(runner.protocol_version, PROJECT_TOOLS_PROTOCOL)) throw new PeerError('unsupported', 'the machine agent does not support the project tools: update the agent');
      if (req.op === 'projects') return { projects: await this.projects(caller, runner) };
      if (req.op === 'project_create') return { project: await this.projectCreate(caller, runner, req) };
      return { project: await this.projectUpdate(caller, runner, req) };
    }
    if (req.op === 'spawn') {
      const prev = this.spawning.get(caller.id) ?? Promise.resolve();
      const run = prev.catch(() => undefined).then(() => this.spawn(caller, runner, req));
      const tail = run.catch(() => undefined);
      this.spawning.set(caller.id, tail);
      void tail.then(() => {
        if (this.spawning.get(caller.id) === tail) this.spawning.delete(caller.id);
      });
      return run;
    }
    return this.send(caller, runner.name, req.to, req.text, req.inReplyTo);
  }

  /** agent-project-tools: the active catalogue of the caller's owner with the folder of each project on the caller's machine. */
  private async projects(caller: SessionBase, runner: RunnerRow): Promise<AgentProjectView[]> {
    const rows = await this.o.db.selectFrom('catalog_projects').selectAll().where('user_id', '=', caller.user_id).where('archived', '=', false).orderBy('name').execute();
    return rows.map(p => projectView(p, runner));
  }

  private async projectCreate(caller: SessionBase, runner: RunnerRow, req: ProjectCreateRequest): Promise<AgentProjectView> {
    const folder = req.folder === undefined ? undefined : toProjectFolder(runner, req.folder);
    const parsed = createUserProjectSchema.safeParse({ name: req.name, description: req.description, remote: req.remote, folder });
    if (!parsed.success) throw new PeerError('invalid_request', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    let row: CatalogProjectRow;
    try {
      row = await createCatalogProject(this.o.db, caller.user_id, parsed.data);
    } catch (err) {
      throw nameConflict(err);
    }
    this.o.sessions.projects?.catalogChanged(caller.user_id);
    if (req.linkSession) await this.link(caller, row.id);
    this.o.log.info({ sessionId: caller.id, projectId: row.id }, 'project created by a session');
    return projectView(row, runner);
  }

  private async projectUpdate(caller: SessionBase, runner: RunnerRow, req: ProjectUpdateRequest): Promise<AgentProjectView> {
    const folder = req.folder === undefined ? undefined : toProjectFolder(runner, req.folder);
    const parsed = patchUserProjectSchema.safeParse({ name: req.name, description: req.description, remote: req.remote, folder });
    if (!parsed.success) throw new PeerError('invalid_request', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    let row: CatalogProjectRow | undefined;
    try {
      row = await updateCatalogProject(this.o.db, caller.user_id, req.id, parsed.data, true);
    } catch (err) {
      throw nameConflict(err);
    }
    if (!row) throw new PeerError('not_found', 'project not found: see projects_list');
    this.o.sessions.projectsChanged(caller.user_id);
    if (parsed.data.name || parsed.data.folder !== undefined) this.o.sessions.projects?.catalogChanged(caller.user_id);
    if (req.linkSession) await this.link(caller, row.id);
    return projectView(row, runner);
  }

  /** agent-project-tools D4: the caller moves to the project by hand, as «Перенести в…». */
  private async link(caller: SessionBase, projectId: string): Promise<void> {
    await linkSessionToProject(this.o.db, caller.user_id, caller.id, projectId);
    await this.o.sessions.upsert(caller.id);
  }

  private async get(caller: SessionBase, target: string): Promise<PeerSession> {
    const [s] = await peerCatalog(this.o.db, caller.user_id, caller.id, { withReadOnly: true, limit: 1 }, target);
    if (!s) throw new PeerError('not_found', 'session not found');
    const row = await getSession(this.o.db, target, caller.user_id);
    return { ...s, workingChildren: Number(row?.children_working ?? 0) };
  }

  private async send(caller: SessionBase, machine: string, to: string, text: string, inReplyTo: string | undefined): Promise<{ result: PeerSendResult; messageId: string }> {
    const body = text.trim();
    if (!body) throw new PeerError('invalid_request', 'empty text');
    if (text.length > PEER_TEXT_MAX) throw new PeerError('invalid_request', `text is longer than ${PEER_TEXT_MAX} characters`);
    if (to === caller.id) throw new PeerError('invalid_target', 'a session cannot message itself');
    return this.deliver(caller, machine, to, body, inReplyTo, 'message');
  }

  /** The common path of a message and a report: the limits, the envelope, SessionService.sendMessage, the journal. */
  private async deliver(caller: SessionBase, machine: string, to: string, body: string, inReplyTo: string | undefined, kind: PeerJournalKind): Promise<{ result: PeerSendResult; messageId: string }> {
    const [target] = await peerCatalog(this.o.db, caller.user_id, caller.id, { withReadOnly: true, limit: 1 }, to);
    if (!target) throw new PeerError('not_found', 'session not found');
    if (target.readOnly) throw new PeerError('invalid_target', 'the session is read-only: it is not run by the hub, so it can be found and read, not messaged');

    const id = randomUUID();
    const at = this.now();
    const journal = (result: PeerResult, errorCode?: string) => recordPeerMessage(this.o.db, { id, userId: caller.user_id, from: caller.id, to, text: body, inReplyTo, result, errorCode, at, kind });

    // a report is the answer to a task: it is held back by the sender limit only, never by the pair limit of a busy parent and child
    const wait = await this.limited(caller.id, kind === 'report' ? null : to, at);
    if (wait !== null) {
      await journal('rate_limited', 'rate_limited');
      throw new PeerError('rate_limited', `too many messages between sessions, retry in ${wait} s`, wait);
    }
    const outcome: PeerSendResult = target.processAlive && isLiveStatus(target.status) ? (target.status === 'working' ? 'queued' : 'delivered') : 'resumed';
    // D8: the message of the session that spawned the addressee is marked, the child takes it as its task-giver's
    const child = await this.o.db.selectFrom('sessions').select('spawned_by').where('id', '=', to).executeTakeFirst();
    const parent = child?.spawned_by === caller.id;
    const envelope = wrapPeerMessage(
      { from: caller.id, title: caller.title || baseName(caller.cwd), machine, id, inReplyTo, ...(kind !== 'message' ? { kind } : {}), ...(parent ? { parent } : {}) },
      body,
    );
    try {
      await this.o.sessions.sendMessage(caller.user_id, to, { text: envelope, clientUuid: id, peerFrom: caller.id });
    } catch (err) {
      const e = err instanceof HttpError ? this.mapHttp(err) : new PeerError('send_failed', err instanceof Error ? err.message : String(err));
      await journal('error', e.code);
      throw e;
    }
    await journal(outcome);
    this.o.log.info({ from: caller.id, to, id, result: outcome, kind }, 'peer message');
    return { result: outcome, messageId: id };
  }

  /**
   * hub-subagents D4: a child session of the caller — the caller's machine, provider, model and mode unless given; the
   * folder by the rule of session-folder (the parent's project on the target machine, else its default folder); the task is
   * its first turn as a peer message of kind spawn, and that turn reports back (D5).
   */
  private async spawn(caller: SessionBase, runner: RunnerRow, req: SpawnRequest): Promise<PeerSpawnResult> {
    if (!protocolAtLeast(runner.protocol_version, SPAWN_PROTOCOL)) throw new PeerError('unsupported', 'the machine agent does not support starting subagents through the hub, update the agent');
    const task = req.task.trim();
    if (!task) throw new PeerError('invalid_request', 'empty task');
    if (req.task.length > PEER_TEXT_MAX) throw new PeerError('invalid_request', `task is longer than ${PEER_TEXT_MAX} characters`);

    const live = await this.o.db
      .selectFrom('sessions')
      .select(sql<string>`count(*)`.as('n'))
      .where('spawned_by', '=', caller.id)
      .where('process_alive', '=', true)
      .where('status', 'in', ['working', 'waiting', 'permission'])
      .executeTakeFirstOrThrow();
    if (Number(live.n) >= SPAWN_LIVE_MAX) throw new PeerError('rate_limited', `${SPAWN_LIVE_MAX} subagents are already running, wait for their results`);
    const at = this.now();
    const wait = await this.limited(caller.id, null, at);
    if (wait !== null) throw new PeerError('rate_limited', `too many messages and launches, retry in ${wait} s`, wait);

    const target = await this.machine(caller.user_id, runner, req.machine);
    const provider = req.provider ?? caller.provider;
    const id = randomUUID();
    const envelope = wrapPeerMessage({ from: caller.id, title: caller.title || baseName(caller.cwd), machine: runner.name, id, kind: 'spawn', parent: true }, task);
    let model = req.model?.trim() || null;
    let view;
    try {
      // a session started outside the hub has no model: the default of the provider on the machine
      model ??= (provider === caller.provider ? caller.model : null) ?? (await this.o.sessions.defaultModel(caller.user_id, target.id, provider));
      // runner-enrollment «Запуск под root»: bypassPermissions becomes acceptEdits on a root machine
      const mode = inheritMode(caller.permission_mode, target).mode as UiPermissionMode;
      view = await this.o.sessions.create(caller.user_id, { runnerId: target.id, permissionMode: mode, model, prompt: envelope, provider }, undefined, {
        parentId: caller.id,
        task,
        title: req.title,
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw new PeerError('spawn_failed', err instanceof Error ? err.message : String(err));
      if (err.code === 'runner_offline') throw new PeerError('runner_offline', err.message);
      if (err.status === 404) throw new PeerError('not_found', err.message);
      throw new PeerError('spawn_failed', err.code === 'cwd_not_found' ? `cwd_not_found: ${err.message}` : err.message);
    }
    await recordPeerMessage(this.o.db, { id, userId: caller.user_id, from: caller.id, to: view.id, text: task, result: 'resumed', at, kind: 'spawn' });
    this.o.log.info({ from: caller.id, to: view.id, id, machine: target.name, provider }, 'peer spawn');
    return { sessionId: view.id, title: view.title, machine: target.name, provider, cwd: view.cwd ?? '', model };
  }

  /** The machine of a spawn by name, case-insensitive, among the owner's active machines; none given — the caller's. */
  private async machine(userId: string, own: RunnerRow, name: string | undefined): Promise<RunnerRow> {
    const want = name?.trim().toLowerCase();
    if (!want || want === own.name.toLowerCase()) return own;
    const rows = await this.o.db.selectFrom('runners').selectAll().where('user_id', '=', userId).where('kind', '=', 'machine').where('state', '=', 'active').orderBy('created_at').execute();
    const hit = rows.find(r => r.name.toLowerCase() === want);
    if (!hit) throw new PeerError('not_found', `machine "${name}" not found, available: ${rows.map(r => r.name).join(', ')}`);
    return hit;
  }

  /**
   * hub-subagents D5: the report of a turn the parent started. The expected report is taken once (one UPDATE that
   * returns the values before it: a repeated session.result sends nothing); none when the child wrote to the parent
   * itself during the turn.
   */
  async report(s: SessionBase, p: TurnResult): Promise<void> {
    // RETURNING gives the row after SET: the old values come from the locked subquery
    // a parent message queued behind this turn (report_queued) keeps the mark for the next turn
    const taken = await sql<{ report_to_session_id: string; report_since: Date }>`
      UPDATE sessions s SET report_to_session_id = CASE WHEN old.report_queued > 0 THEN old.report_to_session_id END,
        report_since = CASE WHEN old.report_queued > 0 THEN now() END,
        report_queued = GREATEST(old.report_queued - 1, 0)
      FROM (SELECT id, report_to_session_id, report_since, report_queued FROM sessions WHERE id = ${s.id} AND report_to_session_id IS NOT NULL FOR UPDATE) old
      WHERE s.id = old.id
      RETURNING old.report_to_session_id, old.report_since`.execute(this.o.db);
    const parent = taken.rows[0]?.report_to_session_id;
    const since = taken.rows[0]?.report_since;
    if (!parent || !since) return;
    const answered = await this.o.db
      .selectFrom('peer_messages')
      .select('id')
      .where('from_session_id', '=', s.id)
      .where('to_session_id', '=', parent)
      .where('kind', '=', 'message')
      .where('result', 'not in', ['rate_limited', 'error'])
      .where('created_at', '>=', since)
      .executeTakeFirst();
    if (answered) return;
    const text = cutReport(await this.reportText(s.id, since, p));
    const runner = await getRunner(this.o.db, s.runner_id);
    try {
      await this.deliver(s, runner?.name ?? '', parent, text, undefined, 'report');
    } catch (err) {
      this.o.log.warn({ err, from: s.id, to: parent }, 'peer report not delivered');
    }
  }

  private async reportText(sessionId: string, since: Date, p: TurnResult): Promise<string> {
    if (p.isError) return `The turn ended with an error: ${p.failure?.message || p.errorText || p.subtype}`;
    if (p.resultText?.trim()) return p.resultText.trim();
    // an agent below 1.12 sends no text: the last answer of the turn from the replica, if it is there yet
    const last = await this.o.db
      .selectFrom('events')
      .select('search_text')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'assistant')
      .where('is_sidechain', '=', false)
      .where('ts', '>=', since)
      .where('search_text', 'is not', null)
      .orderBy('ts', 'desc')
      .limit(1)
      .executeTakeFirst();
    return last?.search_text?.trim() || REPORT_UNAVAILABLE;
  }

  private mapHttp(err: HttpError): PeerError {
    if (err.code === 'runner_offline') return new PeerError('runner_offline', err.message);
    if (err.status === 404) return new PeerError('not_found', 'session not found');
    return new PeerError('send_failed', err.message);
  }

  /** Seconds until the sender may write again, or null when it may now; `to` null — the sender limit only. */
  private async limited(from: string, to: string | null, at: Date): Promise<number | null> {
    const since = new Date(at.getTime() - this.windowMs);
    const checks: Array<[{ count: number; oldest: Date | null }, number]> = [[await countRecent(this.o.db, from, null, since), this.senderLimit]];
    if (to) checks.push([await countRecent(this.o.db, from, to, since), this.pairLimit]);
    let wait: number | null = null;
    for (const [r, limit] of checks) {
      if (r.count < limit || !r.oldest) continue;
      const s = Math.max(1, Math.ceil((r.oldest.getTime() + this.windowMs - at.getTime()) / 1000));
      wait = Math.max(wait ?? 0, s);
    }
    return wait;
  }
}
