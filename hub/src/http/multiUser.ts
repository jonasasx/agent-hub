// Change multi-user: administration (invites, users), machines and their enrollment, the security log.
// Specs users, runner-enrollment, public-access; design M2–M4, M9.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createInviteRequestSchema,
  createRunnerRequestSchema,
  enrollRequestSchema,
  renameRunnerRequestSchema,
  type AdminUsersResponse,
  type CreateInviteResponse,
  type EnrollCodeResponse,
  type EnrollResponse,
  type InvitesResponse,
  type RunnerDetail,
  type RunnersResponse,
  type SecurityResponse,
} from '@agent-hub/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { HubBus } from '../bus.js';
import type { AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import type { HubLimits } from './limits.js';
import { agentWsUrl, type AgentBuild } from '../runners/agentBuild.js';
import { HttpError } from '../sessions/service.js';
import { SESSION_COOKIE, deleteUserSessions, findSession } from '../auth/sessions.js';
import { InviteError, createInvite, listAdminUsers, listInvites, listSecurityEvents, logSecurity, revokeInvite, setUserStatus } from '../users/repo.js';
import {
  RunnerNameTaken,
  createPendingRunner,
  disableRunner,
  getOwnedRunner,
  issueEnrollCode,
  latestEnroll,
  listRunnerViews,
  redeemEnrollCode,
  renameRunner,
  toRunnerView,
  type RunnerRow,
} from '../runners/repo.js';

function parse<T extends z.ZodType>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new HttpError(400, 'invalid_request', z.prettifyError(r.error));
  return r.data;
}

/** Requirement: Администратор не видит чужие сессии — the role check of /api/admin/*. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Только для администратора' });
}

export function installCommands(publicUrl: string, code: string): { unix: string; windows: string } {
  return {
    unix: `curl -fsSL ${publicUrl}/install.sh | bash -s -- ${code}`,
    windows: `irm ${publicUrl}/install.ps1 | iex; Install-AgentHub ${code}`,
  };
}

/** Uninstall-AgentHub exists only after install.ps1 is loaded. */
export function uninstallCommands(publicUrl: string): { unix: string; windows: string } {
  return { unix: '~/.agent-hub/uninstall.sh', windows: `irm ${publicUrl}/install.ps1 | iex; Uninstall-AgentHub` };
}

export function registerMultiUser(app: FastifyInstance, deps: { config: Config; db: Db; bus: HubBus; agents: AgentGateway; ui: UiGateway; limits: HubLimits; build: AgentBuild }): void {
  const { config, db, bus, agents, ui, limits, build } = deps;
  const latest = () => build.latest?.version ?? null;
  const view = (r: RunnerRow) => toRunnerView(r, latest());
  const security = (req: FastifyRequest, e: Parameters<typeof logSecurity>[1]) =>
    logSecurity(db, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, ...e }).catch((err: unknown) => req.log.warn({ err }, 'security log write failed'));
  const idParam = (req: FastifyRequest) => (req.params as { id: string }).id;
  /** Requirement: Разделение пространств — another user's runner answers like a missing one. */
  const owned = async (req: FastifyRequest): Promise<RunnerRow> => {
    const r = await getOwnedRunner(db, req.user!.id, idParam(req));
    if (!r) throw new HttpError(404, 'not_found', 'Машина не найдена');
    return r;
  };
  const detail = async (r: RunnerRow): Promise<RunnerDetail> => ({
    ...view(r),
    hostname: r.hostname,
    createdAt: r.created_at.toISOString(),
    enroll: await latestEnroll(db, r.id),
    uninstallCommand: uninstallCommands(config.PUBLIC_URL),
  });
  const codeResponse = async (req: FastifyRequest, r: RunnerRow): Promise<EnrollCodeResponse> => {
    const { code, expiresAt } = await issueEnrollCode(db, r);
    void security(req, { userId: r.user_id, kind: 'enroll_code_issued', runnerId: r.id });
    return { runner: view(r), code, expiresAt: expiresAt.toISOString(), commands: installCommands(config.PUBLIC_URL, code) };
  };

  // ---------- invites and users (admin) ----------

  app.get('/api/admin/invites', { preHandler: requireAdmin }, async (): Promise<InvitesResponse> => ({ invites: await listInvites(db) }));

  app.post('/api/admin/invites', { preHandler: requireAdmin }, async (req, reply) => {
    const b = parse(createInviteRequestSchema, req.body);
    try {
      const { code, invite } = await createInvite(db, req.user!.id, b.email, b.provider);
      req.log.info({ inviteId: invite.id, provider: invite.provider }, 'invite created');
      const res: CreateInviteResponse = { invite, url: `${config.PUBLIC_URL}/invite/${code}` };
      return reply.code(201).send(res);
    } catch (err) {
      if (err instanceof InviteError && err.code === 'user_exists') throw new HttpError(409, 'user_exists', 'Пользователь уже есть');
      throw err;
    }
  });

  app.delete('/api/admin/invites/:id', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      await revokeInvite(db, idParam(req));
    } catch (err) {
      if (err instanceof InviteError) throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.code === 'not_found' ? 'Приглашение не найдено' : 'Приглашение уже использовано');
      throw err;
    }
    return reply.code(204).send();
  });

  app.get('/api/admin/users', { preHandler: requireAdmin }, async (): Promise<AdminUsersResponse> => ({ users: await listAdminUsers(db, id => agents.isOnline(id)) }));

  const adminUser = async (id: string) => {
    const u = (await listAdminUsers(db, r => agents.isOnline(r))).find(x => x.id === id);
    if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
    return u;
  };

  // Requirement: Отключение пользователя — sessions deleted, windows closed with 4403, agents closed with 4401 (their
  // tokens are refused while the user is disabled), data kept.
  app.post('/api/admin/users/:id/disable', { preHandler: requireAdmin }, async req => {
    const id = idParam(req);
    if (id === req.user!.id) throw new HttpError(400, 'cannot_disable_self', 'Нельзя отключить себя');
    if (!(await setUserStatus(db, id, 'disabled'))) throw new HttpError(404, 'not_found', 'Пользователь не найден');
    ui.closeUser(id);
    await deleteUserSessions(db, id);
    agents.revokeUser(id);
    req.log.info({ userId: id }, 'user disabled');
    return adminUser(id);
  });

  app.post('/api/admin/users/:id/enable', { preHandler: requireAdmin }, async req => {
    const id = idParam(req);
    if (!(await setUserStatus(db, id, 'active'))) throw new HttpError(404, 'not_found', 'Пользователь не найден');
    req.log.info({ userId: id }, 'user enabled');
    return adminUser(id);
  });

  // ---------- machines ----------

  app.get('/api/runners', async (req): Promise<RunnersResponse> => {
    await build.refresh().catch(() => null);
    return { runners: await listRunnerViews(db, req.user!.id, { all: true, latestAgent: latest() }), agentVersion: latest() };
  });

  // Requirement: Код подключения.
  app.post('/api/runners', async (req, reply) => {
    const b = parse(createRunnerRequestSchema, req.body);
    let r: RunnerRow;
    try {
      r = await createPendingRunner(db, req.user!.id, { name: b.name, os: b.os });
    } catch (err) {
      if (err instanceof RunnerNameTaken) throw new HttpError(409, 'name_taken', 'Машина с таким именем уже есть');
      throw err;
    }
    return reply.code(201).send(await codeResponse(req, r));
  });

  app.get('/api/runners/:id', async (req): Promise<RunnerDetail> => detail(await owned(req)));

  app.patch('/api/runners/:id', async (req): Promise<RunnerDetail> => {
    const b = parse(renameRunnerRequestSchema, req.body);
    await owned(req);
    let r: RunnerRow | undefined;
    try {
      r = await renameRunner(db, req.user!.id, idParam(req), b.name);
    } catch (err) {
      if (err instanceof RunnerNameTaken) throw new HttpError(409, 'name_taken', 'Машина с таким именем уже есть');
      throw err;
    }
    if (!r) throw new HttpError(404, 'not_found', 'Машина не найдена');
    bus.emit('runner.status', r.user_id, view(r));
    return detail(r);
  });

  // «Новый код» and «Переподключить»: the current token keeps working until the agent connects with the new one.
  app.post('/api/runners/:id/enroll-code', async (req): Promise<EnrollCodeResponse> => {
    const r = await owned(req);
    if (r.state === 'disabled') throw new HttpError(409, 'runner_disabled', 'Машина отключена');
    return codeResponse(req, r);
  });

  // Requirement: Экран «Машины» — «Отключить».
  app.post('/api/runners/:id/disable', async (req): Promise<RunnerDetail> => {
    await owned(req);
    const r = await disableRunner(db, req.user!.id, idParam(req));
    if (!r) throw new HttpError(404, 'not_found', 'Машина не найдена');
    agents.revoke(r.id);
    bus.emit('runner.status', r.user_id, view(r));
    req.log.info({ runnerId: r.id }, 'runner disabled');
    return detail(r);
  });

  // Requirement: Код подключения — the exchange by the installer: no cookie, no Origin (originExempt), rate-limited.
  app.post('/enroll', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    // The attempt is counted before the exchange and taken back on success: parallel wrong codes cannot all slip past
    // the check while the first ones are still in redeem.
    if (!limits.enrollBad.hit(req.ip)) {
      req.log.warn({ ip: req.ip }, 'rate limit: enroll');
      return reply.code(429).send({ error: 'too_many_requests', message: 'Слишком много неверных кодов, подождите минуту' });
    }
    const body = enrollRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const r = await redeemEnrollCode(db, body.data.code, { os: body.data.os, arch: body.data.arch });
    if (!r.ok) {
      // The value of the code is never logged.
      req.log.warn({ ip: req.ip, error: r.error }, 'enroll refused');
      const text = { code_used: 'Код уже использован', code_expired: 'Код истёк', code_invalid: 'Код недействителен' }[r.error];
      return reply.code(410).send({ error: r.error, message: text });
    }
    limits.enrollBad.release(req.ip);
    req.log.info({ runnerId: r.runner.id }, 'enroll code used');
    void security(req, { userId: r.runner.user_id, kind: 'enroll_code_used', runnerId: r.runner.id });
    bus.emit('runner.enroll', r.runner.user_id, r.runner.id, 'code_used', view(r.runner));
    const b = await build.refresh().catch(() => null);
    const res: EnrollResponse = {
      runnerId: r.runner.id,
      token: r.token,
      hubUrl: agentWsUrl(config.PUBLIC_URL),
      agentVersion: b?.version ?? null,
      agentUrl: b?.url ?? null,
      agentSha256: b?.sha256 ?? null,
    };
    return res;
  });

  // ---------- security log ----------

  app.get('/api/security', async (req): Promise<SecurityResponse> => {
    const current = await findSession(db, req.cookies[SESSION_COOKIE]);
    const rows = await db
      .selectFrom('auth_sessions')
      .select(['id_hash', 'created_at', 'expires_at', 'user_agent'])
      .where('user_id', '=', req.user!.id)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .execute();
    return {
      events: await listSecurityEvents(db, req.user!.id),
      sessions: rows.map(s => ({
        id: s.id_hash.toString('hex').slice(0, 16),
        createdAt: s.created_at.toISOString(),
        expiresAt: new Date(s.expires_at).toISOString(),
        userAgent: s.user_agent,
        current: Boolean(current && current.idHash.equals(s.id_hash)),
      })),
    };
  });
}
