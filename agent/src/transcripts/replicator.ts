// Replication of every transcript of this machine (design D4): ~/.claude/projects/*/*.jsonl and
// */<session>/subagents/*.jsonl, plus side files <session>/tool-results/*. fs.watch (recursive) and a full walk
// every 60 s find changes; cursors are owned by the hub (welcome.cursors, repl.ack). Sessions this agent runs go
// first and are not rate-limited; history is sent at most REPL_MAX_BYTES_PER_SEC.
// Requirements: Слежение за .jsonl на машине; Доставка с подтверждением смещения.
import { stripRemoteUserinfo } from '@agent-hub/shared';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpathSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENT_META_LIMIT, PROTOCOL_VERSION, REPL_FILES_PAGE } from '@agent-hub/shared';
import type { Logger } from '../log.js';
import { encodeCwd, readLines } from './tailer.js';

/** Is the version `major.minor` at least the given one. */
function protocolAtLeast(v: string, major: number, minor: number): boolean {
  const [a, b] = v.split('.').map(Number) as [number, number];
  return a > major || (a === major && b >= minor);
}

const WIN = process.platform === 'win32';
/** File key: NTFS does not distinguish case, so C--Users-… and c--Users-… are one file (D4). */
export const fileKey = (relPath: string, windows = WIN): string => (windows ? relPath.toLowerCase() : relPath);

interface Cursor {
  generation: number;
  ackedLine: number;
  ackedByte: number;
}

interface FileState {
  relPath: string;
  abs: string;
  sessionId: string;
  kind: 'main' | 'subagent';
  agentId?: string;
  size: number;
  mtimeMs: number;
  cursor: Cursor;
  inflight: boolean;
  inflightAt: number;
  metaSent: boolean;
}

export interface ReplicatorDeps {
  projectsDir: string;
  send: (type: string, payload: unknown) => boolean;
  /** Binary frame right after a side.file message. */
  sendBinary?: (data: Buffer) => boolean;
  log: Logger;
  /** Limit for history (not for sessions this agent runs), bytes per second. */
  maxBytesPerSec: number;
  /** Local state (side files already sent). */
  stateDir?: string;
  /** Session ids with a cron marker (~/.claude/agent-hub/cron-sessions.txt, D5). */
  cronMarkersFile?: string;
  pollMs?: number;
  walkMs?: number;
  ackTimeoutMs?: number;
  /** Chunks of history in flight at once. */
  maxInflight?: number;
  /** Use fs.watch (off in tests that drive walk/tick themselves). */
  watch?: boolean;
  now?: () => number;
  windows?: boolean;
  gitInfo?: (cwd: string) => Promise<{ remote?: string }>;
}

/** Side file retries without side.ack: 60 s doubling up to 30 min. */
export const SIDE_RETRY_MIN_MS = 60_000;
export const SIDE_RETRY_MAX_MS = 30 * 60_000;

const SESSION_FILE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;
const SESSION_DIR = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function gitRemote(cwd: string): Promise<{ remote?: string }> {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      resolve(err ? {} : { remote: stdout.trim() || undefined });
    });
  });
}

/** repl.files pages of ≤REPL_FILES_PAGE entries; `final` on the last (one empty final page for no files). */
export function filesPages<T>(all: T[]): Array<{ files: T[]; final: boolean }> {
  const pages: Array<{ files: T[]; final: boolean }> = [];
  for (let i = 0; i === 0 || i < all.length; i += REPL_FILES_PAGE) pages.push({ files: all.slice(i, i + REPL_FILES_PAGE), final: i + REPL_FILES_PAGE >= all.length });
  return pages;
}

export class Replicator {
  private readonly files = new Map<string, FileState>();
  private readonly cursors = new Map<string, Cursor>();
  /** Sessions this agent runs: sent first, no rate limit, polled every tick. */
  private readonly priority = new Map<string, number | null>();
  /** Side files the hub acked, as `<session>/<relPath>:<sha256>`. */
  private readonly sideSent = new Set<string>();
  /** Per side file: last seen size/mtime, its mark, retry schedule, refusal. */
  private readonly sideSeen = new Map<string, { size: number; mtimeMs: number; mark: string | null; nextAt: number; delay: number; rejected: boolean }>();
  private cronMarkers = new Set<string>();
  /** subagents/agent-<id>.meta.json by relPath (1.3, change `subagents` S5): what was sent last. */
  private hubProtocol: string = PROTOCOL_VERSION;
  private readonly metaSeen = new Map<string, { abs: string; sessionId: string; agentId: string; size: number; mtimeMs: number; sent: boolean }>();
  private connected = false;
  private filesListSent = false;
  private timers: NodeJS.Timeout[] = [];
  private watcher: FSWatcher | null = null;
  private busy = false;
  private tokens: number;
  private lastRefill: number;
  private walked = false;
  private readonly windows: boolean;

  constructor(private readonly d: ReplicatorDeps) {
    this.windows = d.windows ?? WIN;
    this.tokens = d.maxBytesPerSec;
    this.lastRefill = this.now();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private key(relPath: string): string {
    return fileKey(relPath, this.windows);
  }

  async start(): Promise<void> {
    await this.loadState();
    await this.walk();
    if (this.d.watch !== false) {
      try {
        // The long path: libuv after 1.51 keeps the watched folder as given, and an 8.3 one (TEMP of C:\Users\IVOLYN~1) aborts the
        // process on the first event — the long name of the file does not start with it (libuv#5010, fs-event.c assert, fixed by #5152).
        this.watcher = watch(realpathSync.native(this.d.projectsDir), { recursive: true }, (_ev, name) => {
          if (name) void this.touch(String(name));
        });
        this.watcher.on('error', err => this.d.log.warn('transcript watch failed', { error: err.message }));
      } catch (err) {
        this.d.log.warn('fs.watch unavailable, relying on the periodic walk', { error: (err as Error).message });
      }
    }
    this.timers.push(setInterval(() => void this.tick(), this.d.pollMs ?? 250));
    this.timers.push(setInterval(() => void this.walk(), this.d.walkMs ?? 60_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.watcher?.close();
    this.watcher = null;
  }

  // ---------- hub connection ----------

  /**
   * welcome: the hub's cursors replace local positions; the transcript list follows in repl.files pages. `hubProtocol` —
   * the hub's version: repl.agent_meta goes only to a hub of 1.3 or later.
   */
  onWelcome(cursors: Array<{ relPath: string } & Cursor>, hubProtocol: string = PROTOCOL_VERSION): void {
    this.connected = true;
    this.hubProtocol = hubProtocol;
    this.cursors.clear();
    for (const c of cursors) this.cursors.set(this.key(c.relPath), { generation: c.generation, ackedLine: c.ackedLine, ackedByte: c.ackedByte });
    for (const [k, f] of this.files) {
      f.cursor = this.cursors.get(k) ?? { generation: 0, ackedLine: 0, ackedByte: 0 };
      f.inflight = false;
    }
    this.filesListSent = false;
    if (this.walked) this.sendFilesList();
    // meta.json changed within 24 h go again (the hub keeps no cursor of them), and any not sent yet (a hub before 1.3)
    const since = this.now() - 24 * 3600_000;
    for (const [rel, m] of this.metaSeen) {
      if (m.sent && m.mtimeMs < since) continue;
      m.sent = false;
      void this.agentMeta(rel, m.abs, m.sessionId, `agent-${m.agentId}.meta.json`);
    }
  }

  /**
   * repl.agent_meta (1.3, change `subagents` S5): `subagents/agent-<agentId>.meta.json` when it appears or changes (by
   * size and mtime). Over AGENT_META_LIMIT bytes: logged, not sent. Not connected: sent after the next welcome.
   */
  private async agentMeta(rel: string, abs: string, sessionId: string, name: string): Promise<void> {
    const agentId = name.replace(/\.meta\.json$/, '').replace(/^agent-/, '');
    if (!/^[\w-]{1,128}$/.test(agentId)) return;
    let st;
    try {
      st = await stat(abs);
    } catch {
      return;
    }
    const seen = this.metaSeen.get(rel);
    if (seen && seen.sent && seen.size === st.size && seen.mtimeMs === st.mtimeMs) return;
    const entry = { abs, sessionId, agentId, size: st.size, mtimeMs: st.mtimeMs, sent: false };
    this.metaSeen.set(rel, entry);
    if (st.size > AGENT_META_LIMIT) {
      this.d.log.warn('subagent meta.json over the limit, not sent', { relPath: rel, size: st.size });
      entry.sent = true;
      return;
    }
    // a hub before 1.3 would only log the unknown type: kept unsent for the welcome of an updated hub (review p. 5)
    if (!this.connected || !protocolAtLeast(this.hubProtocol, 1, 3)) return;
    let meta: unknown;
    try {
      meta = JSON.parse(await readFile(abs, 'utf8'));
    } catch {
      return; // being written: the next change event reads it again
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
    if (this.d.send('repl.agent_meta', { sessionId, relPath: rel, agentId, meta })) entry.sent = true;
  }

  onDisconnected(): void {
    this.connected = false;
    for (const f of this.files.values()) f.inflight = false;
  }

  onAck(a: { relPath: string } & Cursor): void {
    const k = this.key(a.relPath);
    const c = { generation: a.generation, ackedLine: a.ackedLine, ackedByte: a.ackedByte };
    this.cursors.set(k, c);
    const f = this.files.get(k);
    if (!f) return;
    f.cursor = c;
    f.inflight = false;
  }

  /** D4: the list of transcripts in pages of ≤5000 after welcome (hello.files stays empty). */
  private sendFilesList(): void {
    if (this.filesListSent || !this.connected) return;
    const all = [...this.files.values()].filter(f => f.size >= 0).map(f => ({ relPath: f.relPath, size: f.size, mtimeMs: f.mtimeMs }));
    for (const page of filesPages(all)) if (!this.d.send('repl.files', page)) return;
    this.filesListSent = true;
  }

  // ---------- sessions this agent runs ----------

  /**
   * A session started or resumed here: its .jsonl goes first. Claude Code writes it into an existing project
   * directory whatever its case (c--Users-… made by the desktop app), so the directory is looked up case-insensitively.
   */
  async follow(sessionId: string, cwd: string): Promise<void> {
    this.priority.set(sessionId, null);
    const dir = await this.projectDirFor(cwd);
    const rel = `${dir}/${sessionId}.jsonl`;
    if (!this.files.has(this.key(rel))) this.track(rel, join(this.d.projectsDir, dir, `${sessionId}.jsonl`), sessionId, 'main');
  }

  /** agent-providers D4: a session whose transcript lives in a fixed folder (the mirrors of Codex) goes first. */
  followIn(sessionId: string, dir: string): void {
    this.priority.set(sessionId, null);
    const rel = `${dir}/${sessionId}.jsonl`;
    if (!this.files.has(this.key(rel))) this.track(rel, join(this.d.projectsDir, dir, `${sessionId}.jsonl`), sessionId, 'main');
  }

  /** The process ended: still first for a minute (the last lines). */
  release(sessionId: string): void {
    if (this.priority.has(sessionId)) this.priority.set(sessionId, this.now() + 60_000);
  }

  /** Existing project directory for cwd (case-insensitive), or enc(cwd). */
  async projectDirFor(cwd: string): Promise<string> {
    const enc = encodeCwd(cwd);
    try {
      const names = await readdir(this.d.projectsDir);
      return names.find(n => n.toLowerCase() === enc.toLowerCase()) ?? enc;
    } catch {
      return enc;
    }
  }

  // ---------- discovery ----------

  private track(relPath: string, abs: string, sessionId: string, kind: 'main' | 'subagent', agentId?: string): FileState {
    const k = this.key(relPath);
    let f = this.files.get(k);
    if (!f) {
      f = {
        relPath,
        abs,
        sessionId,
        kind,
        ...(agentId ? { agentId } : {}),
        size: -1,
        mtimeMs: 0,
        cursor: this.cursors.get(k) ?? { generation: 0, ackedLine: 0, ackedByte: 0 },
        inflight: false,
        inflightAt: 0,
        metaSent: false,
      };
      this.files.set(k, f);
    } else if (f.relPath !== relPath) {
      // Same file under another case (Windows): the name on disk wins.
      f.relPath = relPath;
      f.abs = abs;
    }
    return f;
  }

  /** Full walk of ~/.claude/projects: new and changed files, side files, cron markers. Public for tests. */
  async walk(): Promise<void> {
    let dirs: string[];
    try {
      dirs = (await readdir(this.d.projectsDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      let entries;
      try {
        entries = await readdir(join(this.d.projectsDir, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const m = e.isFile() ? SESSION_FILE.exec(e.name) : null;
        if (m) {
          await this.refresh(this.track(`${dir}/${e.name}`, join(this.d.projectsDir, dir, e.name), m[1]!, 'main'));
        } else if (e.isDirectory() && SESSION_DIR.test(e.name)) {
          await this.walkSessionDir(dir, e.name);
        }
      }
    }
    await this.loadCronMarkers();
    this.walked = true;
    this.sendFilesList();
  }

  private async walkSessionDir(dir: string, sid: string): Promise<void> {
    const base = join(this.d.projectsDir, dir, sid);
    try {
      for (const name of await readdir(join(base, 'subagents'))) {
        if (name.endsWith('.meta.json')) {
          await this.agentMeta(`${dir}/${sid}/subagents/${name}`, join(base, 'subagents', name), sid, name);
          continue;
        }
        if (!name.endsWith('.jsonl')) continue;
        const rel = `${dir}/${sid}/subagents/${name}`;
        await this.refresh(this.track(rel, join(base, 'subagents', name), sid, 'subagent', name.replace(/\.jsonl$/, '')));
      }
    } catch {
      // no subagents
    }
    if (this.d.sendBinary) {
      try {
        for (const name of await readdir(join(base, 'tool-results'))) await this.sideFile(sid, join(base, 'tool-results', name), `tool-results/${name}`);
      } catch {
        // no side files
      }
    }
  }

  /** fs.watch reported a path relative to projectsDir. */
  private async touch(name: string): Promise<void> {
    const rel = name.replaceAll('\\', '/');
    const parts = rel.split('/');
    if (parts.length === 2 && SESSION_FILE.test(parts[1]!)) {
      await this.refresh(this.track(rel, join(this.d.projectsDir, ...parts), SESSION_FILE.exec(parts[1]!)![1]!, 'main'));
    } else if (parts.length === 4 && parts[2] === 'subagents' && parts[3]!.endsWith('.jsonl')) {
      await this.refresh(this.track(rel, join(this.d.projectsDir, ...parts), parts[1]!, 'subagent', parts[3]!.replace(/\.jsonl$/, '')));
    } else if (parts.length === 4 && parts[2] === 'subagents' && parts[3]!.endsWith('.meta.json')) {
      await this.agentMeta(rel, join(this.d.projectsDir, ...parts), parts[1]!, parts[3]!);
    } else if (parts.length === 4 && parts[2] === 'tool-results' && this.d.sendBinary) {
      await this.sideFile(parts[1]!, join(this.d.projectsDir, ...parts), `tool-results/${parts[3]}`);
    }
  }

  private async refresh(f: FileState): Promise<void> {
    try {
      const st = await stat(f.abs);
      f.size = st.size;
      f.mtimeMs = st.mtimeMs;
    } catch {
      f.size = -1;
    }
  }

  // ---------- sending ----------

  /** One pass: stat followed sessions, then send chunks by priority within the rate limit. Public for tests. */
  async tick(): Promise<void> {
    if (this.busy || !this.connected) return;
    this.busy = true;
    try {
      const now = this.now();
      this.refill(now);
      for (const [sid, until] of this.priority) if (until !== null && now > until) this.priority.delete(sid);
      const live = [...this.files.values()].filter(f => this.priority.has(f.sessionId));
      for (const f of live) await this.refresh(f);
      for (const f of this.files.values()) {
        if (f.inflight && now - f.inflightAt > (this.d.ackTimeoutMs ?? 30_000)) {
          this.d.log.warn('no repl.ack, sending the chunk again', { relPath: f.relPath });
          f.inflight = false;
        }
      }
      const pending = (f: FileState) => !f.inflight && f.size >= 0 && f.size !== f.cursor.ackedByte;
      for (const f of live.filter(pending)) await this.pump(f, now, false);
      // History: freshest first, a few files at a time, within the byte budget.
      let inflight = [...this.files.values()].filter(f => f.inflight && !this.priority.has(f.sessionId)).length;
      const history = [...this.files.values()].filter(f => !this.priority.has(f.sessionId) && pending(f)).sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const f of history) {
        if (inflight >= (this.d.maxInflight ?? 8) || this.tokens <= 0) break;
        if (await this.pump(f, now, true)) inflight++;
      }
    } catch (err) {
      this.d.log.warn('replication pass failed', { error: (err as Error).message });
    } finally {
      this.busy = false;
    }
  }

  private refill(now: number): void {
    const dt = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.d.maxBytesPerSec, this.tokens + dt * this.d.maxBytesPerSec);
  }

  /** Sends the next chunk of a file; true if something was sent. */
  private async pump(f: FileState, now: number, limited: boolean): Promise<boolean> {
    let rewrite = false;
    if (f.size < f.cursor.ackedByte) {
      // Truncated or replaced: the hub drops the previous generation.
      f.cursor = { generation: f.cursor.generation + 1, ackedLine: 0, ackedByte: 0 };
      rewrite = true;
    }
    let chunk;
    try {
      chunk = await readLines(f.abs, f.cursor.ackedByte, f.size);
    } catch {
      return false;
    }
    if (!chunk || (chunk.lines.length === 0 && !rewrite)) return false;
    if (chunk.skipped) this.d.log.warn('line longer than the limit replaced by a marker', { relPath: f.relPath, bytes: chunk.skipped });
    const sent = this.d.send('repl.chunk', {
      relPath: f.relPath,
      kind: f.kind,
      sessionId: f.sessionId,
      ...(f.agentId ? { agentId: f.agentId } : {}),
      generation: f.cursor.generation,
      fromLine: f.cursor.ackedLine,
      fromByte: f.cursor.ackedByte,
      lines: chunk.lines,
      endByte: chunk.endByte,
      ...(rewrite ? { rewrite: true } : {}),
    });
    if (!sent) return false;
    f.inflight = true;
    f.inflightAt = now;
    if (limited) this.tokens -= chunk.endByte - f.cursor.ackedByte;
    if (f.kind === 'main' && !f.metaSent) void this.sendMeta(f, chunk.lines);
    return true;
  }

  /** repl.meta: cwd and git branch from the lines, git remote of the directory, cron marker (D5). */
  private async sendMeta(f: FileState, lines: string[]): Promise<void> {
    let cwd: string | undefined;
    let branch: string | undefined;
    for (const l of lines) {
      if (!l.includes('"cwd"')) continue;
      try {
        const o = JSON.parse(l) as { cwd?: unknown; gitBranch?: unknown };
        if (typeof o.cwd === 'string') {
          cwd = o.cwd;
          if (typeof o.gitBranch === 'string' && o.gitBranch) branch = o.gitBranch;
          break;
        }
      } catch {
        // not JSON
      }
    }
    if (!cwd) return;
    f.metaSent = true;
    // A cron run writes its marker at SessionStart, a moment before its first line: re-read the file now, the walk
    // (every 60 s) would come after this one-time meta (task 3.7).
    if (!this.cronMarkers.has(f.sessionId.toLowerCase())) await this.loadCronMarkers();
    const git = await (this.d.gitInfo ?? gitRemote)(cwd).catch(() => ({}) as { remote?: string });
    this.d.send('repl.meta', {
      sessionId: f.sessionId,
      cwd,
      // Never a token of the remote URL to the hub (D9 p. 7).
      ...(git.remote ? { gitRemote: stripRemoteUserinfo(git.remote) } : {}),
      ...(branch ? { gitBranch: branch } : {}),
      ...(this.cronMarkers.has(f.sessionId.toLowerCase()) ? { cronMarker: true } : {}),
    });
  }

  private async loadCronMarkers(): Promise<void> {
    if (!this.d.cronMarkersFile) return;
    try {
      const text = await readFile(this.d.cronMarkersFile, 'utf8');
      this.cronMarkers = new Set(
        text
          .split(/\r?\n/)
          .map(s => s.trim().toLowerCase())
          .filter(Boolean),
      );
    } catch {
      // no markers
    }
  }

  // ---------- side files (tool-results) ----------

  private async sideFile(sessionId: string, abs: string, relPath: string): Promise<void> {
    if (!this.connected || !this.d.sendBinary) return;
    let st;
    try {
      st = await stat(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > 32 * 1024 * 1024) return;
    // Decided by name + size + mtime before reading and hashing: acked, refused by the hub, or waiting for its turn.
    const id = `${sessionId}/${relPath}`;
    let state = this.sideSeen.get(id);
    if (!state || state.size !== st.size || state.mtimeMs !== st.mtimeMs) {
      state = { size: st.size, mtimeMs: st.mtimeMs, mark: null, nextAt: 0, delay: SIDE_RETRY_MIN_MS, rejected: false };
      this.sideSeen.set(id, state);
    }
    if (state.rejected || (state.mark && this.sideSent.has(state.mark)) || this.now() < state.nextAt || this.tokens <= 0) return;
    const data = await readFile(abs);
    const sha256 = createHash('sha256').update(data).digest('hex');
    state.mark = `${id}:${sha256}`;
    if (this.sideSent.has(state.mark)) return;
    if (!this.d.send('side.file', { sessionId, relPath, sha256, size: data.length })) return;
    if (!this.d.sendBinary(data)) return;
    this.tokens -= data.length;
    // No side.ack yet: offered again after 60 s, then 2 min, 4 min… up to 30 min.
    state.nextAt = this.now() + state.delay;
    state.delay = Math.min(state.delay * 2, SIDE_RETRY_MAX_MS);
  }

  /** side.reject: the hub will never take this version of the file. */
  onSideReject(a: { sessionId: string; relPath: string; sha256: string }): void {
    const state = this.sideSeen.get(`${a.sessionId}/${a.relPath}`);
    if (state && state.mark === `${a.sessionId}/${a.relPath}:${a.sha256}`) state.rejected = true;
    this.d.log.warn('side file refused by the hub', { relPath: a.relPath });
  }

  /** side.ack: the hub stored the file; only now it counts as sent (a lost frame is offered again). */
  onSideAck(a: { sessionId: string; relPath: string; sha256: string }): void {
    this.sideSent.add(`${a.sessionId}/${a.relPath}:${a.sha256}`);
    void this.saveState();
  }

  private stateFile(): string | null {
    return this.d.stateDir ? join(this.d.stateDir, 'replication-state.json') : null;
  }

  private async loadState(): Promise<void> {
    const p = this.stateFile();
    if (!p) return;
    try {
      const s = JSON.parse(await readFile(p, 'utf8')) as { sideSent?: string[] };
      for (const m of s.sideSent ?? []) this.sideSent.add(m);
    } catch {
      // first run
    }
  }

  private saving: Promise<void> | null = null;
  private async saveState(): Promise<void> {
    const p = this.stateFile();
    if (!p || this.saving) return;
    this.saving = (async () => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify({ sideSent: [...this.sideSent] }));
    })()
      .catch(() => undefined)
      .finally(() => (this.saving = null));
  }

  /** For tests and logs. */
  get stats(): { files: number; pending: number } {
    const pending = [...this.files.values()].filter(f => f.size >= 0 && f.size !== f.cursor.ackedByte).length;
    return { files: this.files.size, pending };
  }
}
