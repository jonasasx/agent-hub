/**
 * Client of the file routes of the hub (change tool-windows-file-explorer, design D3).
 * Requirements (file-explorer): Ленивое дерево; Просмотрщик; Машина не в сети и ошибки; Совместимость со старым агентом.
 * Routes: GET /api/runners/:runnerId/fs/list and GET /api/runners/:runnerId/fs/file. The browser never sends a root:
 * the hub takes the cwd of `sessionId` or the home folder of the machine.
 */
import { FS_ERROR_STATUS, FS_FILE_HEADERS, FS_MEDIA_MAX, FS_TEXT_MAX, type FsErrorCode, type FsFileKind, type FsListResponse } from '@agent-hub/shared';

/** A client-side failure that has no hub code: the network is down, the answer is not what the contract says. */
export type FsClientCode = 'network' | 'bad_response' | 'aborted';
export type FsFailCode = FsErrorCode | FsClientCode;

/** The text for the user of each code of the hub (Requirement: Машина не в сети и ошибки). */
export const FS_MESSAGES: Record<FsFailCode, string> = {
  invalid_request: 'Некорректный запрос',
  invalid_path: 'Недопустимый путь',
  forbidden_origin: 'Запрос отклонён',
  restricted: 'Закрытый путь',
  outside_root: 'Вне разрешённой папки',
  runner_not_found: 'Машина не найдена',
  not_found: 'Не найдено',
  runner_offline: 'Машина не в сети',
  root_unknown: 'Папка машины неизвестна: обновите агента или переподключите машину',
  capability_unavailable: 'Обновите агента',
  too_large: 'Файл слишком большой',
  not_directory: 'Это не папка',
  not_file: 'Это не файл',
  too_many_requests: 'Слишком много запросов, повторите позже',
  io_error: 'Не удалось прочитать на машине',
  agent_timeout: 'Машина не отвечает',
  permission_denied: 'Нет доступа',
  unsupported: 'Нельзя показать',
  network: 'Нет связи с хабом',
  bad_response: 'Неожиданный ответ хаба',
  aborted: 'Запрос отменён',
};

export class FsError extends Error {
  constructor(
    readonly code: FsFailCode,
    readonly status = 0,
    /** Text from the hub, when it sent one. */
    readonly serverMessage?: string,
  ) {
    super(FS_MESSAGES[code]);
  }

  /** What to show: «Файл не найден» for a file, the plain text otherwise. */
  text(subject: 'file' | 'dir' = 'dir'): string {
    if (this.code === 'not_found' && subject === 'file') return 'Файл не найден';
    return FS_MESSAGES[this.code];
  }
}

const KNOWN_CODES = new Set<string>(Object.keys(FS_ERROR_STATUS));

/** Time budget of the client, a little above the hub's 8 s / 30 s: the hub's 504 comes first, this is a backstop. */
export const LIST_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 35_000;

const enc = encodeURIComponent;

export interface ListQuery {
  path?: string;
  sessionId?: string;
  hidden?: boolean;
}

export function fsListUrl(runnerId: string, q: ListQuery): string {
  const params = new URLSearchParams();
  if (q.path) params.set('path', q.path);
  if (q.sessionId) params.set('sessionId', q.sessionId);
  if (q.hidden) params.set('hidden', '1');
  const qs = params.toString();
  return `/api/runners/${enc(runnerId)}/fs/list${qs ? `?${qs}` : ''}`;
}

/** The URL of the bytes of a file: `<img src>` and the fetch of the viewers. */
export function fsFileUrl(runnerId: string, path: string, sessionId?: string): string {
  const params = new URLSearchParams({ path });
  if (sessionId) params.set('sessionId', sessionId);
  return `/api/runners/${enc(runnerId)}/fs/file?${params.toString()}`;
}

async function failure(res: Response): Promise<FsError> {
  let body: { error?: unknown; message?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON
  }
  const code = typeof body.error === 'string' && KNOWN_CODES.has(body.error) ? (body.error as FsErrorCode) : null;
  const message = typeof body.message === 'string' ? body.message : undefined;
  if (code) return new FsError(code, res.status, message);
  // an answer of a proxy or an unknown code: the status says what it was
  if (res.status === 504) return new FsError('agent_timeout', res.status, message);
  if (res.status === 404) return new FsError('not_found', res.status, message);
  return new FsError('io_error', res.status, message);
}

/** fetch with the budget of time; a caller's signal aborts it too. */
async function send(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { credentials: 'same-origin', signal: ctl.signal, headers: { Accept: 'application/json, */*' } });
  } catch {
    if (timedOut) throw new FsError('agent_timeout');
    if (signal?.aborted) throw new FsError('aborted');
    throw new FsError('network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function checkList(raw: unknown): FsListResponse {
  const r = raw as Partial<FsListResponse> | null;
  if (!r || typeof r.path !== 'string' || !Array.isArray(r.entries) || typeof r.truncated !== 'boolean' || typeof r.total !== 'number') {
    throw new FsError('bad_response');
  }
  return { path: r.path, entries: r.entries, truncated: r.truncated, total: r.total };
}

/** One level of a folder. Without `path` — the root of the source. */
export async function fsList(runnerId: string, q: ListQuery = {}, signal?: AbortSignal): Promise<FsListResponse> {
  const res = await send(fsListUrl(runnerId, q), LIST_TIMEOUT_MS, signal);
  if (!res.ok) throw await failure(res);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new FsError('bad_response');
  }
  return checkList(raw);
}

/** An opened file: the bytes are not read yet, the viewers take them as text, a blob or an array buffer. */
export interface FsFile {
  kind: FsFileKind;
  size: number;
  mime: string;
  response: Response;
}

/** The binary class (415): metadata only, no bytes. */
export interface FsUnsupported {
  unsupported: true;
  size: number;
  mime: string;
}

const FILE_KINDS = new Set<string>(['text', 'markdown', 'image', 'pdf', 'binary']);

/** Opens the file; for the binary class the hub answers 415 with the size and the type. */
export async function fsOpenFile(runnerId: string, path: string, sessionId?: string, signal?: AbortSignal): Promise<FsFile | FsUnsupported> {
  const res = await send(fsFileUrl(runnerId, path, sessionId), READ_TIMEOUT_MS, signal);
  if (res.status === 415) {
    let body: { size?: unknown; mime?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // not JSON
    }
    const size = typeof body.size === 'number' ? body.size : 0;
    const mime = typeof body.mime === 'string' ? body.mime : 'application/octet-stream';
    return { unsupported: true, size, mime };
  }
  if (!res.ok) throw await failure(res);
  const kind = res.headers.get(FS_FILE_HEADERS.kind) ?? '';
  if (!FILE_KINDS.has(kind)) throw new FsError('bad_response', res.status);
  const size = Number(res.headers.get(FS_FILE_HEADERS.size));
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  return { kind: kind as FsFileKind, size: Number.isFinite(size) ? size : 0, mime, response: res };
}

export function isUnsupported(f: FsFile | FsUnsupported): f is FsUnsupported {
  return 'unsupported' in f;
}

/** The limit of a class in bytes (for «Файл слишком большой (5 МБ из 2 МБ)»); null for the binary class. */
export function limitFor(kind: FsFileKind): number | null {
  if (kind === 'text' || kind === 'markdown') return FS_TEXT_MAX;
  if (kind === 'image' || kind === 'pdf') return FS_MEDIA_MAX;
  return null;
}
