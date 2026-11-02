// Images and other blobs in the chat (design D19): GET /api/blobs/:sha256, POST /api/uploads,
// POST /api/sessions/:id/images, GET /agent-api/blobs/<token> for agents.
// Requirements (spec chat-images): Изображения агента в чате; Отправка изображений агенту.
import type { FastifyInstance } from 'fastify';
import { showImageRequestSchema, UPLOAD_LIMIT, type UploadResponse } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { ObjectStore } from '../storage/objectStore.js';
import { ImageError, storeImage } from '../storage/images.js';
import { findRunnerByToken } from '../runners/repo.js';
import { HttpError, type SessionService } from '../sessions/service.js';

const SHA = /^[0-9a-f]{64}$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'];

export function registerBlobs(app: FastifyInstance, deps: { db: Db; store: ObjectStore | undefined; sessions: SessionService }): void {
  const { db, store, sessions } = deps;

  const needStore = (): ObjectStore => {
    if (!store) throw new HttpError(503, 'storage_unavailable', 'Хранилище изображений не настроено');
    return store;
  };

  /** A blob of the user: immutable by content, cached forever, never sniffed or run by the browser. */
  app.get('/api/blobs/:sha256', async (req, reply) => {
    const { sha256 } = req.params as { sha256: string };
    if (!SHA.test(sha256)) throw new HttpError(404, 'not_found', 'Объект не найден');
    const own = await db
      .selectFrom('blob_owners')
      .innerJoin('blobs', 'blobs.sha256', 'blob_owners.sha256')
      .select(['blobs.mime', 'blobs.s3_key'])
      .where('blob_owners.sha256', '=', sha256)
      .where('blob_owners.user_id', '=', req.user!.id)
      .executeTakeFirst();
    if (!own) throw new HttpError(404, 'not_found', 'Объект не найден');
    const etag = `"${sha256}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const body = await needStore().get(own.s3_key);
    if (!body) throw new HttpError(404, 'not_found', 'Объект не найден в хранилище');
    // Not an image (text, PDF): shown as an attachment-free plain resource that cannot run anything.
    const image = own.mime.startsWith('image/') && own.mime !== 'image/svg+xml';
    return reply
      .type(image ? own.mime : own.mime.startsWith('text/') ? 'text/plain; charset=utf-8' : 'application/octet-stream')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', image || own.mime.startsWith('text/') ? 'inline' : 'attachment')
      .send(body);
  });

  // Raw image bytes are accepted by POST /api/uploads only: the parser lives in this encapsulated scope, other routes
  // keep JSON (the general body limit is 1 MB; this route allows 4 MB).
  void app.register(async scope => {
    scope.addContentTypeParser(IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));
    /** An image for a message (D19 step 3): signature, ≤8000 px, sha256, blobs/, uploads. */
    scope.post('/api/uploads', { bodyLimit: UPLOAD_LIMIT }, async (req, reply): Promise<UploadResponse> => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(415, 'not_image', 'Пришлите изображение PNG, JPEG, GIF или WebP');
      let img;
      try {
        img = await storeImage(db, needStore(), req.user!.id, body);
      } catch (err) {
        if (err instanceof ImageError) throw new HttpError(err.status, err.code, err.message);
        throw err;
      }
      await db
        .insertInto('uploads')
        .values({ sha256: img.sha256, user_id: req.user!.id })
        .onConflict(oc => oc.columns(['user_id', 'sha256']).doUpdateSet({ created_at: new Date() }))
        .execute();
      reply.code(img.uploaded ? 201 : 200);
      return { sha256: img.sha256, mime: img.mime, size: img.size, width: img.width, height: img.height };
    });
  });

  /** Large tool output (D4): the S3 copy of tool-results/<name>, as plain text that the browser does not run. */
  app.get('/api/sessions/:id/tool-results/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const sid = String((req.query as { sid?: string }).sid ?? '');
    const body = await sessions.sideFile(req.user!.id, id, sid, name);
    return reply
      .type('text/plain; charset=utf-8')
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(body);
  });

  /** «Показать изображение» for a local path in an answer (D19). */
  app.post('/api/sessions/:id/images', async req => {
    const r = showImageRequestSchema.safeParse(req.body ?? {});
    if (!r.success) throw new HttpError(400, 'invalid_request', 'path required');
    return { event: await sessions.showImage(req.user!.id, (req.params as { id: string }).id, r.data.path) };
  });

  /** Attachments for the agent: the token is bound to the runner and the sha256, 15 min (D19 step 4). */
  app.get('/agent-api/blobs/:token', async (req, reply) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const runner = m ? await findRunnerByToken(db, m[1]!) : null;
    if (!runner) return reply.code(401).send({ error: 'unauthenticated' });
    const sha256 = sessions.resolveBlobLink((req.params as { token: string }).token, runner.id);
    if (!sha256) return reply.code(404).send({ error: 'not_found' });
    const blob = await db.selectFrom('blobs').select(['mime', 's3_key']).where('sha256', '=', sha256).executeTakeFirst();
    const body = blob ? await needStore().get(blob.s3_key) : null;
    if (!blob || !body) return reply.code(404).send({ error: 'not_found' });
    return reply.type(blob.mime).header('X-Content-Type-Options', 'nosniff').send(body);
  });
}

/** Uploads never sent within 24 h are forgotten (their blobs stay: content-addressed, D19 step 6). */
export async function cleanupUploads(db: Db): Promise<number> {
  const r = await db
    .deleteFrom('uploads')
    .where('used_at', 'is', null)
    .where('created_at', '<', new Date(Date.now() - 24 * 3600_000))
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
