// Change multi-user, tasks 3.2 and 3.3 (design M3): two users with data in every user table; every Fastify route and
// every /ws/ui message type from the second user with the ids of the first → 404 / 403 / empty, and never a byte of
// the first user's data. A route that is not in ROUTES below fails the test: a new route needs its isolation case.
// The same ROUTES are walked a second time by the administrator against the objects of a user (scenario «Прямой запрос
// чужой сессии»): the role admin gives the /api/admin/* screens, not access to the users' sessions and machines.
// Task 3.5: subscriptions (claude-subscriptions) are per user — registry, last choice, usage, `subscriptions.changed`.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uiClientMessageSchema } from '@agent-hub/shared';
import { ALLOWED_EMAIL, PUBLIC_URL, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { issueRunnerToken } from '../runners/repo.js';
import { endpointHash } from '../push/repo.js';

const SECRET_TITLE = 'Секретная сессия Ивана';
const SECRET_WORD = 'барокамерасекрет';
const SHA = 'f'.repeat(64);
const K_TITLE = 'Сессия Бориса';
const K_WORD = 'бориссекретслово';
const K_SHA = 'e'.repeat(64);
const K_RUNNER = 'r-bobhp00';
const K_RUNNER_NAME = 'Ноутбук Бориса';
const SUB_NAME = 'Подписка Ивана секрет';
const SUB_TOKEN = 'sk-ant-oat01-' + 'Iv4nTok'.repeat(12) + 'QwZx';
const K_SUB_NAME = 'Подписка Бориса секрет';
const K_SUB_TOKEN = 'sk-ant-oat01-' + 'KsEnTok'.repeat(12) + 'PlMn';
const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64');
const PUSH_ENDPOINT = 'https://push.example.com/send/ivan-isolation-endpoint';
const K_PUSH_ENDPOINT = 'https://push.example.com/send/bob-isolation-endpoint';

type Objects = {
  session: string;
  runner: string;
  project: string;
  catalogProject: string;
  draft: string;
  subagent: string;
  request: string;
  sha: string;
  word: string;
  sub: string;
  registryServer: string;
  pushId: string;
  pushHash: string;
  pushEndpoint: string;
};

describe('isolation of users (integration)', () => {
  let t: TestHub;
  let ivan: string;
  let bob: string;
  let ivanId: string;
  let bobId: string;
  let agent: FakeAgent;
  let kAgent: FakeAgent;
  const commands: string[] = [];
  const kCommands: string[] = [];
  const A = { sha: SHA, word: SECRET_WORD, registryServer: randomUUID() } as Objects;
  const B = { sha: K_SHA, word: K_WORD, runner: K_RUNNER, registryServer: randomUUID() } as Objects;

  beforeAll(async () => {
    // subscriptions, dictation and the voice conversation on: their routes answer as in production (no 503)
    t = await startTestHub({
      env: {
        SUBSCRIPTION_TOKEN_KEY: TOKEN_KEY,
        ELEVENLABS_API_KEY: 'sk_test',
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: 'mailto:ops@example.com',
        VOICE_AGENT_ID: 'agent_test',
        VOICE_LLM_KEY: 'v'.repeat(40),
      },
      push: { sender: { send: async () => ({ ok: true as const }) } },
      voice: { fetch: (() => Promise.reject(new Error('no ElevenLabs in this test'))) as typeof fetch },
    });
    ivan = await t.login();
    ivanId = (await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: ivan } })).json().user.id;
    // Ivan's machine online: a command that reached it would be seen here.
    const token = await t.addRunner('hp', 'HP Ивана');
    agent = connectFakeAgent(t.wsBase, token, { hostname: 'HP-Elitebook', homeDir: '/home/ubuntu', vaultRoot: null, os: 'Ubuntu' });
    await agent.next('welcome');
    autoReply(agent, type => {
      commands.push(type);
      return {};
    });
    A.runner = 'hp';
    const q = (text: string, values: unknown[]) => t.tdb.pool.query(text, values);
    A.session = (
      await q(
        `INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, title, cwd, unread) VALUES ($1, 'hp', gen_random_uuid(), 'hub', 'waiting', $2, '/home/ubuntu/code', true) RETURNING id`,
        [ivanId, SECRET_TITLE],
      )
    ).rows[0].id;
    const file = (
      await q(
        `INSERT INTO transcript_files (user_id, session_id, runner_id, claude_session_id, rel_key, rel_path, kind) SELECT user_id, id, runner_id, claude_session_id, 'p/x.jsonl', 'p/x.jsonl', 'main' FROM sessions WHERE id = $1 RETURNING id`,
        [A.session],
      )
    ).rows[0].id;
    await q(`INSERT INTO events (file_id, generation, line_no, session_id, uuid, type, ts, payload, search_text) VALUES ($1, 0, 0, $2, gen_random_uuid(), 'user', now(), $3, $4)`, [
      file,
      A.session,
      JSON.stringify({ type: 'user', message: { content: SECRET_WORD } }),
      SECRET_WORD,
    ]);
    A.request = randomUUID();
    await q(`INSERT INTO permission_requests (request_id, session_id, tool_name, tool_use_id, input, suggestions) VALUES ($1, $2, 'Bash', 'toolu_1', '{"command":"ls"}', '[]')`, [
      A.request,
      A.session,
    ]);
    await q(`INSERT INTO session_notes (session_id, kind, text) VALUES ($1, 'info', $2)`, [A.session, SECRET_TITLE]);
    A.project = (
      await q(`INSERT INTO projects (user_id, kind, path, slug, title, origin) VALUES ($1, 'project', 'x/secret', 'secret', $2, 'index') RETURNING id`, [ivanId, `${SECRET_TITLE} проект`])
    ).rows[0].id;
    A.catalogProject = (await q(`INSERT INTO catalog_projects (user_id,name,description) VALUES ($1,$2,'private') RETURNING id`, [ivanId, `${SECRET_TITLE} catalog`])).rows[0].id;
    await q(`INSERT INTO project_bindings (user_id,project_id,runner_id,path) VALUES ($1,$2,'hp','/home/ivan/private')`, [ivanId, A.catalogProject]);
    await q(`INSERT INTO classification_labels (session_id, project_id, user_id) VALUES ($1, $2, $3)`, [A.session, A.project, ivanId]);
    A.draft = (await q(`INSERT INTO handoff_drafts (user_id, session_id, status, text) VALUES ($1, $2, 'ready', $3) RETURNING id`, [ivanId, A.session, SECRET_TITLE])).rows[0].id;
    A.subagent = (await q(`INSERT INTO subagent_runs (user_id, session_id, agent_id, description) VALUES ($1, $2, 'a1', $3) RETURNING id`, [ivanId, A.session, SECRET_TITLE])).rows[0].id;
    await q(`INSERT INTO blobs (sha256, s3_key, size, mime) VALUES ($1, 'blobs/x', 3, 'image/png')`, [SHA]);
    await q(`INSERT INTO blob_owners (sha256, user_id) VALUES ($1, $2)`, [SHA, ivanId]);
    await q(`INSERT INTO uploads (sha256, user_id) VALUES ($1, $2)`, [SHA, ivanId]);
    await q(`INSERT INTO ui_layouts (user_id, device_class, layout, opened_at) VALUES ($1, 'desktop', $2, '{}')`, [ivanId, JSON.stringify({ seq: 1, focus: A.session })]);
    await q(`INSERT INTO security_events (user_id, kind, runner_id) VALUES ($1, 'runner_connected', 'hp')`, [ivanId]);
    A.pushEndpoint = PUSH_ENDPOINT;
    A.pushHash = endpointHash(PUSH_ENDPOINT);
    A.pushId = (
      await q(`INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, device_label) VALUES ($1, $2, $3, 'p256dh-ivan', 'auth-ivan', 'Chrome · Windows') RETURNING id`, [
        ivanId,
        PUSH_ENDPOINT,
        A.pushHash,
      ])
    ).rows[0].id;
    A.sub = await addSubscription(ivan, SUB_NAME, SUB_TOKEN);
    await subscriptionData(ivanId, A.session, 'hp', A.sub, 777001);

    // Bob: invited, her own machine and a session in the same directory (scenario «Одинаковый каталог»).
    const inv = await t.hub.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { origin: PUBLIC_URL },
      cookies: { ah_session: ivan },
      payload: { email: 'bob@example.com', provider: 'google' },
    });
    bob = await t.login({ email: 'bob@example.com' }, { invite: (inv.json().url as string).split('/invite/')[1]! });
    bobId = (await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: bob } })).json().user.id;
    await q(`INSERT INTO runners (id, user_id, name, hostname) VALUES ($1, $2, $3, 'HP-Elitebook')`, [K_RUNNER, bobId, K_RUNNER_NAME]);
    B.session = (
      await q(
        `INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, title, cwd, unread) VALUES ($1, $2, gen_random_uuid(), 'terminal', 'closed', $3, '/home/ubuntu/code', true) RETURNING id`,
        [bobId, K_RUNNER, K_TITLE],
      )
    ).rows[0].id;
    // Her objects in every user table, for the administrator's walk.
    const kFile = (
      await q(
        `INSERT INTO transcript_files (user_id, session_id, runner_id, claude_session_id, rel_key, rel_path, kind) SELECT user_id, id, runner_id, claude_session_id, 'k/x.jsonl', 'k/x.jsonl', 'main' FROM sessions WHERE id = $1 RETURNING id`,
        [B.session],
      )
    ).rows[0].id;
    await q(`INSERT INTO events (file_id, generation, line_no, session_id, uuid, type, ts, payload, search_text) VALUES ($1, 0, 0, $2, gen_random_uuid(), 'user', now(), $3, $4)`, [
      kFile,
      B.session,
      JSON.stringify({ type: 'user', message: { content: K_WORD } }),
      K_WORD,
    ]);
    B.request = randomUUID();
    await q(`INSERT INTO permission_requests (request_id, session_id, tool_name, tool_use_id, input, suggestions) VALUES ($1, $2, 'Bash', 'toolu_2', '{"command":"ls"}', '[]')`, [
      B.request,
      B.session,
    ]);
    await q(`INSERT INTO session_notes (session_id, kind, text) VALUES ($1, 'info', $2)`, [B.session, K_WORD]);
    B.project = (
      await q(`INSERT INTO projects (user_id, kind, path, slug, title, origin) VALUES ($1, 'project', 'k/secret', 'ksecret', $2, 'index') RETURNING id`, [bobId, `${K_WORD} проект`])
    ).rows[0].id;
    B.catalogProject = (await q(`INSERT INTO catalog_projects (user_id,name,description) VALUES ($1,$2,'private') RETURNING id`, [bobId, `${K_WORD} catalog`])).rows[0].id;
    await q(`INSERT INTO project_bindings (user_id,project_id,runner_id,path) VALUES ($1,$2,$3,'/home/bob/private')`, [bobId, B.catalogProject, K_RUNNER]);
    await q(`INSERT INTO classification_labels (session_id, project_id, user_id) VALUES ($1, $2, $3)`, [B.session, B.project, bobId]);
    B.draft = (await q(`INSERT INTO handoff_drafts (user_id, session_id, status, text) VALUES ($1, $2, 'ready', $3) RETURNING id`, [bobId, B.session, K_WORD])).rows[0].id;
    B.subagent = (await q(`INSERT INTO subagent_runs (user_id, session_id, agent_id, description) VALUES ($1, $2, 'k1', $3) RETURNING id`, [bobId, B.session, K_WORD])).rows[0].id;
    await q(`INSERT INTO blobs (sha256, s3_key, size, mime) VALUES ($1, 'blobs/k', 3, 'image/png')`, [K_SHA]);
    await q(`INSERT INTO blob_owners (sha256, user_id) VALUES ($1, $2)`, [K_SHA, bobId]);
    await q(`INSERT INTO uploads (sha256, user_id) VALUES ($1, $2)`, [K_SHA, bobId]);
    await q(`INSERT INTO ui_layouts (user_id, device_class, layout, opened_at) VALUES ($1, 'desktop', $2, '{}')`, [bobId, JSON.stringify({ seq: 1, focus: B.session })]);
    await q(`INSERT INTO security_events (user_id, kind, runner_id) VALUES ($1, 'runner_connected', $2)`, [bobId, K_RUNNER]);
    B.pushEndpoint = K_PUSH_ENDPOINT;
    B.pushHash = endpointHash(K_PUSH_ENDPOINT);
    B.pushId = (
      await q(`INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, device_label) VALUES ($1, $2, $3, 'p256dh-bob', 'auth-bob', 'Firefox · Linux') RETURNING id`, [
        bobId,
        K_PUSH_ENDPOINT,
        B.pushHash,
      ])
    ).rows[0].id;
    B.sub = await addSubscription(bob, K_SUB_NAME, K_SUB_TOKEN);
    await subscriptionData(bobId, B.session, K_RUNNER, B.sub, 888001);
    // Her machine online: a command of the administrator that reached it would be seen here.
    kAgent = connectFakeAgent(t.wsBase, await issueRunnerToken(t.tdb.db, K_RUNNER), { hostname: 'HP-Elitebook', homeDir: '/home/ubuntu', vaultRoot: null, os: 'Ubuntu' });
    await kAgent.next('welcome');
    autoReply(kAgent, type => {
      kCommands.push(type);
      return {};
    });
  });
  afterAll(async () => t.close());

  /** A subscription through the API (the token encrypted as in production); returns its id. */
  async function addSubscription(cookie: string, name: string, token: string): Promise<string> {
    const r = await t.hub.app.inject({ method: 'POST', url: '/api/subscriptions', headers: { origin: PUBLIC_URL }, cookies: { ah_session: cookie }, payload: { name, token } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }
  /** The last choice, the session's subscription and a finished turn under it (usage). */
  async function subscriptionData(userId: string, sessionId: string, runnerId: string, subId: string, tokens: number): Promise<void> {
    const q = (text: string, values: unknown[]) => t.tdb.pool.query(text, values);
    await q(`UPDATE users SET last_subscription_id = $2 WHERE id = $1`, [userId, subId]);
    await q(`UPDATE sessions SET subscription_id = $2 WHERE id = $1`, [sessionId, subId]);
    await q(`INSERT INTO session_turns (user_id, session_id, runner_id, subscription_id, ended_at, is_error, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, now(), false, $5, 1)`, [
      userId,
      sessionId,
      runnerId,
      subId,
      tokens,
    ]);
  }
  /** The victim's subscription, last choice and usage after the other user's walk: unchanged, the token still his. */
  async function expectSubscriptionIntact(userId: string, subId: string, name: string, token: string, own: number): Promise<void> {
    const row = (await t.tdb.pool.query(`SELECT s.name, s.token_hint, s.position, s.retired_at, u.last_subscription_id FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [subId]))
      .rows[0];
    expect(row).toMatchObject({ name, token_hint: token.slice(-4), position: 0, retired_at: null, last_subscription_id: subId });
    const cred = await t.hub.sessions.subscriptions!.credFor(userId, { protocol_version: '1.5' });
    expect(cred).toMatchObject({ id: subId, token });
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1`, [userId])).rows[0].n).toBe(own);
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM session_turns WHERE user_id = $1`, [userId])).rows[0].n).toBe(1);
  }

  /** Values of the first user that must never reach the second. */
  const secrets = () => [
    A.session,
    A.project,
    A.catalogProject,
    A.draft,
    A.subagent,
    A.request,
    A.sub,
    SUB_NAME,
    SUB_TOKEN,
    '777001',
    SECRET_TITLE,
    SECRET_WORD,
    'HP Ивана',
    ALLOWED_EMAIL,
    A.pushId,
    A.pushHash,
    A.pushEndpoint,
    'p256dh-ivan',
    'auth-ivan',
  ];
  /** Values of the user that the administrator never gets (her e-mail and name he sees on «Пользователи»). */
  const kSecrets = () => [
    B.session,
    B.project,
    B.catalogProject,
    B.draft,
    B.subagent,
    B.request,
    B.sub,
    K_SUB_NAME,
    K_SUB_TOKEN,
    '888001',
    K_TITLE,
    K_WORD,
    K_RUNNER,
    K_RUNNER_NAME,
    B.pushId,
    B.pushHash,
    B.pushEndpoint,
    'p256dh-bob',
    'auth-bob',
  ];

  type Case = { url: string; body?: unknown; list?: true };
  /** Every route: the request aimed at the objects `o` of another user (`victim` — his id). */
  const ROUTES = (o: Objects = A, victim = ivanId): Record<string, Case> => ({
    'GET /healthz': { url: '/healthz', list: true },
    'GET /metrics': { url: '/metrics', list: true },
    'GET /api/me': { url: '/api/me', list: true },
    'GET /agent-api/restore/:token': { url: '/agent-api/restore/x' },
    'GET /agent-api/blobs/:token': { url: '/agent-api/blobs/x' },
    'GET /auth/login': { url: '/auth/login', list: true },
    'GET /auth/callback': { url: '/auth/callback' },
    'POST /auth/logout': { url: '/auth/logout', list: true },
    'GET /auth/disabled': { url: '/auth/disabled', list: true },
    'GET /auth/provider-logout': { url: '/auth/provider-logout', list: true },
    'GET /invite/:code': { url: `/invite/${'x'.repeat(43)}` },
    'POST /api/auth/logout-all': { url: '/api/auth/logout-all', list: true },
    'GET /auth/desktop/start': { url: '/auth/desktop/start' },
    'GET /auth/desktop/callback': { url: '/auth/desktop/callback' },
    'POST /auth/desktop/exchange': { url: '/auth/desktop/exchange', body: {} },
    'GET /api/desktop/updates/:file': { url: '/api/desktop/updates/latest.yml' },
    'GET /agent/latest.json': { url: '/agent/latest.json' },
    'GET /agent/:file': { url: '/agent/agent-0.1.0.tgz' },
    'GET /install.sh': { url: '/install.sh' },
    'GET /install.ps1': { url: '/install.ps1' },
    'GET /api/sidebar': { url: '/api/sidebar?cron=1', list: true },
    'GET /api/preferences/launch': { url: '/api/preferences/launch', list: true },
    'PUT /api/preferences/locale': { url: '/api/preferences/locale', body: { locale: 'de' }, list: true },
    'GET /api/catalog/projects': { url: '/api/catalog/projects', list: true },
    'POST /api/catalog/projects': { url: '/api/catalog/projects', body: { name: 'Isolation probe' }, list: true },
    'DELETE /api/catalog/projects/:id': { url: `/api/catalog/projects/${o.catalogProject}` },
    'DELETE /api/catalog/projects/:id/bindings/:runnerId': { url: `/api/catalog/projects/${o.catalogProject}/bindings/${o.runner}` },
    'PATCH /api/catalog/projects/:id': { url: `/api/catalog/projects/${o.catalogProject}`, body: { archived: true } },
    'PUT /api/catalog/projects/:id/bindings/:runnerId': { url: `/api/catalog/projects/${o.catalogProject}/bindings/${o.runner}`, body: { path: '/private/stolen' } },
    'GET /api/catalog/projects/:id/resolve': { url: `/api/catalog/projects/${o.catalogProject}/resolve?runnerId=${o.runner}` },
    'GET /api/catalog/projects/:id/sessions': { url: `/api/catalog/projects/${o.catalogProject}/sessions` },
    'PATCH /api/projects/:id/color': { url: `/api/projects/${o.project}/color`, body: { colorKey: 'rose' } },
    'GET /api/projects/hidden': { url: '/api/projects/hidden', list: true },
    'PUT /api/projects/:id/hidden': { url: `/api/projects/${o.project}/hidden` },
    'DELETE /api/projects/:id/hidden': { url: `/api/projects/${o.project}/hidden` },
    'DELETE /api/projects/:id/group': { url: `/api/projects/${o.project}/group` },
    'GET /api/projects/:id/sessions': { url: `/api/projects/${o.project}/sessions` },
    'GET /api/projects': { url: '/api/projects', list: true },
    'PUT /api/sessions/:id/project': { url: `/api/sessions/${o.session}/project`, body: { projectId: 'none' } },
    'POST /api/sessions/:id/project-suggestion': {
      url: `/api/sessions/${o.session}/project-suggestion`,
      body: { action: 'accept', projectId: '00000000-0000-4000-8000-000000000000', inputHash: '0'.repeat(64) },
    },
    'POST /api/sessions/:id/pin': { url: `/api/sessions/${o.session}/pin`, body: {} },
    'DELETE /api/sessions/:id/pin': { url: `/api/sessions/${o.session}/pin` },
    'GET /api/models': { url: '/api/models', list: true },
    'GET /api/search': { url: `/api/search?q=${encodeURIComponent(o.word)}&cron=1`, list: true },
    'GET /api/runners/:id/stat': { url: `/api/runners/${o.runner}/stat?path=${encodeURIComponent('/home/ubuntu')}` },
    'POST /api/sessions': { url: '/api/sessions', body: { runnerId: o.runner, cwd: '/home/ubuntu/code', model: 'opus', prompt: 'hi' } },
    'POST /api/sessions/resolve': { url: '/api/sessions/resolve', body: { ids: [o.session] }, list: true },
    'GET /api/sessions/:id': { url: `/api/sessions/${o.session}` },
    'POST /api/sessions/:id/fork': { url: `/api/sessions/${o.session}/fork`, body: { mode: 'copy' } },
    'POST /api/sessions/:id/title/regenerate': { url: `/api/sessions/${o.session}/title/regenerate`, body: {} },
    'POST /api/sessions/:id/handoff-drafts': { url: `/api/sessions/${o.session}/handoff-drafts`, body: {} },
    'GET /api/handoff-drafts/:id': { url: `/api/handoff-drafts/${o.draft}` },
    'GET /api/sessions/:id/events': { url: `/api/sessions/${o.session}/events` },
    'GET /api/sessions/:id/subagents': { url: `/api/sessions/${o.session}/subagents` },
    'GET /api/subagents/:id': { url: `/api/subagents/${o.subagent}` },
    'GET /api/subagents/:id/events': { url: `/api/subagents/${o.subagent}/events` },
    'POST /api/sessions/:id/messages': { url: `/api/sessions/${o.session}/messages`, body: { text: 'hi', clientUuid: randomUUID() } },
    'POST /api/sessions/:id/wake': { url: `/api/sessions/${o.session}/wake`, body: {} },
    'POST /api/sessions/:id/interrupt': { url: `/api/sessions/${o.session}/interrupt`, body: {} },
    'PATCH /api/sessions/:id': { url: `/api/sessions/${o.session}`, body: { permissionMode: 'plan' } },
    'POST /api/sessions/:id/permissions/:requestId': { url: `/api/sessions/${o.session}/permissions/${o.request}`, body: { decision: 'allow' } },
    'GET /api/layout': { url: '/api/layout?device=desktop', list: true },
    'PUT /api/layout': { url: '/api/layout', body: { device: 'phone', layout: null, savedLayout: null }, list: true },
    'GET /api/blobs/:sha256': { url: `/api/blobs/${o.sha}` },
    'POST /api/uploads': { url: '/api/uploads', body: 'not an image' },
    'GET /api/sessions/:id/tool-results/:name': { url: `/api/sessions/${o.session}/tool-results/x.txt` },
    'POST /api/sessions/:id/images': { url: `/api/sessions/${o.session}/images`, body: { path: '/home/ubuntu/a.png' } },
    'GET /api/admin/invites': { url: '/api/admin/invites' },
    'POST /api/admin/invites': { url: '/api/admin/invites', body: { email: 'x@example.com', provider: 'google' } },
    'DELETE /api/admin/invites/:id': { url: `/api/admin/invites/${randomUUID()}` },
    'GET /api/admin/users': { url: '/api/admin/users' },
    'POST /api/admin/users/:id/disable': { url: `/api/admin/users/${victim}/disable`, body: {} },
    'POST /api/admin/users/:id/enable': { url: `/api/admin/users/${victim}/enable`, body: {} },
    'GET /api/runners': { url: '/api/runners', list: true },
    'POST /api/runners': { url: '/api/runners', body: { name: 'Новая машина', os: 'linux' }, list: true },
    'GET /api/runners/:id': { url: `/api/runners/${o.runner}` },
    'GET /api/runners/:runnerId/directories': { url: `/api/runners/${o.runner}/directories` },
    'GET /api/runners/:runnerId/fs/list': { url: `/api/runners/${o.runner}/fs/list` },
    'GET /api/runners/:runnerId/fs/file': { url: `/api/runners/${o.runner}/fs/file?path=${encodeURIComponent('/home/ubuntu/notes.md')}` },
    'GET /api/runners/:runnerId/fs/download': { url: `/api/runners/${o.runner}/fs/download?path=${encodeURIComponent('/home/ubuntu/notes.md')}` },
    'PATCH /api/runners/:id': { url: `/api/runners/${o.runner}`, body: { name: 'x' } },
    'POST /api/runners/:id/enroll-code': { url: `/api/runners/${o.runner}/enroll-code`, body: {} },
    'POST /api/runners/:id/disable': { url: `/api/runners/${o.runner}/disable`, body: {} },
    'POST /enroll': { url: '/enroll', body: { code: 'a'.repeat(26), hostname: 'h', os: 'linux', arch: 'x64' } },
    'GET /api/security': { url: '/api/security', list: true },
    // Task 3.5: the registry, the last choice and the usage are the user's own; another user's subscription → 404
    'GET /api/subscriptions': { url: '/api/subscriptions', list: true },
    'POST /api/subscriptions': { url: '/api/subscriptions', body: { name: `Своя ${randomUUID().slice(0, 8)}`, token: 'sk-ant-oat01-' + 'OwnTokn'.repeat(12) }, list: true },
    'POST /api/subscriptions/codex-login': { url: '/api/subscriptions/codex-login', body: { runnerId: o.runner, name: 'Codex чужой' } },
    'PUT /api/subscriptions/order': { url: '/api/subscriptions/order', body: { ids: [o.sub] } },
    'GET /api/subscriptions/usage': { url: '/api/subscriptions/usage', list: true },
    'PATCH /api/subscriptions/:id': { url: `/api/subscriptions/${o.sub}`, body: { name: 'x' } },
    'PUT /api/subscriptions/:id/token': { url: `/api/subscriptions/${o.sub}/token`, body: { token: 'sk-ant-oat01-' + 'Stolen1'.repeat(12) } },
    // subscription-limits: the own (possibly empty) list; the other user's subscription → 404, no probe sent
    'GET /api/subscriptions/limits': { url: '/api/subscriptions/limits', list: true },
    'POST /api/subscriptions/:id/limits/refresh': { url: `/api/subscriptions/${o.sub}/limits/refresh`, body: {} },
    'POST /api/sessions/:id/subscription': { url: `/api/sessions/${o.session}/subscription`, body: { subscriptionId: o.sub } },
    'POST /api/voice/transcribe': { url: '/api/voice/transcribe', body: 'not audio' },
    // voice-conversation: a link for another user's session → 404, no ElevenLabs request; the Custom LLM answers only to its key
    'GET /api/voice/talk': { url: `/api/voice/talk?session=${o.session}` },
    'POST /voice-llm/v1/chat/completions': { url: '/voice-llm/v1/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } },
    // session-peers: the journal of another user's session → 404
    'GET /api/peers/messages': { url: `/api/peers/messages?session=${o.session}` },
    // web-push-notifications: the devices are the user's own; another user's id or hash → 404 / nothing deleted, no test push sent
    'GET /api/push/subscriptions': { url: '/api/push/subscriptions', list: true },
    'POST /api/push/subscriptions': { url: '/api/push/subscriptions', body: { endpoint: 'https://push.example.com/send/own-walk', keys: { p256dh: 'own-p256dh', auth: 'own-auth' } }, list: true },
    'DELETE /api/push/subscriptions/:id': { url: `/api/push/subscriptions/${o.pushId}` },
    'DELETE /api/push/subscriptions': { url: `/api/push/subscriptions?endpointHash=${o.pushHash}`, list: true },
    'POST /api/push/test': { url: '/api/push/test', body: { endpointHash: o.pushHash } },
    // mcp-management (Права на MCP): the other user's session and machine → 404, nothing sent to the agent
    'GET /api/sessions/:id/mcp': { url: `/api/sessions/${o.session}/mcp` },
    'POST /api/sessions/:id/mcp/refresh': { url: `/api/sessions/${o.session}/mcp/refresh`, body: {} },
    'POST /api/sessions/:id/mcp/actions': { url: `/api/sessions/${o.session}/mcp/actions`, body: { server: 'vaultwarden', action: 'reconnect' } },
    'POST /api/sessions/:id/mcp/auth': { url: `/api/sessions/${o.session}/mcp/auth`, body: { server: 'notion' } },
    'POST /api/sessions/:id/mcp/logout': { url: `/api/sessions/${o.session}/mcp/logout`, body: { server: 'notion' } },
    'POST /api/sessions/:id/mcp/auth/callback': { url: `/api/sessions/${o.session}/mcp/auth/callback`, body: { server: 'notion', callbackUrl: 'http://localhost:1/callback?code=a&state=b' } },
    'GET /api/runners/:id/mcp': { url: `/api/runners/${o.runner}/mcp` },
    'POST /api/runners/:id/mcp/probe': { url: `/api/runners/${o.runner}/mcp/probe`, body: {} },
    // mcp-registry: owner-scoped registry, draft workflow and import.
    'GET /api/mcp/registry': { url: '/api/mcp/registry', list: true },
    'GET /api/mcp/registry/status': { url: '/api/mcp/registry/status', list: true },
    'PUT /api/mcp/registry/servers/:id/machines/:machineId': { url: `/api/mcp/registry/servers/${o.sub}/machines/${o.runner}`, body: { revision: 1, enabled: false } },
    'POST /api/mcp/registry/servers/:id/oauth/start': { url: `/api/mcp/registry/servers/${o.registryServer}/oauth/start`, body: { machineId: randomUUID() } },
    'POST /api/mcp/registry/servers/:id/oauth/complete': {
      url: `/api/mcp/registry/servers/${o.registryServer}/oauth/complete`,
      body: { machineId: randomUUID(), callbackUrl: 'http://localhost:45129/callback?code=a&state=b' },
    },
    'POST /api/mcp/registry/servers/:id/oauth/validate': { url: `/api/mcp/registry/servers/${o.registryServer}/oauth/validate`, body: { machineId: randomUUID() } },
    'POST /api/mcp/registry/servers/:id/oauth/connect': { url: `/api/mcp/registry/servers/${o.registryServer}/oauth/connect`, body: { machineId: randomUUID() } },
    'POST /api/mcp/registry/servers/:id/oauth/revoke': { url: `/api/mcp/registry/servers/${o.registryServer}/oauth/revoke`, body: { machineId: randomUUID() } },
    'POST /api/mcp/registry': { url: '/api/mcp/registry', body: {} },
    'GET /api/mcp/registry/servers/:id': { url: `/api/mcp/registry/servers/${o.sub}` },
    'PATCH /api/mcp/registry/servers/:id': { url: `/api/mcp/registry/servers/${o.sub}`, body: { revision: 1, server: {} } },
    'DELETE /api/mcp/registry/servers/:id': { url: `/api/mcp/registry/servers/${o.sub}`, body: { revision: 1 } },
    'GET /api/mcp/registry/servers/:id/projects/:projectId': { url: `/api/mcp/registry/servers/${o.sub}/projects/${o.catalogProject}` },
    'PUT /api/mcp/registry/servers/:id/projects/:projectId': { url: `/api/mcp/registry/servers/${o.sub}/projects/${o.catalogProject}`, body: { revision: 1, enabled: false } },
    'DELETE /api/mcp/registry/servers/:id/projects/:projectId': { url: `/api/mcp/registry/servers/${o.sub}/projects/${o.catalogProject}?revision=1` },
    'POST /api/mcp/registry/drafts': { url: '/api/mcp/registry/drafts', body: {} },
    'GET /api/mcp/registry/drafts/:id': { url: `/api/mcp/registry/drafts/${o.draft}` },
    'PATCH /api/mcp/registry/drafts/:id': { url: `/api/mcp/registry/drafts/${o.draft}`, body: {} },
    'POST /api/mcp/registry/drafts/:id/validate': { url: `/api/mcp/registry/drafts/${o.draft}/validate`, body: {} },
    'POST /api/mcp/registry/drafts/:id/connect': { url: `/api/mcp/registry/drafts/${o.draft}/connect`, body: {} },
    'POST /api/mcp/registry/drafts/:id/save-unchecked': { url: `/api/mcp/registry/drafts/${o.draft}/save-unchecked`, body: {} },
    'POST /api/mcp/registry/import/preview': { url: '/api/mcp/registry/import/preview', body: {} },
    'POST /api/mcp/registry/import/commit': { url: '/api/mcp/registry/import/commit', body: {} },
    // no attempt of this user with that state: 403 «Попытка входа не найдена»
    'GET /mcp/oauth/callback': { url: '/mcp/oauth/callback?code=x&state=y' },
    // agent-providers: the other user's machine → 404, no sign-in command sent to its agent
    'POST /api/runners/:id/providers/:provider/login': { url: `/api/runners/${o.runner}/providers/codex/login`, body: {} },
    'DELETE /api/runners/:id/providers/:provider/login/:loginId': { url: `/api/runners/${o.runner}/providers/codex/login/x` },
    'POST /api/runners/:id/providers/:provider/logout': { url: `/api/runners/${o.runner}/providers/codex/logout`, body: {} },
  });

  /**
   * Walks the cases with a session of `session`: no secret in any body, no 5xx, objects of the other user → 404, nothing
   * 2xx except `list` routes (and /api/admin/* for an administrator). The two logouts run last (they end sessions).
   */
  const walk = async (cases: Record<string, Case>, session: string, leakOf: string[], admin = false) => {
    const leaks: string[] = [];
    const wrongStatus: string[] = [];
    const last = ['POST /api/auth/logout-all', 'POST /auth/logout'];
    const ordered = Object.entries(cases).sort(([a], [b]) => last.indexOf(a) - last.indexOf(b));
    for (const [key, c] of ordered) {
      const method = key.split(' ')[0]! as 'GET';
      const body = c.body === undefined ? undefined : typeof c.body === 'string' ? c.body : (c.body as object);
      const r = await t.hub.app.inject({
        method,
        url: c.url,
        headers: { origin: PUBLIC_URL, ...(typeof c.body === 'string' ? { 'content-type': 'image/png' } : {}) },
        cookies: { ah_session: session },
        ...(body !== undefined ? { payload: body } : {}),
      });
      for (const s of leakOf) if (r.body.includes(s)) leaks.push(`${key}: ${s}`);
      if (r.statusCode >= 500) wrongStatus.push(`${key}: ${r.statusCode}`);
      const adminScreen = admin && key.includes(' /api/admin/');
      // An object of the other user answers like a missing one (404); admin routes 403 for a user; never 2xx.
      if (!c.list && !adminScreen && r.statusCode < 400) wrongStatus.push(`${key}: ${r.statusCode}`);
      if (!c.list && /:id|:requestId|:sha256/.test(key) && !key.startsWith('POST /api/admin') && !key.startsWith('DELETE /api/admin') && r.statusCode !== 404)
        wrongStatus.push(`${key}: ${r.statusCode} (404 expected)`);
    }
    return { leaks, wrongStatus };
  };

  it("every route from the second user with the first user's ids: 4xx (404 for objects), no data of the first user", async () => {
    const cases = ROUTES();
    const missing = t.hub.routes.map(r => `${r.method} ${r.url}`).filter(k => !cases[k]);
    expect(missing, 'routes without an isolation case').toEqual([]);
    // A session of her own for the walk; she logs in again after it.
    const session = await t.login({ email: 'bob@example.com' });
    const { leaks, wrongStatus } = await walk(cases, session, secrets());
    expect(leaks).toEqual([]);
    expect(wrongStatus).toEqual([]);
    bob = await t.login({ email: 'bob@example.com' });
    // Scenario «Запуск на чужом раннере»: no command reached Ivan's machine; Ivan's session is unchanged.
    expect(commands).toEqual([]);
    const s = (await t.tdb.pool.query(`SELECT permission_mode, project_source, unread FROM sessions WHERE id = $1`, [A.session])).rows[0];
    expect(s).toMatchObject({ unread: true });
    expect(s.permission_mode).not.toBe('plan');
    expect((await t.tdb.pool.query(`SELECT state FROM runners WHERE id = 'hp'`)).rows[0].state).toBe('active');
    expect((await t.tdb.pool.query(`SELECT status FROM users WHERE id = $1`, [ivanId])).rows[0].status).toBe('active');
    await expectSubscriptionIntact(ivanId, A.sub, SUB_NAME, SUB_TOKEN, 1);
    // web-push-notifications: the walk of the other user deleted nothing and rebound nothing
    expect((await t.tdb.pool.query(`SELECT user_id FROM push_subscriptions WHERE id = $1`, [A.pushId])).rows[0]).toEqual({ user_id: ivanId });
  });

  it("Прямой запрос чужой сессии: the administrator walks the same ROUTES against the user's objects → 404, no data of hers", async () => {
    // disable/enable aimed at a missing user: switching her off is administration, not access to her data
    const cases = ROUTES(B, randomUUID());
    const session = await t.login();
    const { leaks, wrongStatus } = await walk(cases, session, kSecrets(), true);
    expect(leaks).toEqual([]);
    expect(wrongStatus).toEqual([]);
    ivan = await t.login();
    // no command reached her machine; her session, runner and account are unchanged
    expect(kCommands).toEqual([]);
    expect(t.hub.agents.isOnline(K_RUNNER)).toBe(true);
    const s = (await t.tdb.pool.query(`SELECT permission_mode, unread FROM sessions WHERE id = $1`, [B.session])).rows[0];
    expect(s).toMatchObject({ unread: true });
    expect(s.permission_mode).not.toBe('plan');
    expect((await t.tdb.pool.query(`SELECT state, name FROM runners WHERE id = $1`, [K_RUNNER])).rows[0]).toMatchObject({ state: 'active', name: K_RUNNER_NAME });
    expect((await t.tdb.pool.query(`SELECT status FROM users WHERE id = $1`, [bobId])).rows[0].status).toBe('active');
    // hers and the one of her own walk («Своя …»)
    await expectSubscriptionIntact(bobId, B.sub, K_SUB_NAME, K_SUB_TOKEN, 2);
    expect((await t.tdb.pool.query(`SELECT user_id FROM push_subscriptions WHERE id = $1`, [B.pushId])).rows[0]).toEqual({ user_id: bobId });
  });

  it("the administrator's check is not vacuous: Bob herself reads her session and finds her word", async () => {
    const own = (url: string) => t.hub.app.inject({ method: 'GET', url, cookies: { ah_session: bob } });
    expect((await own(`/api/sessions/${B.session}`)).statusCode).toBe(200);
    expect((await own(`/api/search?q=${encodeURIComponent(K_WORD)}&cron=1`)).body).toContain(B.session);
    expect((await own(`/api/runners/${K_RUNNER}`)).statusCode).toBe(200);
    expect((await own('/api/subscriptions')).body).toContain(K_SUB_NAME);
    expect((await own('/api/subscriptions/usage')).body).toContain('888001');
  });

  it('the check is not vacuous: Ivan himself reads his session, finds the word and sees his runner', async () => {
    const own = (url: string) => t.hub.app.inject({ method: 'GET', url, cookies: { ah_session: ivan } });
    expect((await own(`/api/sessions/${A.session}`)).statusCode).toBe(200);
    expect((await own(`/api/search?q=${encodeURIComponent(SECRET_WORD)}&cron=1`)).body).toContain(A.session);
    expect((await own(`/api/runners/${A.runner}`)).statusCode).toBe(200);
    // task 3.5: his registry, last choice and usage are there for him
    const subs = (await own('/api/subscriptions')).json();
    expect(subs.subscriptions.map((x: { name: string }) => x.name)).toContain(SUB_NAME);
    expect(subs.lastChoiceId).toBe(A.sub);
    expect((await own('/api/subscriptions/usage')).body).toContain('777001');
  });

  it("claude-subscriptions after the merge: the handoff form's subscriptionId and the limit/401 marks stay within the owner", async () => {
    const subs = t.hub.sessions.subscriptions!;
    // QA B1: Bob's handoff form naming Ivan's subscription never gets his token
    await expect(subs.credForGeneration(bobId, { protocol_version: '1.5' }, A.sub)).rejects.toMatchObject({ status: 422, code: 'subscription_unavailable' });
    // QA B2 marks with another owner: Ivan's row is untouched
    const before = (await t.tdb.pool.query(`SELECT limit_resets_at, token_rejected_at, token_updated_at FROM subscriptions WHERE id = $1`, [A.sub])).rows[0];
    await subs.markLimit(A.sub, bobId, new Date(Date.now() + 3_600_000), 'five_hour');
    expect(await subs.markRejected(A.sub, bobId, null)).toBe(false);
    expect(await subs.clearRejected(A.sub, bobId, before.token_updated_at)).toBe(false);
    const after = (await t.tdb.pool.query(`SELECT limit_resets_at, token_rejected_at FROM subscriptions WHERE id = $1`, [A.sub])).rows[0];
    expect(after).toEqual({ limit_resets_at: before.limit_resets_at, token_rejected_at: before.token_rejected_at });
  });

  it('Запуск на чужом раннере: 404 runner_not_found', async () => {
    const r = await t.hub.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: PUBLIC_URL },
      cookies: { ah_session: bob },
      payload: { runnerId: 'hp', cwd: '/home/ubuntu/code', model: 'opus', prompt: 'hi' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('runner_not_found');
    expect(commands).toEqual([]);
  });

  it('Одинаковый каталог у двух пользователей: each sees only own session in /home/ubuntu/code', async () => {
    const side = (await t.hub.app.inject({ method: 'GET', url: '/api/sidebar?cron=1', cookies: { ah_session: bob } })).json();
    const titles = side.projects.flatMap((p: { sessions: Array<{ title: string }> }) => p.sessions.map(s => s.title));
    expect(titles).toEqual([K_TITLE]);
    const own = (await t.hub.app.inject({ method: 'GET', url: '/api/sidebar?cron=1', cookies: { ah_session: ivan } })).json();
    expect(own.projects.flatMap((p: { sessions: Array<{ title: string }> }) => p.sessions.map(s => s.title))).not.toContain(K_TITLE);
  });

  it("every /ws/ui message type from the second user with the first user's ids changes and delivers nothing", async () => {
    const types = uiClientMessageSchema.options.map(o => o.shape.type.value).sort();
    // A new client message type needs its case here.
    expect(types).toEqual(['ping', 'presence', 'subscribe']);
    const ui = connectUi(t.wsBase, bob);
    await ui.open;
    ui.send({ type: 'subscribe', sessionIds: [A.session], subagentIds: [A.subagent] });
    ui.send({ type: 'presence', visible: true, activeSessionIds: [A.session] });
    ui.send({ type: 'ping' });
    await waitFor(() => ui.received.some(m => m.type === 'pong'));
    await new Promise(r => setTimeout(r, 300));
    // Scenario «Подписка на чужую сессию по WebSocket»: the first user's events go to his subscribers only.
    t.hub.ui.sendToSubscribers(ivanId, A.session, { type: 'session.partial', sessionId: A.session, messageId: 'm', blockIndex: 0, textDelta: SECRET_WORD });
    t.hub.ui.sendToSubscribers(ivanId, A.subagent, { type: 'subagent.events', subagentId: A.subagent, events: [] });
    t.hub.ui.broadcast(ivanId, { type: 'projects.changed' });
    // Task 3.5: a change of Ivan's registry reaches his clients only
    const ivanUi = connectUi(t.wsBase, ivan);
    await ivanUi.open;
    const patched = await t.hub.app.inject({ method: 'PATCH', url: `/api/subscriptions/${A.sub}`, headers: { origin: PUBLIC_URL }, cookies: { ah_session: ivan }, payload: { autoSwitch: true } });
    expect(patched.statusCode).toBe(200);
    await waitFor(() => ivanUi.received.some(m => m.type === 'subscriptions.changed'));
    ivanUi.ws.close();
    await new Promise(r => setTimeout(r, 300));
    expect(ui.received.map(m => m.type)).toEqual(['pong']);
    expect(JSON.stringify(ui.received)).not.toContain(SECRET_WORD);
    // presence did not clear Ivan's «unread»
    expect((await t.tdb.pool.query(`SELECT unread FROM sessions WHERE id = $1`, [A.session])).rows[0].unread).toBe(true);
    ui.ws.close();
  });

  it('a runner of the first user is never reachable by the second: the agent stays connected', () => {
    expect(t.hub.agents.isOnline('hp')).toBe(true);
    expect(agent.messages.some(m => m.type.startsWith('session.'))).toBe(false);
  });
});
