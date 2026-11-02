// Change agent-providers (tasks 3.1–3.5): the provider of a session through the hub — runner providers from hello and
// agent.status, creating a Codex session, refusals without the CLI or the sign-in, resume without a restore, the
// device-code sign-in, the models of a provider, a replicated Codex mirror.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnerView, SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { providerOfRelPath } from '../replication/ingest.js';

const VAULT = 'C:\\Users\\alice\\vault';
const CODEX_OK = { id: 'codex', version: '0.166.0', login: 'ok', account: { email: 'ivan@example.com', plan: 'pro' }, models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }] };

describe('providers (integration)', () => {
  let t: TestHub;
  let cookie: string;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let hp: FakeAgent;
  let ui: ReturnType<typeof connectUi>;
  const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const lastCmd = (type: string, sessionId?: string) => [...got].reverse().find(m => m.type === type && (!sessionId || m.payload.sessionId === sessionId))?.payload;

  async function agentFor(runner: string, token: string, hello: Record<string, unknown>) {
    const a = connectFakeAgent(t.wsBase, token, hello);
    a.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    autoReply(a, (type, p) => {
      if (type === 'fs.stat') return { exists: true, isDir: true };
      if (type === 'session.start' || type === 'session.resume')
        return { models: p.provider === 'codex' ? [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }] : [{ value: 'haiku', displayName: 'Haiku' }] };
      if (type === 'session.fork') return { newSessionId: randomUUID() };
      if (type === 'provider.login.start') return { loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', expiresAt: Date.now() + 900_000 };
      return {};
    });
    await a.next('welcome');
    void runner;
    return a;
  }

  let vmToken: string;
  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 1500 } });
    const hpToken = await t.addRunner('hp', 'HP');
    vmToken = await t.addRunner('vm', 'ВМ .3');
    cookie = await t.login();
    hp = await agentFor('hp', hpToken, { providers: [CODEX_OK] });
    ui = connectUi(t.wsBase, cookie);
    await ui.open;
  });
  afterAll(async () => {
    ui.ws.close();
    await t.close();
  });

  it('the runner shows the providers of hello', async () => {
    const { runners } = (await api('GET', '/api/runners')).json() as { runners: RunnerView[] };
    expect(runners.find(r => r.id === 'hp')?.providers).toEqual([CODEX_OK]);
  });

  it('a Codex session: provider in the command and the view, no subscription', async () => {
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'gpt-6.1-sol', prompt: 'привет', provider: 'codex', subscriptionId: null });
    expect(r.statusCode).toBe(201);
    const s = r.json() as SessionView;
    expect(s.provider).toBe('codex');
    await waitFor(() => lastCmd('session.start', s.id));
    const cmd = lastCmd('session.start', s.id)!;
    expect(cmd).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', prompt: 'привет' });
    expect(cmd).not.toHaveProperty('subscription');
  });

  it('a Claude session: the command has no provider field (as before 1.10)', async () => {
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'claude' });
    const s = r.json() as SessionView;
    expect(s.provider).toBe('claude');
    await waitFor(() => lastCmd('session.start', s.id));
    expect(lastCmd('session.start', s.id)).not.toHaveProperty('provider');
  });

  it('refusals: no Codex on the machine, no sign-in', async () => {
    const vm = await agentFor('vm', vmToken, {});
    const r1 = await api('POST', '/api/sessions', { runnerId: 'vm', cwd: VAULT, model: 'gpt-6.1-sol', prompt: 'x', provider: 'codex' });
    expect(r1.statusCode).toBe(422);
    expect(r1.json()).toMatchObject({ error: 'provider_unavailable' });
    agentSend(vm, 'agent.status', { providers: [{ id: 'codex', version: '0.166.0', login: 'missing' }] });
    await waitFor(async () => ((await api('GET', '/api/runners')).json() as { runners: RunnerView[] }).runners.find(r => r.id === 'vm')?.providers?.[0]?.login === 'missing');
    const r2 = await api('POST', '/api/sessions', { runnerId: 'vm', cwd: VAULT, model: 'gpt-6.1-sol', prompt: 'x', provider: 'codex' });
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({ error: 'provider_login_required' });
    vm.ws.close();
  });

  it('resume of a Codex session: provider in the command, no transcript restore', async () => {
    const s = (await (await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'gpt-6.1-sol', prompt: 'первое', provider: 'codex' })).json()) as SessionView;
    await waitFor(() => lastCmd('session.start', s.id));
    agentSend(hp, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
    await waitFor(async () => !((await api('GET', `/api/sessions/${s.id}`)).json() as SessionView).processAlive);
    const before = got.length;
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'второе', clientUuid: randomUUID() })).statusCode).toBe(202);
    await waitFor(() => lastCmd('session.resume', s.id));
    expect(lastCmd('session.resume', s.id)).toMatchObject({ provider: 'codex', prompt: 'второе' });
    expect(got.slice(before).some(m => m.type === 'file.restore')).toBe(false);
  });

  it('a full copy of a Codex session is a Codex session', async () => {
    const s = (await (await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'gpt-6.1-sol', prompt: 'для копии', provider: 'codex' })).json()) as SessionView;
    await waitFor(() => lastCmd('session.start', s.id));
    const r = await api('POST', `/api/sessions/${s.id}/fork`, { mode: 'copy' });
    expect(r.statusCode).toBe(201);
    expect((r.json() as SessionView).provider).toBe('codex');
    expect([...got].reverse().find(m => m.type === 'session.fork')!.payload).toMatchObject({ provider: 'codex', sourceSessionId: s.id });
  });

  it('models of a provider: from the machine report', async () => {
    const r = await api('GET', '/api/models?provider=codex');
    expect(r.json()).toEqual([{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }]);
    const claude = (await api('GET', '/api/models')).json() as Array<{ value: string }>;
    expect(claude.some(m => m.value === 'gpt-6.1-sol')).toBe(false);
  });

  it('device-code sign-in: the code from the agent, the end to the UI; sign-out', async () => {
    const r = await api('POST', '/api/runners/hp/providers/codex/login');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ loginId: 'login-1', userCode: 'ABCD-1234' });
    expect(lastCmd('provider.login.start')).toEqual({ provider: 'codex' });
    agentSend(hp, 'provider.login.done', { provider: 'codex', loginId: 'login-1', ok: true });
    await waitFor(() => ui.received.find(m => m.type === 'provider.login'));
    expect(ui.received.find(m => m.type === 'provider.login')).toMatchObject({ runnerId: 'hp', provider: 'codex', loginId: 'login-1', ok: true });
    expect((await api('DELETE', '/api/runners/hp/providers/codex/login/login-1')).statusCode).toBe(204);
    expect(lastCmd('provider.login.cancel')).toEqual({ provider: 'codex', loginId: 'login-1' });
    expect((await api('POST', '/api/runners/hp/providers/codex/logout')).statusCode).toBe(204);
    expect(lastCmd('provider.logout')).toEqual({ provider: 'codex' });
    expect((await api('POST', '/api/runners/hp/providers/claude/login')).statusCode).toBe(400);
  });

  it('a Codex mirror seen first by replication is a Codex session', async () => {
    expect(providerOfRelPath('agent-hub-codex/x.jsonl')).toBe('codex');
    expect(providerOfRelPath('agent-hub-codex\\x.jsonl')).toBe('codex');
    expect(providerOfRelPath('C--Users-alice-vault/x.jsonl')).toBe('claude');
    const sid = randomUUID();
    const rel = `agent-hub-codex/${sid}.jsonl`;
    const line = JSON.stringify({ type: 'system', subtype: 'agent_provider', provider: 'codex', threadId: 't', cwd: VAULT, sessionId: sid, uuid: randomUUID(), timestamp: new Date().toISOString() });
    agentSend(hp, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: [line], endByte: line.length + 1 });
    await waitFor(() => got.some(m => m.type === 'repl.ack' && m.payload.relPath === rel));
    const row = await t.tdb.db.selectFrom('sessions').select(['provider']).where('claude_session_id', '=', sid).executeTakeFirst();
    expect(row?.provider).toBe('codex');
  });
});
