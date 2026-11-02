// Change multi-user (design M5, task 5.4): the agent build served by the hub — /agent/latest.json, /agent/agent-<v>.tgz —
// and the installers /install.sh, /install.ps1 (templates of deploy/agent/ with __HUB_URL__ substituted).
// Requirement: Установщик; Самообновление агента.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AGENT_BUILD_FILE_RE, type AgentLatest } from '@agent-hub/shared';
import { versionLess } from './repo.js';

/** `agent-<semver>.tgz` (shared AGENT_BUILD_FILE_RE: the version names a directory on the machine). */
export const AGENT_FILE = AGENT_BUILD_FILE_RE;

export interface AgentBuildInfo extends AgentLatest {
  file: string;
}

/** Scans the build directory: the highest `agent-<version>.tgz` is the current build (SHA-256 computed here). */
export class AgentBuild {
  private current: AgentBuildInfo | null = null;
  private key = '';

  constructor(private readonly dir: string | null) {}

  get latest(): AgentBuildInfo | null {
    return this.current;
  }

  /** Re-reads the directory when its listing or the chosen file changed. Missing directory — no build. */
  async refresh(): Promise<AgentBuildInfo | null> {
    if (!this.dir) return (this.current = null);
    const names = await readdir(this.dir).catch(() => [] as string[]);
    let best: { file: string; version: string } | null = null;
    for (const n of names) {
      const m = AGENT_FILE.exec(n);
      if (m && (!best || versionLess(best.version, m[1]!))) best = { file: n, version: m[1]! };
    }
    if (!best) {
      this.key = '';
      return (this.current = null);
    }
    const st = await stat(join(this.dir, best.file)).catch(() => null);
    if (!st?.isFile()) return (this.current = null);
    const key = `${best.file}:${st.size}:${st.mtimeMs}`;
    if (key === this.key && this.current) return this.current;
    const sha256 = createHash('sha256')
      .update(await readFile(join(this.dir, best.file)))
      .digest('hex');
    this.key = key;
    this.current = { version: best.version, sha256, size: st.size, url: `/agent/${best.file}`, file: best.file };
    return this.current;
  }
}

/** The wss:// address of /ws/agent for PUBLIC_URL. */
export function agentWsUrl(publicUrl: string): string {
  const u = new URL(publicUrl);
  return `${u.protocol === 'http:' ? 'ws:' : 'wss:'}//${u.host}/ws/agent`;
}

export async function registerAgentDist(app: FastifyInstance, deps: { build: AgentBuild; dir: string | null; installersDir: string; publicUrl: string }): Promise<void> {
  const { build } = deps;

  app.get('/agent/latest.json', async (_req, reply) => {
    const b = await build.refresh();
    reply.header('Cache-Control', 'no-cache');
    if (!b) return reply.code(404).send({ error: 'not_found' });
    const body: AgentLatest = { version: b.version, sha256: b.sha256, url: b.url, size: b.size };
    return body;
  });

  app.get('/agent/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!deps.dir || !AGENT_FILE.test(file)) return reply.code(404).send({ error: 'not_found' });
    const path = join(deps.dir, file);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return reply.code(404).send({ error: 'not_found' });
    reply.header('Cache-Control', 'public, max-age=31536000, immutable').header('Content-Length', String(st.size));
    return reply.type('application/gzip').send(createReadStream(path));
  });

  // Installers: the template of deploy/agent/ with __HUB_URL__ → PUBLIC_URL (https, no trailing slash).
  const installer = (name: string, type: string) =>
    app.get(`/${name}`, async (_req, reply) => {
      const text = await readFile(join(deps.installersDir, name), 'utf8').catch(() => null);
      if (text === null) return reply.code(404).send({ error: 'not_found' });
      reply.header('Cache-Control', 'no-cache');
      // A BOM (install.ps1 is stored with one for Windows PowerShell 5.1) breaks `irm … | iex`: dropped when served.
      return reply.type(type).send(
        text
          .replace(/^\uFEFF/, '')
          .split('__HUB_URL__')
          .join(deps.publicUrl),
      );
    });
  installer('install.sh', 'text/x-shellscript; charset=utf-8');
  installer('install.ps1', 'text/plain; charset=utf-8');
}
