// CODEX_HOME per subscription (change provider-parity, design D2, D4): a Codex subscription is the auth.json of a
// ChatGPT sign-in. Each subscription gets its own home under the agent's state dir; `sessions` is a link to the
// machine's ~/.codex/sessions, so a thread started under one subscription resumes under another; config.toml is a copy
// of the machine's. The tokens rotate: the file is read back and the hub gets the new one.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../log.js';

export interface CodexHomesDeps {
  /** ~/.agent-hub */
  stateDir: string;
  /** The machine's own ~/.codex (tests: a temp folder). */
  baseHome?: string;
  log?: Pick<Logger, 'warn'>;
  now?: () => number;
}

/** The folder name of a subscription home: the subscription id. Temporary sign-in homes are `login-*`. */
const HOME_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CodexHomes {
  /** What the hub knows per subscription: the last auth.json it stored or sent. */
  private readonly known = new Map<string, string>();
  /** provider-parity R3: homes the hub dropped while a live session ran under them; removed when it exits. */
  private readonly deferred = new Set<string>();

  constructor(private readonly d: CodexHomesDeps) {}

  private get base(): string {
    return this.d.baseHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  }

  private get root(): string {
    return join(this.d.stateDir, 'codex-homes');
  }

  /** The folder of a subscription, ready to run under: auth.json written, sessions linked, config.toml copied. */
  async prepare(subscriptionId: string, authJson: string, registryEnabled = false): Promise<string> {
    const home = join(this.root, subscriptionId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await this.link(home, true, registryEnabled);
    // the hub is the source of truth, but a file refreshed by a live process is newer: it is replaced only when
    // the hub's copy differs from the last one this agent knew, or when the file is gone (codex-auth-restore: removed
    // between turns, or empty/broken — the memory of a written file says nothing about the disk)
    const missing = !(await this.hasAuth(home));
    if (missing || this.known.get(subscriptionId) !== authJson) {
      // after a restart (or a write-back the hub never got) the file on disk may be newer than the hub's copy:
      // keep it, changed() sends it again
      if (missing || !(await this.diskIsNewer(home, authJson))) await writeFile(join(home, 'auth.json'), authJson, { mode: 0o600 });
      this.known.set(subscriptionId, authJson);
    }
    return home;
  }

  /** A fresh auth.json when the CLI rotated the tokens since the last call; null — unchanged or unreadable. */
  async changed(subscriptionId: string): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(join(this.root, subscriptionId, 'auth.json'), 'utf8');
    } catch {
      return null;
    }
    if (!text || text === this.known.get(subscriptionId)) return null;
    try {
      JSON.parse(text);
    } catch {
      return null;
    }
    return text;
  }

  /** The hub took the auth.json that changed() returned. Until then it is returned again. */
  confirm(subscriptionId: string, authJson: string): void {
    this.known.set(subscriptionId, authJson);
  }

  /** The home has an auth.json: false only when it is absent, empty or not JSON — another read error is not a loss. */
  private async hasAuth(home: string): Promise<boolean> {
    const state = async (): Promise<'ok' | 'absent' | 'broken'> => {
      try {
        JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
        return 'ok';
      } catch (error) {
        if (error instanceof SyntaxError) return 'broken';
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'ok';
      }
    };
    const first = await state();
    if (first !== 'broken') return first === 'ok';
    // a live Codex process of the same subscription may be rewriting the file: look again before replacing it
    await new Promise(resolve => setTimeout(resolve, 200));
    return (await state()) === 'ok';
  }

  /** The file on disk is a later refresh of the same ChatGPT account (R3: after a re-login to another account the hub's copy wins). */
  private async diskIsNewer(home: string, hubJson: string): Promise<boolean> {
    try {
      const disk = authInfo(await readFile(join(home, 'auth.json'), 'utf8'));
      const hub = authInfo(hubJson);
      // another account on disk loses; a file without an account id on both sides compares by time as before
      if (disk.accountId !== hub.accountId) return false;
      return disk.refreshedAt > hub.refreshedAt;
    } catch {
      return false;
    }
  }

  /** A temporary home for a device-code sign-in: the result is read with takeLogin and the folder removed. */
  async tempHome(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const home = await mkdtemp(join(this.root, 'login-'));
    await this.link(home, false);
    return home;
  }

  async takeLogin(home: string): Promise<string | null> {
    try {
      const text = await readFile(join(home, 'auth.json'), 'utf8');
      JSON.parse(text);
      return text;
    } catch {
      return null;
    } finally {
      await this.dropTemp(home);
    }
  }

  async dropTemp(home: string): Promise<void> {
    if (!home.startsWith(this.root)) return;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }

  /** A subscription removed from the registry: forget the home. The `sessions` link is removed, not its target. */
  async forget(subscriptionId: string): Promise<void> {
    this.known.delete(subscriptionId);
    this.deferred.delete(subscriptionId);
    await rm(join(this.root, subscriptionId), { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * provider.credentials.sync (provider-parity R3): every subscription home not in `keep` is removed, of the ones in
   * `forget` (credential replaced) only the auth.json. A home a live session runs under (`busy`) waits for release().
   */
  async sync(keep: string[], forget: string[], busy: (subscriptionId: string) => boolean): Promise<{ removed: string[]; deferred: string[] }> {
    const keepIds = new Set(keep.map(id => id.toLowerCase()));
    const out = { removed: [] as string[], deferred: [] as string[] };
    // brought back while a session was live: the home stays after release()
    for (const id of keepIds) this.deferred.delete(id);
    for (const id of forget) {
      const lower = id.toLowerCase();
      // a live session keeps its file; the next prepare() writes the hub copy, which is newer after a re-login
      if (!keepIds.has(lower) || busy(lower)) continue;
      this.known.delete(lower);
      await rm(join(this.root, lower, 'auth.json'), { force: true }).catch(() => undefined);
    }
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!HOME_NAME.test(name) || keepIds.has(name.toLowerCase())) continue;
      if (busy(name)) {
        this.deferred.add(name);
        out.deferred.push(name);
        continue;
      }
      await this.forget(name);
      out.removed.push(name);
    }
    return out;
  }

  /** The last live session under a subscription exited: a home the hub dropped meanwhile goes now. */
  async release(subscriptionId: string): Promise<boolean> {
    if (!this.deferred.has(subscriptionId)) return false;
    await this.forget(subscriptionId);
    return true;
  }

  /** At start (R6): temporary sign-in homes left by a crash, older than `maxAgeMs`. */
  async sweepTemp(maxAgeMs: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return 0;
    }
    const now = this.d.now?.() ?? Date.now();
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith('login-')) continue;
      const home = join(this.root, name);
      const at = await stat(home).then(
        st => st.mtimeMs,
        () => now,
      );
      if (now - at < maxAgeMs) continue;
      await this.dropTemp(home);
      removed++;
    }
    return removed;
  }

  private async link(home: string, sessions = true, registryEnabled = false): Promise<void> {
    // R12: the copy always keeps its credentials in auth.json — with keyring the CLI would take the machine's account
    const cfg = join(this.base, 'config.toml');
    let source = '';
    if (existsSync(cfg)) {
      try {
        source = await readFile(cfg, 'utf8');
      } catch (error) {
        this.warnConfigCopy('Codex config could not be read; the home gets the credential store only', error);
      }
    }
    const config = fileCredentialStore(registryEnabled ? stripMcpServers(source) : source);
    await writeFile(join(home, 'config.toml'), config, { mode: 0o600 }).catch(error => this.warnConfigCopy('Codex config copy failed', error));
    if (!sessions) return;
    const target = join(this.base, 'sessions');
    await mkdir(target, { recursive: true });
    const link = join(home, 'sessions');
    if (existsSync(link)) return;
    // a junction on Windows needs no privilege; 'dir' is ignored on POSIX
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  private warnConfigCopy(message: string, error: unknown): void {
    this.d.log?.warn(message, { error: error instanceof Error ? error.message : 'unknown file error' });
  }
}

/** The CLI's own fields of an auth.json: the ChatGPT account and the time of the last refresh. */
function authInfo(text: string): { accountId: string | null; refreshedAt: number } {
  const j = JSON.parse(text) as { last_refresh?: string; tokens?: { account_id?: unknown } };
  const accountId = typeof j.tokens?.account_id === 'string' ? j.tokens.account_id : null;
  return { accountId, refreshedAt: Date.parse(j.last_refresh ?? '') };
}

/** `cli_auth_credentials_store = "file"` as the first root key; any root-level value of it removed (R12). */
export function fileCredentialStore(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const kept: string[] = [];
  let rootTable = true;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) rootTable = false;
    if (rootTable && /^\s*cli_auth_credentials_store\s*=/.test(line)) continue;
    kept.push(line);
  }
  const rest = kept.join('\n').replace(/^\n+/, '');
  return `cli_auth_credentials_store = "file"\n${rest}`;
}

/** Drop the global Codex MCP tables from the isolated copy while preserving other preferences. */
export function stripMcpServers(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const kept: string[] = [];
  let dropping = false;
  let rootTable = true;
  let inlineTableDepth = 0;
  for (const line of lines) {
    const table = line.match(/^\s*\[+\s*([^\]]+)\s*\]+\s*(?:#.*)?$/);
    if (table) {
      rootTable = false;
      dropping = /^(?:mcp_servers)(?:\.|$)/.test(table[1]!.trim());
    }
    if (dropping) continue;
    if (inlineTableDepth > 0) {
      inlineTableDepth += tomlBraceDelta(line);
      if (inlineTableDepth < 0) inlineTableDepth = 0;
      continue;
    }
    if (rootTable && /^\s*mcp_servers\s*=\s*\{/.test(line)) {
      inlineTableDepth = tomlBraceDelta(line);
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

function tomlBraceDelta(line: string): number {
  let delta = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of line) {
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '#') break;
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') delta++;
    else if (char === '}') delta--;
  }
  return delta;
}
