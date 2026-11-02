// CODEX_HOME per subscription (change provider-parity, design D2, D4): a Codex subscription is the auth.json of a
// ChatGPT sign-in. Each subscription gets its own home under the agent's state dir; `sessions` is a link to the
// machine's ~/.codex/sessions, so a thread started under one subscription resumes under another; config.toml is a copy
// of the machine's. The tokens rotate: the file is read back and the hub gets the new one.
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
}

export class CodexHomes {
  /** What the hub knows per subscription: the last auth.json it stored or sent. */
  private readonly known = new Map<string, string>();

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
    // the hub's copy differs from the last one this agent knew
    if (this.known.get(subscriptionId) !== authJson) {
      // after a restart (or a write-back the hub never got) the file on disk may be newer than the hub's copy:
      // keep it, changed() sends it again
      if (!(await this.diskIsNewer(home, authJson))) await writeFile(join(home, 'auth.json'), authJson, { mode: 0o600 });
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

  private async diskIsNewer(home: string, hubJson: string): Promise<boolean> {
    try {
      const at = (j: string): number => Date.parse((JSON.parse(j) as { last_refresh?: string }).last_refresh ?? '');
      const disk = at(await readFile(join(home, 'auth.json'), 'utf8'));
      return disk > at(hubJson);
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

  /** A subscription removed from the registry or its credential replaced: forget the home. */
  async forget(subscriptionId: string): Promise<void> {
    this.known.delete(subscriptionId);
    await rm(join(this.root, subscriptionId), { recursive: true, force: true }).catch(() => undefined);
  }

  private async link(home: string, sessions = true, registryEnabled = false): Promise<void> {
    const cfg = join(this.base, 'config.toml');
    if (existsSync(cfg)) {
      const target = join(home, 'config.toml');
      if (!registryEnabled) {
        await copyFile(cfg, target).catch(() => undefined);
      } else {
        try {
          const source = await readFile(cfg, 'utf8');
          await writeFile(target, stripMcpServers(source), { mode: 0o600 });
        } catch (error) {
          this.warnConfigCopy('Codex registry config isolation failed; copying source config', error);
          await copyFile(cfg, target).catch(copyError => {
            this.warnConfigCopy('Codex config fallback copy failed', copyError);
          });
        }
      }
    }
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
