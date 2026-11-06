// Change multi-user against a real hub, Postgres and fake Google/Keycloak: invites and login (spec users), machines and
// enrollment (spec runner-enrollment), the security log and the hardening (spec public-access).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CloseCode, PROTOCOL_VERSION, envelope } from '@agent-hub/shared';
import { ALLOWED_EMAIL, PUBLIC_URL, agentSend, connectFakeAgent, connectUi, startTestHub, waitFor, type TestHub } from '../test/harness.js';
import { PENDING_RUNNER_TTL_MS, deleteStalePendingRunners } from '../runners/repo.js';

const KATE = 'kate@example.com';
const COLLEAGUE = 'colleague@example.com';

function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    // resolved when the hub closed it (4401 after the token check), so the failure is counted before the next one
    ws.on('close', () => resolve(101));
    ws.on('error', () => undefined);
  });
}

describe('multi-user (integration)', () => {
  let t: TestHub;
  let ivan: string;
  beforeAll(async () => {
    t = await startTestHub({ keycloak: true });
    ivan = await t.login();
  });
  afterAll(async () => t.close());

  const app = () => t.hub.app;
  const get = (url: string, session?: string) => app().inject({ method: 'GET', url, ...(session ? { cookies: { ah_session: session } } : {}) });
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, session: string | null, payload?: unknown, origin: string | null = PUBLIC_URL) =>
    app().inject({
      method,
      url,
      headers: origin ? { origin } : {},
      ...(session ? { cookies: { ah_session: session } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const invite = async (email: string, provider: 'google' | 'keycloak' = 'google') => {
    const r = await send('POST', '/api/admin/invites', ivan, { email, provider });
    expect(r.statusCode).toBe(201);
    return { ...r.json(), code: (r.json().url as string).split('/invite/')[1]! } as { invite: { id: string; status: string }; url: string; code: string };
  };
  const userCount = async (email: string) => Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM users WHERE lower(email) = $1`, [email])).rows[0].n);

  // ---------- users ----------

  describe('Роли и приглашения', () => {
    it('GET /api/me: the bootstrap administrator has role admin', async () => {
      const me = await get('/api/me', ivan);
      expect(me.json().user).toMatchObject({ email: ALLOWED_EMAIL, role: 'admin', provider: 'google' });
    });

    it('Создание приглашения: a link /invite/<43 chars>, 7 days, in the list; only the hash is stored', async () => {
      const r = await invite('Kate@Example.com');
      expect(r.url).toMatch(new RegExp(`^${PUBLIC_URL}/invite/[A-Za-z0-9_-]{43}$`));
      expect(r.invite).toMatchObject({ email: KATE, provider: 'google', status: 'active' });
      const days = (Date.parse((r.invite as unknown as { expiresAt: string }).expiresAt) - Date.now()) / 86400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
      const list = (await get('/api/admin/invites', ivan)).json().invites as Array<{ id: string }>;
      expect(list.some(i => i.id === r.invite.id)).toBe(true);
      const stored = (await t.tdb.pool.query(`SELECT code_hash FROM invites WHERE id = $1`, [r.invite.id])).rows[0].code_hash as Buffer;
      expect(stored.equals(createHash('sha256').update(r.code).digest())).toBe(true);
    });

    it('Повторное приглашение того же адреса: the previous invite is revoked', async () => {
      const a = await invite('repeat@example.com');
      const b = await invite('repeat@example.com');
      const list = (await get('/api/admin/invites', ivan)).json().invites as Array<{ id: string; status: string }>;
      expect(list.find(i => i.id === a.invite.id)!.status).toBe('revoked');
      expect(list.find(i => i.id === b.invite.id)!.status).toBe('active');
      expect((await get(`/invite/${a.code}`)).statusCode).toBe(410);
    });

    it('Приглашение на адрес существующего пользователя: 409 user_exists', async () => {
      const r = await send('POST', '/api/admin/invites', ivan, { email: ALLOWED_EMAIL, provider: 'google' });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'user_exists', message: 'Пользователь уже есть' });
    });

    it('DELETE /api/admin/invites/:id revokes an unused invite', async () => {
      const a = await invite('revoke@example.com');
      expect((await send('DELETE', `/api/admin/invites/${a.invite.id}`, ivan)).statusCode).toBe(204);
      expect((await get(`/invite/${a.code}`)).statusCode).toBe(410);
      expect((await send('DELETE', '/api/admin/invites/00000000-0000-4000-8000-000000000000', ivan)).statusCode).toBe(404);
    });
  });

  describe('Вход по приглашению', () => {
    it('Вход под другим адресом: «Приглашение выписано на <адрес>», no user, the invite stays valid', async () => {
      const inv = await invite('mismatch@example.com');
      const cb = await t.loginResponse({ email: 'other@example.com' }, { invite: inv.code });
      expect(cb.statusCode).toBe(403);
      expect(cb.body).toContain('Приглашение выписано на mismatch@example.com');
      expect(cb.session).toBeFalsy();
      expect(await userCount('other@example.com')).toBe(0);
      expect(await userCount('mismatch@example.com')).toBe(0);
      expect((await get(`/invite/${inv.code}`)).statusCode).toBe(200);
    });

    it('Катя принимает приглашение: the user is created with role user, redirect to the welcome screen, the link is spent', async () => {
      const inv = await invite('kate2@example.com');
      const page = await get(`/invite/${inv.code}`);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('kate2@example.com');
      expect(page.body).toContain(`/auth/login?provider=google&amp;invite=${inv.code}`);
      // case-insensitive address
      const cb = await t.loginResponse({ email: 'KATE2@example.com', name: 'Катя' }, { invite: inv.code });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('/');
      const me = (await get('/api/me', cb.session)).json();
      expect(me.user).toMatchObject({ email: 'kate2@example.com', role: 'user', name: 'Катя', provider: 'google' });
      expect((await get(`/invite/${inv.code}`)).statusCode).toBe(410);
      const again = await t.loginResponse({ email: 'someone-else@example.com' }, { invite: inv.code }).catch((e: Error) => e);
      expect(again).toBeInstanceOf(Error); // /auth/login refuses a spent invite before the provider
      // she logs in again without the invite (an existing user: the same provider account, `sub`)
      expect((await t.loginResponse({ email: 'kate2@example.com', sub: 'sub-KATE2@example.com' })).statusCode).toBe(302);
    });

    it('Истёкшее приглашение: «Приглашение истекло, попросите новое у Ивана» without a login button', async () => {
      const inv = await invite('late@example.com');
      await t.tdb.pool.query(`UPDATE invites SET expires_at = now() - interval '1 day' WHERE id = $1`, [inv.invite.id]);
      const page = await get(`/invite/${inv.code}`);
      expect(page.statusCode).toBe(410);
      expect(page.body).toContain('Приглашение истекло, попросите новое у Ивана');
      expect(page.body).not.toContain('/auth/login');
    });

    it('Вход без приглашения: «Доступ только по приглашению», no user, API 401, login_denied in the log', async () => {
      const cb = await t.loginResponse({ email: 'nobody@example.com' }, { provider: 'google' });
      expect(cb.statusCode).toBe(403);
      expect(cb.body).toContain('Доступ только по приглашению');
      expect(await userCount('nobody@example.com')).toBe(0);
      expect((await get('/api/me')).statusCode).toBe(401);
      const ev = await t.tdb.pool.query(`SELECT kind, provider FROM security_events WHERE email = 'nobody@example.com'`);
      expect(ev.rows).toEqual([{ kind: 'login_denied', provider: 'google' }]);
    });

    it('email_verified=false with a valid invite: refused, the invite stays', async () => {
      const inv = await invite('unverified@example.com');
      const cb = await t.loginResponse({ email: 'unverified@example.com', emailVerified: false }, { invite: inv.code });
      expect(cb.statusCode).toBe(403);
      expect(await userCount('unverified@example.com')).toBe(0);
      expect((await get(`/invite/${inv.code}`)).statusCode).toBe(200);
    });

    it('Коллега входит через Keycloak: «Войти через Acme», the login goes to Keycloak, the user is created', async () => {
      const inv = await invite(COLLEAGUE, 'keycloak');
      const page = await get(`/invite/${inv.code}`);
      expect(page.body).toContain('Войти через Acme');
      const start = await get(`/auth/login?invite=${inv.code}`);
      expect((start.headers.location as string).startsWith(`${t.keycloak!.issuer}/`)).toBe(true);
      const cb = await t.loginResponse({ email: COLLEAGUE, sub: 'kc-colleague' }, { invite: inv.code });
      expect(cb.statusCode).toBe(302);
      const me = (await get('/api/me', cb.session)).json();
      expect(me.user).toMatchObject({ email: COLLEAGUE, role: 'user', provider: 'keycloak' });
      const row = (await t.tdb.pool.query(`SELECT subject FROM users WHERE email = $1`, [COLLEAGUE])).rows[0];
      expect(row.subject).toBe('kc-colleague');
      // the same address through Google is not this user
      expect((await t.loginResponse({ email: COLLEAGUE }, { provider: 'google' })).statusCode).toBe(403);
    });

    it('/auth/login without a provider with Keycloak on: the choice page', async () => {
      const r = await get('/auth/login?return=/s/1');
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Войти через Google');
      expect(r.body).toContain('Войти через Acme');
    });

    it('login and login_denied go to the security log of the user', async () => {
      const ev = await t.tdb.pool.query(`SELECT kind, provider FROM security_events WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY id`, [COLLEAGUE]);
      expect(ev.rows).toEqual([{ kind: 'login', provider: 'keycloak' }]);
    });
  });

  // ---------- administration ----------

  describe('Администрирование', () => {
    let kate: string;
    let kateId: string;
    let kateToken: string;
    beforeAll(async () => {
      const inv = await invite(KATE);
      kate = await t.login({ email: KATE }, { invite: inv.code });
      kateId = (await get('/api/me', kate)).json().user.id;
      // her two machines, one online
      const a = await send('POST', '/api/runners', kate, { name: 'Ноутбук Кати', os: 'linux' });
      const enrolled = await app().inject({ method: 'POST', url: '/enroll', payload: { code: a.json().code, hostname: 'kate-laptop', os: 'linux', arch: 'x64' } });
      kateToken = enrolled.json().token;
      const agent = connectFakeAgent(t.wsBase, kateToken, { hostname: 'kate-laptop', os: 'Ubuntu 24.04', homeDir: '/home/kate', vaultRoot: null });
      await agent.next('welcome');
      const b = await send('POST', '/api/runners', kate, { name: 'Сервер Кати', os: 'linux' });
      const enrolled2 = await app().inject({ method: 'POST', url: '/enroll', payload: { code: b.json().code, hostname: 'kate-server', os: 'linux', arch: 'x64' } });
      const agent2 = connectFakeAgent(t.wsBase, enrolled2.json().token, { hostname: 'kate-server', os: 'Ubuntu 24.04', homeDir: '/home/kate', vaultRoot: null });
      await agent2.next('welcome');
      agent2.ws.close();
      await waitFor(async () => !t.hub.agents.isOnline(enrolled2.json().runnerId));
    });

    it('a user of role user gets 403 on /api/admin/*', async () => {
      expect((await get('/api/admin/users', kate)).statusCode).toBe(403);
      expect((await send('POST', '/api/admin/invites', kate, { email: 'x@y.z', provider: 'google' })).statusCode).toBe(403);
    });

    it('Иван открывает «Пользователи»: «2 машины, 1 в сети» without machine names, sessions or projects', async () => {
      // a machine added but never installed (pending) is not counted
      const pending = await send('POST', '/api/runners', kate, { name: 'Ещё не поставлена', os: 'linux' });
      expect(pending.statusCode).toBe(201);
      const r = await get('/api/admin/users', ivan);
      await t.tdb.db.deleteFrom('runners').where('id', '=', pending.json().runner.id).execute();
      expect(r.statusCode).toBe(200);
      const k = (r.json().users as Array<{ email: string; machines: unknown; invitedAt: string | null; role: string }>).find(u => u.email === KATE)!;
      expect(k).toMatchObject({ role: 'user', machines: { total: 2, online: 1 } });
      expect(k.invitedAt).not.toBeNull();
      for (const secret of ['Ноутбук Кати', 'Сервер Кати', 'kate-laptop', 'kate-server', '/home/kate']) expect(r.body).not.toContain(secret);
    });

    it('POST …/disable of himself → 400 cannot_disable_self', async () => {
      const me = (await get('/api/me', ivan)).json().user.id;
      const r = await send('POST', `/api/admin/users/${me}/disable`, ivan);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('cannot_disable_self');
    });

    it('Отключение коллеги: windows closed with 4403, agents with 4401, the session 401, a new login → «Доступ отключён»; enable lets her in', async () => {
      const ui = connectUi(t.wsBase, kate);
      await ui.open;
      const uiClosed = new Promise<number>(r => ui.ws.on('close', code => r(code)));
      const runner = (await get('/api/runners', kate)).json().runners.find((x: { name: string }) => x.name === 'Ноутбук Кати');
      expect(t.hub.agents.isOnline(runner.id)).toBe(true);
      const agentConn = t.hub.agents.get(runner.id)!;
      const agentClosed = new Promise<number>(r => agentConn.ws.on('close', code => r(code)));

      const r = await send('POST', `/api/admin/users/${kateId}/disable`, ivan);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ status: 'disabled' });
      expect(await uiClosed).toBe(4403);
      expect(await agentClosed).toBe(CloseCode.InvalidToken);
      expect((await get('/api/me', kate)).statusCode).toBe(401);
      const relogin = await t.loginResponse({ email: KATE });
      expect(relogin.statusCode).toBe(403);
      expect(relogin.body).toContain('Доступ отключён');
      // her data is kept, the runner tokens too: while she is disabled the hub refuses them
      expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM runners WHERE user_id = $1`, [kateId])).rows[0].n)).toBe(2);
      expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM runners WHERE user_id = $1 AND token_hash IS NOT NULL`, [kateId])).rows[0].n)).toBe(2);
      const refused = connectFakeAgent(t.wsBase, kateToken, { hostname: 'kate-laptop', os: 'Ubuntu 24.04', homeDir: '/home/kate', vaultRoot: null });
      expect((await refused.closed).code).toBe(CloseCode.InvalidToken);

      expect((await send('POST', `/api/admin/users/${kateId}/enable`, ivan)).json()).toMatchObject({ status: 'active' });
      kate = await t.login({ email: KATE });
      expect((await get('/api/me', kate)).statusCode).toBe(200);
      // after enabling, the machine reconnects with the same token — no re-install
      const back = connectFakeAgent(t.wsBase, kateToken, { hostname: 'kate-laptop', os: 'Ubuntu 24.04', homeDir: '/home/kate', vaultRoot: null });
      await back.next('welcome');
      expect(t.hub.agents.isOnline(runner.id)).toBe(true);
      back.ws.close();
      await back.closed;
    });

    it('/auth/disabled is the page «Доступ отключён» without login', async () => {
      const r = await get('/auth/disabled');
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Доступ отключён');
    });
  });

  // ---------- machines ----------

  describe('Подключение машины', () => {
    let user: string;
    beforeAll(async () => {
      const inv = await invite('machines@example.com');
      user = await t.login({ email: 'machines@example.com' }, { invite: inv.code });
    });
    const create = async (name?: string, session = user) => {
      const r = await send('POST', '/api/runners', session, { ...(name ? { name } : {}), os: 'linux' });
      expect(r.statusCode).toBe(201);
      return r.json() as { runner: { id: string; name: string; state: string }; code: string; commands: { unix: string; windows: string }; expiresAt: string };
    };
    const enroll = (code: string, hostname = 'vm-ubuntu', headers: Record<string, string> = {}) =>
      app().inject({ method: 'POST', url: '/enroll', headers, payload: { code, hostname, os: 'linux', arch: 'x64' } });

    it('Код подключения: a pending runner with a generated id, «Моя машина», a 26-character code for 15 minutes, the commands', async () => {
      const c = await create();
      expect(c.runner).toMatchObject({ name: 'Моя машина', state: 'pending' });
      expect(c.runner.id).toMatch(/^r-[a-z2-7]{10}$/);
      expect(c.code).toMatch(/^[a-z2-7]{26}$/);
      expect(c.commands.unix).toBe(`curl -fsSL ${PUBLIC_URL}/install.sh | bash -s -- ${c.code}`);
      expect(c.commands.windows).toBe(`irm ${PUBLIC_URL}/install.ps1 | iex; Install-AgentHub ${c.code}`);
      const minutes = (Date.parse(c.expiresAt) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14.9);
      expect(minutes).toBeLessThanOrEqual(15);
      expect((await create()).runner.name).toBe('Моя машина 2');
      const dup = await send('POST', '/api/runners', user, { name: 'Моя машина', os: 'linux' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe('name_taken');
      // a pending machine is not in the sidebar (welcome screen until the first connected machine)
      expect((await get('/api/sidebar', user)).json().runners).toEqual([]);
    });

    it('POST /api/runners without Origin → 403; POST /enroll without Origin with a valid code → 200', async () => {
      expect((await send('POST', '/api/runners', user, { os: 'linux' }, null)).statusCode).toBe(403);
      const c = await create('Без Origin');
      const r = await enroll(c.code);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ runnerId: c.runner.id, hubUrl: 'wss://agents.test.example/ws/agent', agentVersion: null });
      expect(r.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('Обмен кода: once; the second presentation → 410 code_used; an unknown code → 410 code_invalid', async () => {
      const c = await create('Однократно');
      expect((await enroll(c.code)).statusCode).toBe(200);
      const again = await enroll(c.code);
      expect(again.statusCode).toBe(410);
      expect(again.json().error).toBe('code_used');
      const unknown = await enroll('a'.repeat(26));
      expect(unknown.statusCode).toBe(410);
      expect(unknown.json().error).toBe('code_invalid');
    });

    it('Истёкший код: 410 code_expired; «Новый код» revokes the previous one', async () => {
      const c = await create('Истёк');
      await t.tdb.pool.query(`UPDATE enroll_codes SET expires_at = now() - interval '1 minute' WHERE runner_id = $1`, [c.runner.id]);
      const r = await enroll(c.code);
      expect(r.statusCode).toBe(410);
      expect(r.json().error).toBe('code_expired');
      const fresh = await send('POST', `/api/runners/${c.runner.id}/enroll-code`, user, {});
      expect(fresh.statusCode).toBe(200);
      const prev = await send('POST', `/api/runners/${c.runner.id}/enroll-code`, user, {});
      expect((await enroll(fresh.json().code)).json().error).toBe('code_invalid');
      expect((await enroll(prev.json().code)).statusCode).toBe(200);
    });

    it('hourly cleanup: pending older than 24 h with no used code is deleted; with a used code or fresh — kept', async () => {
      const stale = await create('Брошенная');
      const exchanged = await create('Обменяна');
      expect((await enroll(exchanged.code, 'vm-exchanged')).statusCode).toBe(200);
      const fresh = await create('Свежая');
      const old = new Date(Date.now() - PENDING_RUNNER_TTL_MS - 60_000);
      await t.tdb.db.updateTable('runners').set({ created_at: old }).where('id', 'in', [stale.runner.id, exchanged.runner.id]).execute();
      expect(await deleteStalePendingRunners(t.tdb.db)).toBe(1);
      const left = new Set((await t.tdb.db.selectFrom('runners').select('id').execute()).map(r => r.id));
      expect(left.has(stale.runner.id)).toBe(false);
      expect(left.has(exchanged.runner.id)).toBe(true);
      expect(left.has(fresh.runner.id)).toBe(true);
      expect((await send('POST', `/api/runners/${stale.runner.id}/enroll-code`, user, {})).statusCode).toBe(404);
    });

    it('hourly cleanup does not fail on a stale pending runner still referenced (006, 014, a later table): it is kept, the rest go', async () => {
      const q = (text: string, values: unknown[] = []) => t.tdb.pool.query(text, values);
      const withFile = await create('Ссылка 006');
      const withDraft = await create('Ссылка 014');
      const withLater = await create('Ссылка новой таблицы');
      const plain = await create('Брошенная 2');
      const userId = (await q(`SELECT user_id FROM runners WHERE id = $1`, [plain.runner.id])).rows[0].user_id as string;
      // 006: a transcript file of the runner (no ON DELETE)
      await q(`INSERT INTO transcript_files (user_id, runner_id, claude_session_id, rel_key, rel_path, kind) VALUES ($1, $2, gen_random_uuid(), 'p/a.jsonl', 'p/a.jsonl', 'main')`, [
        userId,
        withFile.runner.id,
      ]);
      // 014: a handoff draft generated on the runner, of a session on another machine
      const other = await create('Машина сессии');
      await q(`UPDATE runners SET state = 'active' WHERE id = $1`, [other.runner.id]);
      const sid = (
        await q(`INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, cwd) VALUES ($1, $2, gen_random_uuid(), 'hub', 'closed', '/x') RETURNING id`, [userId, other.runner.id])
      ).rows[0].id as string;
      await q(`INSERT INTO handoff_drafts (user_id, session_id, status, runner_id) VALUES ($1, $2, 'ready', $3)`, [userId, sid, withDraft.runner.id]);
      // a table of a later migration that forgot ON DELETE: the foreign-key violation skips the runner
      await q(`CREATE TABLE IF NOT EXISTS test_runner_refs (runner_id text NOT NULL REFERENCES runners (id))`);
      await q(`INSERT INTO test_runner_refs (runner_id) VALUES ($1)`, [withLater.runner.id]);
      const ids = [withFile.runner.id, withDraft.runner.id, withLater.runner.id, plain.runner.id];
      await t.tdb.db
        .updateTable('runners')
        .set({ created_at: new Date(Date.now() - PENDING_RUNNER_TTL_MS - 60_000) })
        .where('id', 'in', ids)
        .execute();
      try {
        expect(await deleteStalePendingRunners(t.tdb.db)).toBe(1);
        const left = new Set((await t.tdb.db.selectFrom('runners').select('id').execute()).map(r => r.id));
        expect(left.has(plain.runner.id)).toBe(false);
        expect([withFile, withDraft, withLater].map(c => left.has(c.runner.id))).toEqual([true, true, true]);
        expect((await q(`SELECT count(*)::int AS n FROM transcript_files WHERE runner_id = $1`, [withFile.runner.id])).rows[0].n).toBe(1);
      } finally {
        await q(`DROP TABLE test_runner_refs`);
      }
    });

    it('two parallel exchanges of one code: exactly one wins', async () => {
      const c = await create('Гонка');
      const [a, b] = await Promise.all([enroll(c.code), enroll(c.code)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 410]);
    });

    it('Успешное подключение: hello → pending→active, runner.enroll code_used → connected → claude_checked → ready, the journal', async () => {
      const ui = connectUi(t.wsBase, user);
      await ui.open;
      const c = await create('Ubuntu');
      const e = await enroll(c.code, 'ubuntu-vm', { 'x-forwarded-for': '203.0.113.7' });
      const agent = connectFakeAgent(t.wsBase, e.json().token, {
        protocol: PROTOCOL_VERSION,
        hostname: 'ubuntu-vm',
        os: 'Ubuntu 24.04',
        homeDir: '/home/machines',
        vaultRoot: null,
        claude: { login: 'ok', version: '2.1.310' },
        protectedDirs: 'n/a',
        arch: 'x64',
      });
      await agent.next('welcome');
      const stages = await waitFor(() => {
        const s = ui.received.filter(m => m.type === 'runner.enroll' && m.runnerId === c.runner.id).map(m => m.stage);
        return s.length >= 4 ? s : null;
      });
      expect(stages).toEqual(['code_used', 'connected', 'claude_checked', 'ready']);
      const d = (await get(`/api/runners/${c.runner.id}`, user)).json();
      expect(d).toMatchObject({ state: 'active', claudeLogin: 'ok', arch: 'x64', hostname: 'ubuntu-vm', online: true, enroll: { stage: 'ready' } });
      expect((await get('/api/sidebar', user)).json().runners.map((r: { id: string }) => r.id)).toContain(c.runner.id);
      const log = (await get('/api/security', user)).json();
      const kinds = (log.events as Array<{ kind: string; runner: { name: string } | null }>).filter(x => x.runner?.name === 'Ubuntu').map(x => x.kind);
      expect(kinds).toEqual(expect.arrayContaining(['enroll_code_issued', 'enroll_code_used', 'runner_connected']));
      agent.ws.close();
      ui.ws.close();
    });

    it('Переподключение: the old token works until the agent connects with the new one, then 4401; the runner id is kept', async () => {
      const c = await create('Переподключение');
      const first = (await enroll(c.code)).json().token as string;
      const a1 = connectFakeAgent(t.wsBase, first, { hostname: 'reconnect-host' });
      await a1.next('welcome');
      const code2 = (await send('POST', `/api/runners/${c.runner.id}/enroll-code`, user, {})).json().code as string;
      const r2 = (await enroll(code2, 'reconnect-host')).json();
      expect(r2.runnerId).toBe(c.runner.id);
      // still the old token: a reconnect with it is accepted
      a1.ws.close();
      await a1.closed;
      const a1b = connectFakeAgent(t.wsBase, first, { hostname: 'reconnect-host' });
      await a1b.next('welcome');
      const a2 = connectFakeAgent(t.wsBase, r2.token, { hostname: 'reconnect-host' });
      await a2.next('welcome');
      expect((await a1b.closed).code).toBe(CloseCode.Replaced);
      const stale = connectFakeAgent(t.wsBase, first, { hostname: 'reconnect-host' });
      expect((await stale.closed).code).toBe(CloseCode.InvalidToken);
      a2.ws.close();
    });

    it('Отключение машины: 4401 at once, the token refused, launching on it → 423, the uninstall command', async () => {
      const c = await create('Отключить');
      const token = (await enroll(c.code)).json().token as string;
      const a = connectFakeAgent(t.wsBase, token, { hostname: 'disable-host', homeDir: '/home/x' });
      await a.next('welcome');
      const r = await send('POST', `/api/runners/${c.runner.id}/disable`, user, {});
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ state: 'disabled', uninstallCommand: { unix: '~/.agent-hub/uninstall.sh', windows: `irm ${PUBLIC_URL}/install.ps1 | iex; Uninstall-AgentHub` } });
      expect((await a.closed).code).toBe(CloseCode.InvalidToken);
      expect((await connectFakeAgent(t.wsBase, token).closed).code).toBe(CloseCode.InvalidToken);
      const start = await send('POST', '/api/sessions', user, { runnerId: c.runner.id, cwd: '/home/x', model: 'opus', prompt: 'hi' });
      expect(start.statusCode).toBe(423);
      expect((await send('POST', `/api/runners/${c.runner.id}/enroll-code`, user, {})).statusCode).toBe(409);
      // still listed in «Машины», gone from the sidebar
      expect((await get('/api/runners', user)).json().runners.find((x: { id: string }) => x.id === c.runner.id).state).toBe('disabled');
      expect((await get('/api/sidebar', user)).json().runners.some((x: { id: string }) => x.id === c.runner.id)).toBe(false);
    });

    it('rename: PATCH /api/runners/:id; another user gets 404 for every machine route', async () => {
      const c = await create('Старое имя');
      const r = await send('PATCH', `/api/runners/${c.runner.id}`, user, { name: 'Новое имя' });
      expect(r.json().name).toBe('Новое имя');
      expect((await get(`/api/runners/${c.runner.id}`, ivan)).statusCode).toBe(404);
      expect((await send('PATCH', `/api/runners/${c.runner.id}`, ivan, { name: 'x' })).statusCode).toBe(404);
      expect((await send('POST', `/api/runners/${c.runner.id}/enroll-code`, ivan, {})).statusCode).toBe(404);
      expect((await send('POST', `/api/runners/${c.runner.id}/disable`, ivan, {})).statusCode).toBe(404);
      expect((await get(`/api/runners/${c.runner.id}`, user)).json().state).toBe('pending');
    });

    it('agent.status from a 1.5 agent updates the Claude login («Нет входа в Claude»)', async () => {
      const c = await create('Статус');
      const a = connectFakeAgent(t.wsBase, (await enroll(c.code)).json().token, { hostname: 'status-host', claude: { login: 'ok', version: '2.1.310' } });
      await a.next('welcome');
      agentSend(a, 'agent.status', { claude: { login: 'rejected', version: '2.1.310' } });
      await waitFor(async () => (await get(`/api/runners/${c.runner.id}`, user)).json().claudeLogin === 'rejected');
      a.ws.close();
    });
  });

  // ---------- security log, logout-all, hardening ----------

  describe('Выход везде и журнал', () => {
    it('Выход на всех устройствах: the other session gets 401 and its socket 4401, the current one works', async () => {
      const laptop = await t.login();
      const phone = await t.login();
      const phoneUi = connectUi(t.wsBase, phone);
      await phoneUi.open;
      const closed = new Promise<number>(r => phoneUi.ws.on('close', code => r(code)));
      const r = await send('POST', '/api/auth/logout-all', laptop, {});
      expect(r.statusCode).toBe(200);
      expect(r.json().ended).toBeGreaterThanOrEqual(1);
      expect(await closed).toBe(4401);
      expect((await get('/api/me', phone)).statusCode).toBe(401);
      expect((await get('/api/me', laptop)).statusCode).toBe(200);
      const sec = (await get('/api/security', laptop)).json();
      expect(sec.sessions).toHaveLength(1);
      expect(sec.sessions[0].current).toBe(true);
      expect(sec.events[0].kind).toBe('logout_all');
      ivan = laptop;
    });

    it('security events older than 90 days are removed by the hourly cleanup', async () => {
      const { expireSecurityEvents } = await import('../users/repo.js');
      await t.tdb.pool.query(`INSERT INTO security_events (user_id, kind, at) SELECT id, 'login', now() - interval '91 days' FROM users WHERE email = $1`, [ALLOWED_EMAIL]);
      expect(await expireSecurityEvents(t.tdb.db)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Защита браузерных запросов', () => {
    it('every response carries HSTS ≥ 1 year, X-Frame-Options DENY, nosniff, Referrer-Policy same-origin', async () => {
      for (const r of [await get('/healthz'), await get('/api/me'), await get('/auth/disabled')]) {
        expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000/);
        expect(r.headers['x-frame-options']).toBe('DENY');
        expect(r.headers['x-content-type-options']).toBe('nosniff');
        expect(r.headers['referrer-policy']).toBe('same-origin');
      }
    });

    it('a page with its own Referrer-Policy keeps it: the invite page (HTML, CSP) answers no-referrer', async () => {
      const r = await get(`/invite/${'z'.repeat(43)}`);
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.headers['content-security-policy']).toBeTruthy();
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    });

    it('Изменяющий запрос с чужого сайта: Origin of the old address or none → 403, no session created', async () => {
      const before = Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions`)).rows[0].n);
      for (const origin of ['https://hub.internal.example.com', null]) {
        const r = await send('POST', '/api/sessions', ivan, { runnerId: 'x', cwd: '/x', model: 'opus', prompt: 'hi' }, origin);
        expect(r.statusCode).toBe(403);
      }
      expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions`)).rows[0].n)).toBe(before);
    });
  });

  describe('Закрыто по умолчанию', () => {
    it('without a cookie only the listed paths answer; everything else is 401 unauthenticated', async () => {
      const open: string[] = [];
      for (const r of t.hub.routes) {
        const url = r.url.replace(/:[A-Za-z]+/g, 'x').replace(/\*$/, 'x');
        const res = await app().inject({ method: r.method as 'GET', url, headers: { origin: PUBLIC_URL }, payload: r.method === 'GET' ? undefined : {} });
        if (res.statusCode !== 401) open.push(`${r.method} ${r.url}`);
        else expect(res.json(), `${r.method} ${r.url}`).toEqual({ error: 'unauthenticated' });
      }
      const allowed = [
        'GET /healthz',
        'GET /metrics',
        'GET /auth/login',
        'GET /auth/callback',
        'POST /auth/logout',
        'GET /auth/disabled',
        'GET /auth/desktop/start',
        'GET /auth/desktop/callback',
        'POST /auth/desktop/exchange',
        'GET /invite/:code',
        'GET /install.sh',
        'GET /install.ps1',
        'GET /agent/latest.json',
        'GET /agent/:file',
        'POST /enroll',
        // mcp-management: the handler redirects to the login itself
        'GET /mcp/oauth/callback',
      ];
      // /agent-api/* and /ws/agent answer only to a runner token: without one they are 401 like the rest
      expect(open.sort()).toEqual(allowed.sort());
    });

    it('API без входа: GET /api/runners → 401 {"error":"unauthenticated"}; an unknown /api path too', async () => {
      for (const url of ['/api/runners', '/api/nothing-here']) {
        const r = await get(url);
        expect(r.statusCode).toBe(401);
        expect(r.json()).toEqual({ error: 'unauthenticated' });
      }
    });
  });
});

describe('multi-user: rate limits of the spec', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub({ limits: 'spec' });
  });
  afterAll(async () => t.close());

  it('Перебор кодов: the 11th wrong code a minute from one address → 429', async () => {
    const codes = [];
    for (let i = 0; i < 11; i++) {
      const r = await t.hub.app.inject({ method: 'POST', url: '/enroll', payload: { code: `${'b'.repeat(25)}${'234567abcdefg'[i]}`, hostname: 'h', os: 'linux', arch: 'x64' } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every(c => c === 410)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await t.hub.app.inject({ method: 'POST', url: '/enroll', payload: {} })).statusCode).toBe(429);
  });

  it('Перебор кодов in parallel: 15 wrong codes at once from one address → exactly 10 answered, 5 × 429', async () => {
    const rs = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        t.hub.app.inject({
          method: 'POST',
          url: '/enroll',
          remoteAddress: '198.51.100.20',
          payload: { code: `${'c'.repeat(24)}${'234567abcdefghijk'.slice(i, i + 2)}`, hostname: 'h', os: 'linux', arch: 'x64' },
        }),
      ),
    );
    const codes = rs.map(r => r.statusCode).sort();
    expect(codes.filter(c => c === 410)).toHaveLength(10);
    expect(codes.filter(c => c === 429)).toHaveLength(5);
  });

  it('Перебор токенов агента: the 11th bad token a minute → 429 before the handshake', async () => {
    const results: number[] = [];
    for (let i = 0; i < 11; i++) results.push(await wsStatus(`${t.wsBase}/ws/agent`, { Authorization: `Bearer bad-${i}` }));
    expect(results.slice(0, 10).every(c => c === 101)).toBe(true);
    expect(results[10]).toBe(429);
  });

  it('login start: 21st a minute → 429; the invite page: 21st → 429', async () => {
    const login = [];
    for (let i = 0; i < 21; i++) login.push((await t.hub.app.inject({ method: 'GET', url: '/auth/login' })).statusCode);
    expect(login.slice(0, 20).every(c => c === 200)).toBe(true);
    expect(login[20]).toBe(429);
    const inv = [];
    for (let i = 0; i < 21; i++) inv.push((await t.hub.app.inject({ method: 'GET', url: `/invite/${'x'.repeat(43)}` })).statusCode);
    expect(inv.slice(0, 20).every(c => c === 404)).toBe(true);
    expect(inv[20]).toBe(429);
  });

  it('the address comes from X-Forwarded-For only behind a trusted proxy (loopback in tests is trusted)', async () => {
    // a different forwarded address is a different bucket: not limited by the 11 bad codes above
    const r = await t.hub.app.inject({ method: 'POST', url: '/enroll', headers: { 'x-forwarded-for': '198.51.100.9' }, payload: { code: 'c'.repeat(26), hostname: 'h', os: 'linux', arch: 'x64' } });
    expect(r.statusCode).toBe(410);
  });
});

describe('multi-user: the enroll limit counts only wrong codes', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub({ limits: 'spec' });
  });
  afterAll(async () => t.close());
  it('a successful exchange is not counted as a wrong code', async () => {
    const ip = '198.51.100.21';
    const wrong = (k: number) =>
      t.hub.app.inject({ method: 'POST', url: '/enroll', remoteAddress: ip, payload: { code: `${'d'.repeat(25)}${'234567abcdefg'[k]}`, hostname: 'h', os: 'linux', arch: 'x64' } });
    for (let k = 0; k < 9; k++) expect((await wrong(k)).statusCode).toBe(410);
    const session = await t.login();
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/runners',
      headers: { origin: t.config.PUBLIC_URL },
      cookies: { ah_session: session },
      payload: { name: 'Лимит', os: 'linux' },
    });
    expect(created.statusCode).toBe(201);
    const ok = await t.hub.app.inject({ method: 'POST', url: '/enroll', remoteAddress: ip, payload: { code: created.json().code, hostname: 'h-ok', os: 'linux', arch: 'x64' } });
    expect(ok.statusCode).toBe(200);
    // 9 wrong + 1 success: the 10th wrong code is still answered, the 11th is refused
    expect((await wrong(9)).statusCode).toBe(410);
    expect((await wrong(10)).statusCode).toBe(429);
  });
});

describe('multi-user: the agent build and the installers (task 5.4)', () => {
  let t: TestHub;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-hub-dist-'));
    writeFileSync(join(dir, 'agent-0.1.0.tgz'), Buffer.from('old build'));
    writeFileSync(join(dir, 'agent-0.2.0.tgz'), Buffer.from('new build'));
    writeFileSync(join(dir, 'install.sh'), '#!/usr/bin/env bash\nHUB_URL="__HUB_URL__"\necho "$HUB_URL" __HUB_URL__\n');
    writeFileSync(join(dir, 'install.ps1'), '﻿$HubUrl = "__HUB_URL__"\n');
    t = await startTestHub({ env: { AGENT_DIST_DIR: dir, INSTALLERS_DIR: dir } });
  });
  afterAll(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('/agent/latest.json names the highest build; its SHA-256 equals the file served', async () => {
    const latest = await t.hub.app.inject({ method: 'GET', url: '/agent/latest.json' });
    expect(latest.statusCode).toBe(200);
    const body = latest.json();
    expect(body).toMatchObject({ version: '0.2.0', url: '/agent/agent-0.2.0.tgz', size: 9 });
    const file = await t.hub.app.inject({ method: 'GET', url: body.url });
    expect(file.statusCode).toBe(200);
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(body.sha256);
    expect((await t.hub.app.inject({ method: 'GET', url: '/agent/agent-9.9.9.tgz' })).statusCode).toBe(404);
    expect((await t.hub.app.inject({ method: 'GET', url: '/agent/..%2Finstall.sh' })).statusCode).toBe(404);
  });

  it('/install.sh: __HUB_URL__ → PUBLIC_URL everywhere; /install.ps1 without its BOM, utf-8; a missing template → 404', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/install.sh' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(`#!/usr/bin/env bash\nHUB_URL="${PUBLIC_URL}"\necho "$HUB_URL" ${PUBLIC_URL}\n`);
    const ps = await t.hub.app.inject({ method: 'GET', url: '/install.ps1' });
    expect(ps.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(ps.body).toBe(`$HubUrl = "${PUBLIC_URL}"\n`);
    rmSync(join(dir, 'install.ps1'));
    expect((await t.hub.app.inject({ method: 'GET', url: '/install.ps1' })).statusCode).toBe(404);
  });

  it('Самообновление: a 1.5 agent older than the build gets agent.update; «устарела» in RunnerView; a failed update is not offered again', async () => {
    const token = await t.addRunner('upd');
    const a = connectFakeAgent(t.wsBase, token, { agentVersion: '0.1.0', protocol: '1.5' });
    const upd = await a.next('agent.update');
    expect(upd.payload).toEqual({ version: '0.2.0', sha256: createHash('sha256').update('new build').digest('hex'), url: '/agent/agent-0.2.0.tgz' });
    const session = await t.login();
    const view = (await t.hub.app.inject({ method: 'GET', url: '/api/runners/upd', cookies: { ah_session: session } })).json();
    expect(view).toMatchObject({ outdated: true, update: { version: '0.2.0', status: 'sent' } });
    agentSend(a, 'agent.update.result', { version: '0.2.0', status: 'failed', error: 'sha_mismatch' });
    await waitFor(async () => (await t.hub.app.inject({ method: 'GET', url: '/api/runners/upd', cookies: { ah_session: session } })).json().update?.status === 'failed');
    a.ws.close();
    await a.closed;
    const b = connectFakeAgent(t.wsBase, token, { agentVersion: '0.1.0', protocol: '1.5' });
    await b.next('welcome');
    await new Promise(r => setTimeout(r, 300));
    expect(b.messages.some(m => m.type === 'agent.update')).toBe(false);
    b.ws.close();
    await b.closed;
    // the new version connects: the update is done
    const c = connectFakeAgent(t.wsBase, token, { agentVersion: '0.2.0', protocol: '1.5' });
    await c.next('welcome');
    await waitFor(async () => {
      const v = (await t.hub.app.inject({ method: 'GET', url: '/api/runners/upd', cookies: { ah_session: session } })).json();
      return v.update === null && v.outdated === false;
    });
    c.ws.close();
  });

  it('Экран «Машины»: GET /api/sidebar marks a runner below the build «устарела» like /api/runners; the mark is gone after the update', async () => {
    const token = await t.addRunner('side-old');
    const session = await t.login();
    const sidebar = async () =>
      ((await t.hub.app.inject({ method: 'GET', url: '/api/sidebar', cookies: { ah_session: session } })).json().runners as Array<{ id: string; outdated: boolean; agentVersion: string | null }>).find(
        r => r.id === 'side-old',
      );
    const a = connectFakeAgent(t.wsBase, token, { agentVersion: '0.1.0', protocol: '1.4' });
    await a.next('welcome');
    await waitFor(async () => (await sidebar())?.agentVersion === '0.1.0');
    expect(await sidebar()).toMatchObject({ outdated: true });
    const runners = (await t.hub.app.inject({ method: 'GET', url: '/api/runners', cookies: { ah_session: session } })).json().runners as Array<{ id: string; outdated: boolean }>;
    expect(runners.find(r => r.id === 'side-old')).toMatchObject({ outdated: true });
    a.ws.close();
    await a.closed;
    const b = connectFakeAgent(t.wsBase, token, { agentVersion: '0.2.0', protocol: '1.4' });
    await b.next('welcome');
    await waitFor(async () => (await sidebar())?.agentVersion === '0.2.0');
    expect(await sidebar()).toMatchObject({ outdated: false });
    b.ws.close();
  });

  it.each(['1.3', '1.4'])('an agent of %s (before 1.5) works and never gets agent.update', async protocol => {
    const token = await t.addRunner(`old-${protocol.replace('.', '')}`);
    const a = connectFakeAgent(t.wsBase, token, { agentVersion: '0.1.0', protocol });
    await a.next('welcome');
    await new Promise(r => setTimeout(r, 300));
    expect(a.messages.some(m => m.type === 'agent.update')).toBe(false);
    a.ws.send(JSON.stringify(envelope('ping', {})));
    a.ws.close();
  });
});
