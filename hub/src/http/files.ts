// Read-only file explorer for the browser: GET /api/runners/:runnerId/fs/list and /fs/file (change `tool-windows-file-explorer`, design D2-D3),
// /fs/download (change `file-download`, design D1-D6).
// Requirement: Безопасный доступ к файлам машины; Машина не в сети и ошибки; Ленивое дерево; Просмотрщик файлов; Скачивание файла.
// The root is set here (session cwd or the machine's home), never taken from the browser. The agent checks the path against it.
// Neither paths nor contents go to the log: only the runner, the class, the size and the error code.
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FS_CHUNK_MAX,
  FS_ERROR_CODES,
  FS_ERROR_STATUS,
  FS_FILE_HEADERS,
  fsDownloadQuerySchema,
  fsFileQuerySchema,
  fsListQuerySchema,
  fsListResultSchema,
  fsReadChunkResultSchema,
  fsReadResultSchema,
  pathFitsPlatform,
  platformOfHome,
  type FsDownloadProbe,
  type FsErrorCode,
  type FsFileKind,
  type FsListResponse,
  type FsReadChunkResult,
  type FsUnsupportedResponse,
} from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { AgentConnection, AgentGateway, CommandError } from '../runners/agentGateway.js';
import { HttpError } from '../sessions/service.js';
import type { I18nText } from '@agent-hub/shared';
import { RateLimiter } from './limits.js';

export interface FsRouteOptions {
  /** Simultaneous fs.* commands to one machine; the rest wait in the queue (design D2). */
  concurrency: number;
  /** Requests waiting for a free slot of a machine; more get 429. */
  queue: number;
  /** fs.* requests of one user per minute. */
  ratePerMinute: number;
  listTimeoutMs: number;
  readTimeoutMs: number;
}

export const FS_ROUTE_DEFAULTS: FsRouteOptions = { concurrency: 4, queue: 10, ratePerMinute: 60, listTimeoutMs: 8000, readTimeoutMs: 30_000 };

/** At most `limit` holders per key; the next `queue` wait, the rest are refused. */
export class KeyedGate {
  private readonly state = new Map<string, { active: number; waiters: Array<() => void> }>();

  constructor(
    private readonly limit: number,
    private readonly queue: number,
  ) {}

  /** Resolves with the release function, or null when the queue of this key is full. */
  async acquire(key: string): Promise<(() => void) | null> {
    let s = this.state.get(key);
    if (!s) {
      s = { active: 0, waiters: [] };
      this.state.set(key, s);
    }
    if (s.active >= this.limit) {
      if (s.waiters.length >= this.queue) return null;
      // the slot is handed over by release(): active stays as it is
      await new Promise<void>(resolve => s.waiters.push(resolve));
    } else {
      s.active += 1;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = s.waiters.shift();
      if (next) return next();
      s.active -= 1;
      if (s.active === 0 && this.state.get(key) === s) this.state.delete(key);
    };
  }
}

const MESSAGES: Record<FsErrorCode, I18nText> = {
  invalid_request: { key: 'hub.files.invalidRequest' },
  invalid_path: { key: 'hub.files.invalidPath' },
  forbidden_origin: { key: 'hub.files.forbiddenOrigin' },
  restricted: { key: 'hub.files.restricted' },
  outside_root: { key: 'hub.files.outsideRoot' },
  runner_not_found: { key: 'hub.files.runnerNotFound' },
  not_found: { key: 'hub.files.notFound' },
  runner_offline: { key: 'hub.files.runnerOffline' },
  root_unknown: { key: 'hub.files.rootUnknown' },
  capability_unavailable: { key: 'hub.files.capabilityUnavailable' },
  too_large: { key: 'hub.files.tooLarge' },
  not_directory: { key: 'hub.files.notDirectory' },
  not_file: { key: 'hub.files.notFile' },
  too_many_requests: { key: 'hub.files.tooManyRequests' },
  io_error: { key: 'hub.files.ioError' },
  agent_timeout: { key: 'hub.files.agentTimeout' },
  permission_denied: { key: 'hub.files.permissionDenied' },
  unsupported: { key: 'hub.files.unsupported' },
};

function fail(code: FsErrorCode): HttpError {
  return new HttpError(FS_ERROR_STATUS[code], code, MESSAGES[code]);
}

/**
 * Content-Disposition of a download (file-download D6): an ASCII fallback with everything else replaced by `_`, and the
 * real name in UTF-8 as `filename*` (RFC 6266 / 5987).
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** The last segment of a path of either platform. */
function baseName(p: string): string {
  return (
    p
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? 'download'
  );
}

function parse<T extends z.ZodType>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw fail('invalid_request');
  return r.data;
}

/** MIME types the hub puts into Content-Type of an image / pdf answer; anything else from the agent is an error, not a header. */
const SERVED_MIME: Record<'image' | 'pdf', ReadonlySet<string>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']),
  pdf: new Set(['application/pdf']),
};

/** The machine of a user: `active` and `user_id` are the filter, a foreign or unknown id is simply not there (404). */
export async function getOwnedRunner(db: Db, userId: string, runnerId: string): Promise<{ id: string; home_dir: string | null } | undefined> {
  return db.selectFrom('runners').select(['id', 'home_dir']).where('id', '=', runnerId).where('user_id', '=', userId).where('state', '=', 'active').executeTakeFirst();
}

/** The folder a request is limited to: the session's cwd (the session is the user's and sits on this machine) or the machine's home. */
async function rootOf(db: Db, userId: string, runner: { id: string; home_dir: string | null }, sessionId: string | undefined, online: boolean): Promise<string> {
  if (!sessionId) {
    // an online machine without a known home (an old agent) is not «offline»: say what to do
    if (!runner.home_dir) throw fail(online ? 'root_unknown' : 'runner_offline');
    return runner.home_dir;
  }
  const session = await db.selectFrom('sessions').select(['cwd']).where('id', '=', sessionId).where('user_id', '=', userId).where('runner_id', '=', runner.id).executeTakeFirst();
  if (!session?.cwd) throw fail('runner_not_found');
  return session.cwd;
}

export function registerFileRoutes(app: FastifyInstance, deps: { db: Db; agents: AgentGateway; options?: Partial<FsRouteOptions> }): void {
  const { db, agents } = deps;
  const o: FsRouteOptions = { ...FS_ROUTE_DEFAULTS, ...deps.options };
  const gate = new KeyedGate(o.concurrency, o.queue);
  const rate = new RateLimiter(o.ratePerMinute);
  app.addHook('onClose', async () => rate.stop());

  /** Ownership, root, path syntax, rate limit, machine state: everything before the agent hears about the request. */
  async function prepare(req: FastifyRequest, params: unknown, sessionId: string | undefined, path: string | undefined, capability = 'fs.browse') {
    const { runnerId } = parse(z.object({ runnerId: z.string().min(1).max(200) }), params);
    const userId = req.user!.id;
    const runner = await getOwnedRunner(db, userId, runnerId);
    if (!runner) throw fail('runner_not_found');
    const root = await rootOf(db, userId, runner, sessionId, agents.get(runnerId) !== undefined);
    const target = path ?? root;
    if (!pathFitsPlatform(target, platformOfHome(runner.home_dir)) || target.split(/[\\/]+/).includes('..')) throw fail('invalid_path');
    if (!rate.hit(userId)) throw fail('too_many_requests');
    const connection = agents.get(runnerId);
    if (!connection) throw fail('runner_offline');
    if (!connection.capabilities.includes(capability)) throw fail('capability_unavailable');
    return { runnerId, root, target, connection };
  }

  /** One command under the per-machine limit; its failure becomes an HttpError with the code of the protocol. */
  async function run(req: FastifyRequest, connection: AgentConnection, runnerId: string, send: () => Promise<unknown>): Promise<unknown> {
    const release = await gate.acquire(runnerId);
    if (!release) throw fail('too_many_requests');
    try {
      return await send();
    } catch (error) {
      const e = error as CommandError;
      if (e.code === 'timeout') throw fail('agent_timeout');
      if (e.code === 'disconnected') throw fail('runner_offline');
      if ((FS_ERROR_CODES as readonly string[]).includes(e.code)) {
        req.log.info({ runnerId, code: e.code }, 'fs request refused');
        throw fail(e.code as FsErrorCode);
      }
      req.log.warn({ runnerId, code: e.code }, 'fs request failed');
      throw fail('io_error');
    } finally {
      release();
    }
  }

  // Requirement: Ленивое дерево — one level per request.
  app.get('/api/runners/:runnerId/fs/list', async (req): Promise<FsListResponse> => {
    const q = parse(fsListQuerySchema, req.query);
    const { runnerId, root, target, connection } = await prepare(req, req.params, q.sessionId, q.path);
    const raw = await run(req, connection, runnerId, () => connection.request('fs.list', { path: target, root, showHidden: q.hidden === '1' }, o.listTimeoutMs));
    const parsed = fsListResultSchema.safeParse(raw);
    if (!parsed.success) {
      req.log.warn({ runnerId }, 'fs.list: malformed agent answer');
      throw fail('io_error');
    }
    return parsed.data;
  });

  // Requirement: Просмотрщик файлов — the bytes of one file, with headers that keep active content from running.
  app.get('/api/runners/:runnerId/fs/file', async (req, reply: FastifyReply) => {
    const q = parse(fsFileQuerySchema, req.query);
    const { runnerId, root, target, connection } = await prepare(req, req.params, q.sessionId, q.path);
    const raw = await run(req, connection, runnerId, () => connection.request('fs.read', { path: target, root }, o.readTimeoutMs));
    const parsed = fsReadResultSchema.safeParse(raw);
    if (!parsed.success) {
      req.log.warn({ runnerId }, 'fs.read: malformed agent answer');
      throw fail('io_error');
    }
    const r = parsed.data;
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    if (r.kind === 'binary') {
      const body: FsUnsupportedResponse = { error: 'unsupported', kind: 'binary', size: r.size, mime: r.mime };
      return reply.code(FS_ERROR_STATUS.unsupported).send(body);
    }
    let body: Buffer;
    let type: string;
    if (r.kind === 'text' || r.kind === 'markdown') {
      if (typeof r.text !== 'string') throw fail('io_error');
      body = Buffer.from(r.text, 'utf8');
      type = 'text/plain; charset=utf-8';
    } else {
      const data = (raw as { data?: unknown }).data;
      if (!Buffer.isBuffer(data) || !SERVED_MIME[r.kind].has(r.mime)) throw fail('io_error');
      body = data;
      type = r.mime;
    }
    const kind: FsFileKind = r.kind;
    req.log.info({ runnerId, kind, size: body.length }, 'fs file served');
    reply.header('Content-Disposition', 'inline');
    reply.header(FS_FILE_HEADERS.kind, kind);
    reply.header(FS_FILE_HEADERS.size, String(body.length));
    return reply.type(type).send(body);
  });

  // Requirement: Скачивание файла — any class and size, read from the machine in pieces of FS_CHUNK_MAX (D1-D5).
  app.get('/api/runners/:runnerId/fs/download', async (req, reply: FastifyReply) => {
    const q = parse(fsDownloadQuerySchema, req.query);
    const { runnerId, root, target, connection } = await prepare(req, req.params, q.sessionId, q.path, 'fs.download');
    // each piece takes its own slot of the machine, so a long download does not hold one away from the viewer (D5)
    const piece = async (offset: number, length: number): Promise<{ result: FsReadChunkResult; data: Buffer }> => {
      const raw = await run(req, connection, runnerId, () => connection.request('fs.read_chunk', { path: target, root, offset, length }, o.readTimeoutMs));
      const parsed = fsReadChunkResultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.offset !== offset) {
        req.log.warn({ runnerId }, 'fs.read_chunk: malformed agent answer');
        throw fail('io_error');
      }
      const r = parsed.data;
      if (r.bytes === 0) return { result: r, data: Buffer.alloc(0) };
      const data = (raw as { data?: unknown }).data;
      if (r.binary !== true || !Buffer.isBuffer(data) || data.length !== r.bytes) throw fail('io_error');
      return { result: r, data };
    };
    if (q.probe === '1') {
      const { result } = await piece(0, 0);
      const body: FsDownloadProbe = { name: baseName(target), size: result.size, mtimeMs: result.mtimeMs };
      reply.header('Cache-Control', 'private, no-store');
      return body;
    }
    // the first piece comes before the headers: a refusal is still an ordinary error answer
    const first = await piece(0, FS_CHUNK_MAX);
    const { size, mtimeMs } = first.result;
    const started = Date.now();
    async function* pieces(): AsyncGenerator<Buffer> {
      if (first.data.length) yield first.data;
      let offset = first.result.bytes;
      while (offset < size) {
        const next = await piece(offset, FS_CHUNK_MAX);
        // a file changed in the middle would glue two versions: the answer is cut instead (D3)
        if (next.result.size !== size || next.result.mtimeMs !== mtimeMs || next.result.bytes === 0) {
          req.log.info({ runnerId, code: 'file_changed' }, 'fs download aborted');
          throw new Error('file_changed');
        }
        offset += next.result.bytes;
        yield next.data;
      }
      req.log.info({ runnerId, size, ms: Date.now() - started }, 'fs file downloaded');
    }
    // one piece waits in the buffer while the next is read: at most two pieces of a download in memory
    const stream = Readable.from(pieces(), { objectMode: false, highWaterMark: FS_CHUNK_MAX });
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header('X-Accel-Buffering', 'no');
    reply.header('Content-Disposition', attachmentDisposition(baseName(target)));
    reply.header('Content-Length', String(size));
    return reply.type('application/octet-stream').send(stream);
  });
}
