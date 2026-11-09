// HTTP API of Web Push subscriptions (change web-push-notifications D7): the devices of the signed-in user.
import type { FastifyInstance } from 'fastify';
import { PUSH_MAX_DEVICES, pushSubscribeSchema, pushTestSchema, type PushDeviceView, type PushSubscriptionsResponse } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { deviceLabel } from '../push/device.js';
import { isSafePushEndpoint } from '../push/endpoint.js';
import { deleteByHash, deleteById, listByUser, upsertByEndpoint, type PushSubscriptionRow } from '../push/repo.js';
import type { PushService } from '../push/service.js';
import { HttpError } from '../sessions/service.js';

function view(r: PushSubscriptionRow): PushDeviceView {
  return {
    id: r.id,
    label: r.device_label,
    endpointHash: r.endpoint_hash,
    createdAt: r.created_at.toISOString(),
    lastSuccessAt: r.last_success_at?.toISOString() ?? null,
    lastFailureAt: r.last_failure_at?.toISOString() ?? null,
    failureCount: r.failure_count,
  };
}

const invalid = (): HttpError => new HttpError(422, 'invalid_subscription', { key: 'hub.push.invalidSubscription' });
const notFound = (): HttpError => new HttpError(404, 'subscription_not_found', { key: 'hub.push.notFound' });

export function registerPushRoutes(app: FastifyInstance, deps: { db: Db; push: PushService }): void {
  const { db, push } = deps;

  app.get('/api/push/subscriptions', async (req): Promise<PushSubscriptionsResponse> => {
    if (!push.enabled) return { configured: false, devices: [] };
    const rows = await listByUser(db, req.user!.id);
    return { configured: true, devices: rows.map(view) };
  });

  app.post('/api/push/subscriptions', async (req, reply): Promise<PushDeviceView> => {
    if (!push.enabled) throw new HttpError(503, 'push_not_configured', { key: 'hub.push.notConfigured' });
    const parsed = pushSubscribeSchema.safeParse(req.body);
    if (!parsed.success || !isSafePushEndpoint(parsed.data.endpoint)) throw invalid();
    const { endpoint, keys } = parsed.data;
    const ua = req.headers['user-agent'];
    const res = await upsertByEndpoint(
      db,
      req.user!.id,
      { endpoint, p256dh: keys.p256dh, auth: keys.auth, deviceLabel: deviceLabel(typeof ua === 'string' ? ua : undefined), locale: req.locale },
      PUSH_MAX_DEVICES,
    );
    if (res.kind === 'limit') throw new HttpError(422, 'too_many_devices', { key: 'hub.push.tooManyDevices' });
    reply.code(res.kind === 'created' ? 201 : 200);
    return view(res.row);
  });

  app.delete('/api/push/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = /^[0-9a-f-]{36}$/i.test(id) && (await deleteById(db, req.user!.id, id));
    if (!ok) throw notFound();
    return reply.code(204).send();
  });

  app.delete('/api/push/subscriptions', async (req, reply) => {
    const hash = (req.query as { endpointHash?: string }).endpointHash;
    if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) await deleteByHash(db, req.user!.id, hash);
    return reply.code(204).send();
  });

  app.post('/api/push/test', async (req, reply) => {
    const parsed = pushTestSchema.safeParse(req.body);
    if (!parsed.success) throw notFound();
    const res = await push.sendTest(req.user!.id, parsed.data.endpointHash);
    if (res === 'not_configured') throw new HttpError(503, 'push_not_configured', { key: 'hub.push.notConfigured' });
    if (res === 'rate_limited') throw new HttpError(429, 'rate_limited', { key: 'hub.push.rateLimited' });
    if (res === 'not_found') throw notFound();
    if (res === 'gone') throw new HttpError(410, 'subscription_gone', { key: 'hub.push.gone' });
    if (res === 'failed') throw new HttpError(502, 'push_failed', { key: 'hub.push.sendFailed' });
    return reply.code(204).send();
  });
}
