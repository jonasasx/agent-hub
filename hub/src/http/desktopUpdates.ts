// Update feed of the desktop app (change desktop-app, Requirement: Автообновление, design.md D15): electron-updater
// `generic` provider reads <PUBLIC_URL>/api/desktop/updates/<file> with the ah_session cookie (/api/* guard → 401).
// Change desktop-download: /api/desktop/info and /api/desktop/download — the installer of the feed under a name tagged
// with the hub host, which the installed app reads to connect to this hub (Requirement: Установщик на хабе).
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { DesktopInfo } from '@agent-hub/shared';

/** latest.yml or Agent-Hub-Setup-<semver>.exe[.blockmap]; nothing else leaves the feed directory. */
export const DESKTOP_UPDATE_FILE = /^(latest\.yml|Agent-Hub-Setup-\d+\.\d+\.\d+\.exe(\.blockmap)?)$/;

const INSTALLER_FILE = /^Agent-Hub-Setup-(\d+\.\d+\.\d+)\.exe$/;

interface FeedInstaller {
  version: string;
  path: string;
  size: number;
}

/** `version:` and `path:` of latest.yml (electron-builder writes them as top-level scalars). */
export function parseLatestYml(text: string): { version: string; path: string } | null {
  const field = (name: string) => new RegExp(`^${name}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm').exec(text)?.[1];
  const version = field('version');
  const path = field('path');
  if (!version || !path) return null;
  return { version, path };
}

/**
 * The tag of the file name (D1): the host of the public address, `_<port>` for a non-default port — `:` is not
 * allowed in a Windows file name.
 */
export function hubTag(publicUrl: string): string {
  const u = new URL(publicUrl);
  return u.port ? `${u.hostname}_${u.port}` : u.hostname;
}

export function taggedInstallerName(version: string, publicUrl: string): string {
  return `Agent-Hub-Setup-${version} [${hubTag(publicUrl)}].exe`;
}

async function feedInstaller(dir: string | undefined): Promise<FeedInstaller | null> {
  if (!dir) return null;
  const text = await readFile(join(dir, 'latest.yml'), 'utf8').catch(() => null);
  if (text === null) return null;
  const latest = parseLatestYml(text);
  const m = latest ? INSTALLER_FILE.exec(latest.path) : null;
  if (!latest || !m || m[1] !== latest.version) return null;
  const st = await stat(join(dir, latest.path)).catch(() => null);
  if (!st?.isFile()) return null;
  return { version: latest.version, path: latest.path, size: st.size };
}

export async function registerDesktopUpdates(app: FastifyInstance, deps: { dir: string | undefined; publicUrlOf: (req: FastifyRequest) => string }): Promise<void> {
  const { dir, publicUrlOf } = deps;
  // Own encapsulated context: reply.sendFile here is rooted at the feed directory and does not clash with the web
  // static plugin of the root context.
  await app.register(async scope => {
    if (dir) await scope.register(fastifyStatic, { root: dir, serve: false, cacheControl: false, decorateReply: true });
    scope.get('/api/desktop/updates/:file', async (req, reply) => {
      const file = (req.params as { file: string }).file;
      if (!dir || !DESKTOP_UPDATE_FILE.test(file)) return reply.code(404).send({ error: 'not_found' });
      const st = await stat(join(dir, file)).catch(() => null);
      if (!st?.isFile()) return reply.code(404).send({ error: 'not_found' });
      reply.header('Cache-Control', file === 'latest.yml' ? 'no-cache' : 'private, max-age=31536000, immutable');
      // Range (206) for the blockmap-based differential download comes from @fastify/static.
      return reply.sendFile(file);
    });

    scope.get('/api/desktop/info', async (req, reply): Promise<DesktopInfo> => {
      reply.header('Cache-Control', 'no-cache');
      const installer = await feedInstaller(dir);
      if (!installer) return { available: false };
      const fileName = taggedInstallerName(installer.version, publicUrlOf(req));
      return { available: true, version: installer.version, size: installer.size, fileName };
    });

    scope.get('/api/desktop/download', async (req, reply) => {
      const installer = await feedInstaller(dir);
      if (!dir || !installer) return reply.code(404).send({ error: 'not_found' });
      const fileName = taggedInstallerName(installer.version, publicUrlOf(req));
      // The tag is ASCII (a host name), the plain filename is enough; filename* is there for clients that prefer it.
      reply.header('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(installer.size));
      reply.header('Cache-Control', 'private, no-cache');
      return reply.send(createReadStream(join(dir, installer.path)));
    });
  });
}
