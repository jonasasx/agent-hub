// HTTP API of MCP management (mcp-management design M8). Every /api route is the owner's only (404 for anyone else);
// mutations pass the Origin check of auth.ts. GET /mcp/oauth/callback is a public route: the handler checks the browser
// session itself (redirect to the login and back) and never logs the address with the code.
// Requirements: Статус MCP сессии; Переподключение MCP-сервера; Включение и выключение MCP-сервера; Вход в удалённый
// MCP с любого устройства; Защита потока входа MCP; MCP спящей сессии; MCP машины; Права на MCP.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { mcpActionRequestSchema, mcpAuthCallbackRequestSchema, mcpAuthRequestSchema, mcpLogoutRequestSchema, type McpMachineView, type McpSessionView } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { HttpError } from '../sessions/service.js';
import type { McpService } from '../mcp/service.js';
import { MCP_CALLBACK_PATH } from '../mcp/service.js';
import type { McpRegistryService } from '../mcp/registry.js';
import { authenticate } from './auth.js';
import { render, tr } from '../i18n.js';
import { mcpFlowNotFoundPage, mcpSignInFailedPage, mcpSignInWaitingPage, mcpSignedInPage } from './pages.js';

function parseBody<T extends z.ZodType>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v ?? {});
  // paths and messages only: the pasted address is never echoed
  if (!r.success) throw new HttpError(400, 'invalid_request', r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

/** Headers of an HTML answer of the callback: no referrer (the address carries the code), no caching. */
function html(reply: FastifyReply, code: number, body: string) {
  return reply.code(code).header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(body);
}

export function registerMcpApi(app: FastifyInstance, deps: { db: Db; mcp: McpService; oauthRegistry: Pick<McpRegistryService, 'oauthCallback'> }): void {
  const { db, mcp, oauthRegistry } = deps;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/api/sessions/:id/mcp', async (req): Promise<McpSessionView> => mcp.view(req.user!.id, idOf(req)));

  app.post('/api/sessions/:id/mcp/refresh', async (req, reply) => reply.code(202).send(await mcp.refresh(req.user!.id, idOf(req))));

  app.post('/api/sessions/:id/mcp/actions', async (req, reply) => {
    const b = parseBody(mcpActionRequestSchema, req.body);
    return reply.code(202).send(await mcp.action(req.user!.id, idOf(req), b.server, b.action));
  });

  app.post('/api/sessions/:id/mcp/auth', async (req, reply) => {
    const b = parseBody(mcpAuthRequestSchema, req.body);
    return reply.code(202).send(await mcp.auth(req.user!.id, idOf(req), b.server));
  });

  app.post('/api/sessions/:id/mcp/auth/callback', async (req, reply) => {
    const b = parseBody(mcpAuthCallbackRequestSchema, req.body);
    return reply.code(202).send(await mcp.pasteCallback(req.user!.id, idOf(req), b.server, b.callbackUrl));
  });

  // mcp-auth-controls A3: «Выйти» (the confirmation is the UI's)
  app.post('/api/sessions/:id/mcp/logout', async (req, reply) => {
    const b = parseBody(mcpLogoutRequestSchema, req.body);
    return reply.code(202).send(await mcp.logout(req.user!.id, idOf(req), b.server));
  });

  app.get('/api/runners/:id/mcp', async (req): Promise<McpMachineView> => mcp.machine(req.user!.id, idOf(req)));

  app.post('/api/runners/:id/mcp/probe', async (req, reply) => {
    try {
      return reply.code(202).send(await mcp.probe(req.user!.id, idOf(req)));
    } catch (err) {
      if (err instanceof HttpError && err.status === 429 && err.details?.retryAfter) reply.header('Retry-After', err.details.retryAfter);
      throw err;
    }
  });

  /**
   * The provider returns the browser here (M8): no browser session → the login and back to this address; an unknown,
   * expired or another user's `state` → 403 «Попытка входа не найдена» (nothing goes to the machine); `error` → the
   * address still goes to the process (the CLI closes the attempt) and «Вход не выполнен: <error>»; else the process
   * gets it, and «Вход выполнен» leads into the session. A repeated GET of the same `state` does not pass the code again:
   * while the first is in flight — «Вход выполняется» with a refresh, after it — the same result.
   */
  app.get(MCP_CALLBACK_PATH, async (req, reply) => {
    const user = await authenticate(db, req);
    if (!user) return reply.redirect(`/auth/login?return=${encodeURIComponent(req.url)}`, 302);
    const q = req.query as { state?: unknown; code?: unknown; error?: unknown };
    const state = typeof q.state === 'string' ? q.state : undefined;
    const oauthResult = await oauthRegistry.oauthCallback(user.id, state, new URL(req.url, mcp.redirectUri).toString());
    if (oauthResult) {
      const message = oauthResult.ok ? 'Authorization received. You can return to Agent Hub.' : (oauthResult.error ?? 'Authorization failed.');
      const page = [
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>MCP sign-in</title><body><main><h1>MCP sign-in</h1><p>',
        message,
        '</p><p>You can close this window.</p></main></body></html>',
      ].join('');
      return html(reply, oauthResult.ok ? 200 : 400, page);
    }
    // a repeated GET (reload, a second tab, a retry of the proxy): the code is not passed again
    const prev = mcp.callbackOf(user.id, state);
    if (prev) {
      const href = `/s/${prev.sessionId}?mcp=1`;
      if (!prev.done) return html(reply, 200, mcpSignInWaitingPage(req.locale, prev.server));
      if (prev.done.ok) return html(reply, 200, mcpSignedInPage(req.locale, prev.server, href));
      return html(reply, 200, mcpSignInFailedPage(req.locale, (prev.done.errorI18n ? render(prev.done.errorI18n, req.locale) : prev.done.error) ?? tr(req.locale).text('hub.page.unknownError'), href));
    }
    const f = mcp.flowFor(user.id, state);
    if (!f || (typeof q.code !== 'string' && typeof q.error !== 'string')) return html(reply, 403, mcpFlowNotFoundPage(req.locale));
    const sessionHref = `/s/${f.sessionId}?mcp=1`;
    const r = await mcp.runCallback(f, `${mcp.redirectUri}${req.url.slice(req.url.indexOf('?'))}`);
    if (r.ok) return html(reply, 200, mcpSignedInPage(req.locale, f.server, sessionHref));
    return html(reply, 200, mcpSignInFailedPage(req.locale, (r.errorI18n ? render(r.errorI18n, req.locale) : r.error) ?? tr(req.locale).text('hub.page.unknownError'), sessionHref));
  });
}
