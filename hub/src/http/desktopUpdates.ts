// Update feed of the desktop app (change desktop-app, Requirement: Автообновление, design.md D15): electron-updater
// `generic` provider reads <PUBLIC_URL>/api/desktop/updates/<file> with the ah_session cookie (/api/* guard → 401).
// Change desktop-download: /api/desktop/info and /api/desktop/download — the installer of the feed under a name tagged
// with the hub host, which the installed app reads to connect to this hub (Requirement: Установщик на хабе).
// Change desktop-platforms: the same for Linux (AppImage) and macOS (dmg, not served by the feed — the app does not self-update there).
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { DESKTOP_PLATFORMS, type DesktopDownload, type DesktopInfo, type DesktopPlatform } from '@agent-hub/shared';

/** The feed files of the self-updating platforms; the dmg is not served by the feed. Nothing else leaves the directory. */
export const DESKTOP_UPDATE_FILE = /^(latest\.yml|latest-linux\.yml|Agent-Hub-Setup-\d+\.\d+\.\d+\.exe(\.blockmap)?|Agent-Hub-\d+\.\d+\.\d+\.AppImage(\.blockmap)?)$/;

const INSTALLER_FILE = /^Agent-Hub-Setup-(\d+\.\d+\.\d+)\.exe$/;

/** Installer file of a platform for a version; the extension is the one the tag goes before. */
const INSTALLER_NAME: Record<DesktopPlatform, (version: string) => { base: string; ext: string }> = {
  win: version => ({ base: `Agent-Hub-Setup-${version}`, ext: 'exe' }),
  linux: version => ({ base: `Agent-Hub-${version}`, ext: 'AppImage' }),
  mac: version => ({ base: `Agent-Hub-${version}`, ext: 'dmg' }),
};

interface FeedInstaller {
  version: string;
  path: string;
  size: number;
  /** Files of the other platforms found next to latest.yml (the Windows one is `path`). */
  others: { platform: DesktopPlatform; path: string; size: number }[];
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

/**
 * The download name. Windows and Linux carry the hub tag (the app reads it, D4–D5 of desktop-platforms); the dmg does not —
 * the macOS app does not know the path of the dmg it was installed from and connects through the `agenthub://connect` link.
 */
export function taggedInstallerName(version: string, publicUrl: string, platform: DesktopPlatform = 'win'): string {
  const { base, ext } = INSTALLER_NAME[platform](version);
  return platform === 'mac' ? `${base}.${ext}` : `${base} [${hubTag(publicUrl)}].${ext}`;
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
  const others: FeedInstaller['others'] = [];
  for (const platform of DESKTOP_PLATFORMS) {
    if (platform === 'win') continue;
    const { base, ext } = INSTALLER_NAME[platform](latest.version);
    const path = `${base}.${ext}`;
    const found = await stat(join(dir, path)).catch(() => null);
    if (found?.isFile()) others.push({ platform, path, size: found.size });
  }
  return { version: latest.version, path: latest.path, size: st.size, others };
}

function downloadsOf(installer: FeedInstaller, publicUrl: string): DesktopDownload[] {
  const win: DesktopDownload = { platform: 'win', size: installer.size, fileName: taggedInstallerName(installer.version, publicUrl) };
  const others = installer.others.map(o => ({ platform: o.platform, size: o.size, fileName: taggedInstallerName(installer.version, publicUrl, o.platform) }));
  return [win, ...others];
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
      const downloads = downloadsOf(installer, publicUrlOf(req));
      return { available: true, version: installer.version, size: installer.size, fileName: downloads[0]!.fileName, downloads };
    });

    scope.get('/api/desktop/download', async (req, reply) => {
      const platform = (req.query as { platform?: string }).platform ?? 'win';
      if (!DESKTOP_PLATFORMS.some(p => p === platform)) return reply.code(404).send({ error: 'not_found' });
      const installer = await feedInstaller(dir);
      if (!dir || !installer) return reply.code(404).send({ error: 'not_found' });
      const target = installer.others.find(o => o.platform === platform);
      const file = platform === 'win' ? { path: installer.path, size: installer.size } : target;
      if (!file) return reply.code(404).send({ error: 'not_found' });
      const fileName = taggedInstallerName(installer.version, publicUrlOf(req), platform as DesktopPlatform);
      // The tag is ASCII (a host name), the plain filename is enough; filename* is there for clients that prefer it.
      reply.header('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(file.size));
      reply.header('Cache-Control', 'private, no-cache');
      return reply.send(createReadStream(join(dir, file.path)));
    });
  });
}
