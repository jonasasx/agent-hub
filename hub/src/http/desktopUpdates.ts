// Update feed of the desktop app (change desktop-app, Requirement: Автообновление, design.md D15): electron-updater
// `generic` provider reads <PUBLIC_URL>/api/desktop/updates/<file> with the ah_session cookie (/api/* guard → 401).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/** latest.yml or Agent-Hub-Setup-<semver>.exe[.blockmap]; nothing else leaves the feed directory. */
export const DESKTOP_UPDATE_FILE = /^(latest\.yml|Agent-Hub-Setup-\d+\.\d+\.\d+\.exe(\.blockmap)?)$/;

export async function registerDesktopUpdates(app: FastifyInstance, deps: { dir: string | undefined }): Promise<void> {
  const { dir } = deps;
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
  });
}
