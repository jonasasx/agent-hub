// HTTP API of subscriptions (claude-subscriptions design P8). Every query is scoped by req.user.id; mutations pass the
// Origin check of auth.ts. No answer carries a token — only `tokenHint`.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  codexLoginRequestSchema,
  createSubscriptionRequestSchema,
  patchSubscriptionRequestSchema,
  putSubscriptionOrderRequestSchema,
  putSubscriptionTokenRequestSchema,
  subscriptionUsageQuerySchema,
  switchSubscriptionRequestSchema,
  type SubscriptionUsageResponse,
  type SubscriptionView,
  type SubscriptionsResponse,
  type SwitchSubscriptionResponse,
  type RefreshLimitsResponse,
  type SubscriptionLimitsResponse,
} from '@agent-hub/shared';
import { HttpError, type SessionService } from '../sessions/service.js';
import type { SubscriptionService } from '../subscriptions/service.js';
import type { LimitsService } from '../subscriptions/limits.js';

/** A body error: 422 with `code` when only the token is wrong (bad_token), else 400 as elsewhere. The value is never echoed. */
function parseBody<T extends z.ZodType>(schema: T, v: unknown, code422?: { field: string; code: string; message: string }): z.infer<T> {
  const r = schema.safeParse(v ?? {});
  if (r.success) return r.data;
  if (code422 && r.error.issues.every(i => i.path[0] === code422.field)) throw new HttpError(422, code422.code, code422.message);
  // issue paths and messages only: zod's input echo is not used, so a token cannot end up in the answer
  throw new HttpError(400, 'invalid_request', r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
}

const BAD_TOKEN = { field: 'token', code: 'bad_token', message: 'Токен — от 20 до 4096 символов без пробелов' };

export function registerSubscriptionsApi(app: FastifyInstance, deps: { subscriptions: SubscriptionService; sessions: SessionService; limits?: LimitsService }): void {
  const { subscriptions, sessions, limits } = deps;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/api/subscriptions', async (req): Promise<SubscriptionsResponse> => subscriptions.list(req.user!.id));

  app.post('/api/subscriptions', async (req, reply) => {
    // 503 first: without a key nothing is stored, whatever the body
    if (!subscriptions.enabled) throw new HttpError(503, 'subscriptions_disabled', 'Хранение токенов не настроено: задайте SUBSCRIPTION_TOKEN_KEY');
    const b = parseBody(createSubscriptionRequestSchema, req.body, BAD_TOKEN);
    const v: SubscriptionView = await subscriptions.create(req.user!.id, b);
    return reply.code(201).send(v);
  });

  /** provider-parity D3: a ChatGPT sign-in of a Codex subscription; the end comes as WS provider.login. */
  app.post('/api/subscriptions/codex-login', async req => sessions.codexSubscriptionLoginStart(req.user!.id, parseBody(codexLoginRequestSchema, req.body)));

  // before /:id routes: `order` and `usage` are not ids
  app.put('/api/subscriptions/order', async (req): Promise<SubscriptionsResponse> => {
    const r = putSubscriptionOrderRequestSchema.safeParse(req.body ?? {});
    if (!r.success) throw new HttpError(422, 'bad_order', 'Порядок должен перечислять все активные подписки по одному разу');
    return subscriptions.order(req.user!.id, r.data.ids);
  });

  app.get('/api/subscriptions/usage', async (req): Promise<SubscriptionUsageResponse> => {
    const r = subscriptionUsageQuerySchema.safeParse(req.query ?? {});
    if (!r.success) throw new HttpError(422, 'bad_period', 'Период — не больше 366 дней, начало раньше конца');
    return subscriptions.usage(req.user!.id, r.data);
  });

  // subscription-limits (L6): before /:id routes as well — `limits` is not an id
  if (limits) {
    app.get('/api/subscriptions/limits', async (req): Promise<SubscriptionLimitsResponse> => limits.list(req.user!.id));

    /** 202 {limits}: a probe turn queued; 404, 409, 429 refresh_too_soon + Retry-After, 503. */
    app.post('/api/subscriptions/:id/limits/refresh', async (req, reply) => {
      try {
        const res: RefreshLimitsResponse = { limits: await limits.refresh(req.user!.id, idOf(req)) };
        return reply.code(202).send(res);
      } catch (err) {
        if (err instanceof HttpError && err.status === 429 && err.details?.retryAfter) reply.header('Retry-After', err.details.retryAfter);
        throw err;
      }
    });
  }

  app.patch('/api/subscriptions/:id', async (req): Promise<SubscriptionView> => subscriptions.patch(req.user!.id, idOf(req), parseBody(patchSubscriptionRequestSchema, req.body)));

  app.put('/api/subscriptions/:id/token', async (req): Promise<SubscriptionView> => {
    if (!subscriptions.enabled) throw new HttpError(503, 'subscriptions_disabled', 'Хранение токенов не настроено: задайте SUBSCRIPTION_TOKEN_KEY');
    const b = parseBody(putSubscriptionTokenRequestSchema, req.body, BAD_TOKEN);
    // a Codex subscription is signed in again through codex-login, not by pasting a value
    if ((await subscriptions.ownMeta(req.user!.id, idOf(req))).provider === 'codex') throw new HttpError(422, 'bad_token', 'Подписка Codex: войдите заново через ChatGPT');
    return subscriptions.replaceToken(req.user!.id, idOf(req), b.token);
  });

  /** Switch of a session (P6): 202 {session}. */
  app.post('/api/sessions/:id/subscription', async (req, reply) => {
    const b = parseBody(switchSubscriptionRequestSchema, req.body);
    const session = await sessions.switchSubscription(req.user!.id, idOf(req), b);
    const res: SwitchSubscriptionResponse = { session };
    return reply.code(202).send(res);
  });
}
