// HTTP API of session peers (session-peers design D8): the journal of one session, the owner's only (404 for anyone else).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/db.js';
import { getSession } from '../sessions/repo.js';
import { HttpError } from '../sessions/service.js';
import { listPeerMessages } from '../peers/repo.js';

export function registerPeersApi(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;
  app.get('/api/peers/messages', async req => {
    const q = (req.query ?? {}) as { session?: string; limit?: string; before?: string };
    const s = q.session ? await getSession(db, q.session, req.user!.id) : undefined;
    if (!s) throw new HttpError(404, 'not_found', 'Сессия не найдена');
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const before = q.before ? new Date(q.before) : undefined;
    if (before && Number.isNaN(before.getTime())) throw new HttpError(400, 'invalid_request', 'before: неверная дата');
    const rows = await listPeerMessages(db, req.user!.id, s.id, limit, before);
    return {
      messages: rows.map(r => ({
        id: r.id,
        from: r.from_session_id,
        to: r.to_session_id,
        text: r.text,
        inReplyTo: r.in_reply_to,
        result: r.result,
        errorCode: r.error_code,
        at: r.created_at.toISOString(),
      })),
    };
  });
}
