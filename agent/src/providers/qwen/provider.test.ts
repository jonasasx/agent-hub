// The Qwen provider against the real @qwen-code/sdk and a mock OpenAI-compatible server (change qwen-provider, task 4):
// start, text turn, tool call with a permission, interrupt, resume, fork, mirror, rejected key.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../log.js';
import { ProviderRouter } from '../router.js';
import type { SessionProvider } from '../types.js';
import { startMockOpenAI, type MockOpenAI } from './mockOpenAI.js';
import { QWEN_MIRROR_DIR, normalizeTool, readResumePlan } from './mirror.js';
import { failureOf, QwenProvider, qwenModeOf } from './provider.js';
import { QwenService } from './service.js';

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

const TURN_MS = 60_000;
const dirs: string[] = [];
const providers: QwenProvider[] = [];
const saved: Record<string, string | undefined> = {};
let mock: MockOpenAI;

beforeAll(async () => {
  // the CLI keeps its chats and settings under the home directory: keep them out of the real one
  const home = mkdtempSync(join(tmpdir(), 'ah-qwen-home-'));
  dirs.push(home);
  for (const k of ['HOME', 'USERPROFILE', 'QWEN_HOME']) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.QWEN_HOME = join(home, '.qwen');
  mock = await startMockOpenAI();
});

afterAll(async () => {
  await mock.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterEach(async () => {
  for (const p of providers.splice(0)) await p.stopAll(500);
});

function setup(o: { apiKey?: string; hubProtocol?: string } = {}) {
  const projectsDir = mkdtempSync(join(tmpdir(), 'ah-qwen-unit-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ah-qwen-cwd-'));
  dirs.push(projectsDir, cwd);
  const config = { baseUrl: mock.baseUrl, apiKey: o.apiKey ?? mock.apiKey, model: null };
  const log = createLogger({ level: 'error', write: () => undefined });
  const sent: Sent[] = [];
  const statuses: unknown[] = [];
  const service = new QwenService({ config, log, version: '0.1.34', onStatus: s => statuses.push(s) });
  const p = new QwenProvider({
    config,
    service,
    send: (type, payload) => {
      sent.push({ type, payload: payload as Record<string, unknown> });
      return true;
    },
    log,
    projectsDir,
    agentVersion: '0.8.22',
    images: async () => [],
    hubProtocol: () => o.hubProtocol ?? '1.21',
    stopGraceMs: 2_000,
  });
  providers.push(p);
  const of = (sid: string, type: string) => sent.filter(m => m.type === type && m.payload.sessionId === sid);
  const mirror = (sid: string) =>
    readFileSync(join(projectsDir, QWEN_MIRROR_DIR, `${sid}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose transcript lines in assertions
      .map(l => JSON.parse(l) as Record<string, any>);
  return { p, sent, statuses, service, projectsDir, cwd, of, mirror };
}

const cmd = (type: string, payload: unknown) => ({ v: 1, ts: 0, type, id: randomUUID(), payload }) as never;

async function until(cond: () => boolean, what: string, ms = TURN_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

async function started(t: ReturnType<typeof setup>, mode = 'bypassPermissions', prompt = '') {
  const sessionId = randomUUID();
  const r = await t.p.handle(cmd('session.start', { sessionId, cwd: t.cwd, permissionMode: mode, model: null, prompt, promptUuid: randomUUID(), provider: 'qwen' }));
  return { sessionId, r };
}

const send = (t: ReturnType<typeof setup>, sessionId: string, text: string) => t.p.handle(cmd('session.send', { sessionId, text, promptUuid: randomUUID() }));

describe('pure helpers (design D6)', () => {
  it('maps the permission modes', () => {
    expect(qwenModeOf('bypassPermissions')).toBe('yolo');
    expect(qwenModeOf('acceptEdits')).toBe('auto-edit');
    expect(qwenModeOf('dontAsk')).toBe('auto-edit');
    expect(qwenModeOf('plan')).toBe('plan');
    expect(qwenModeOf('default')).toBe('default');
  });
  it('classifies a refused key', () => {
    expect(failureOf('401 Incorrect API key provided')?.kind).toBe('auth_rejected');
    expect(failureOf('connection reset')).toBeUndefined();
  });
  it('normalizes tool names to the Claude ones (design D3)', () => {
    expect(normalizeTool('run_shell_command', { command: 'ls', is_background: false })).toEqual({ name: 'Bash', input: { command: 'ls', is_background: false } });
    expect(normalizeTool('write_file', { file_path: '/a', content: 'x' })).toEqual({ name: 'Write', input: { file_path: '/a', content: 'x' } });
    expect(normalizeTool('read_file', { absolute_path: '/a' }).input).toMatchObject({ file_path: '/a' });
    expect(normalizeTool('unknown_tool', { a: 1 })).toEqual({ name: 'unknown_tool', input: { a: 1 } });
  });
});

describe('QwenService (design D2)', () => {
  it('reads the status and the models from /models; 401 is rejected', async () => {
    const t = setup();
    const ok = await t.service.refresh(true);
    expect(ok).toMatchObject({ id: 'qwen', version: '0.1.34', login: 'ok', models: [{ value: 'qwen3.8-flash-next' }] });
    expect(JSON.stringify(t.statuses)).not.toContain(mock.apiKey);
    const bad = setup({ apiKey: 'wrong-key-0123456789' });
    expect((await bad.service.refresh(true)).login).toBe('rejected');
  });
});

describe('QwenProvider with the real SDK', () => {
  it(
    'starts a session, answers a text turn, writes the header and the mirror, reports the result',
    async () => {
      const t = setup();
      const { sessionId, r } = await started(t, 'bypassPermissions', 'hello qwen');
      expect(r).toMatchObject({ models: [{ value: 'qwen3.8-flash-next' }] });
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the first result');
      const res = t.of(sessionId, 'session.result')[0]!.payload;
      expect(res).toMatchObject({ subtype: 'success', isError: false });
      expect(String(res.resultText)).toMatch(/pong: .*hello qwen/);
      expect(t.of(sessionId, 'session.state').at(-1)!.payload.state).toBe('waiting');
      expect(t.of(sessionId, 'session.partial').length).toBeGreaterThan(0);
      const lines = t.mirror(sessionId);
      expect(lines[0]).toMatchObject({ type: 'system', subtype: 'agent_provider', threadId: sessionId });
      expect(lines.some(l => l.type === 'user')).toBe(true);
      expect(JSON.stringify(lines.filter(l => l.type === 'assistant'))).toMatch(/pong: .*hello qwen/);
      // the key goes neither into the mirror nor into any message to the hub
      expect(JSON.stringify(t.sent)).not.toContain(mock.apiKey);
      expect(JSON.stringify(lines)).not.toContain(mock.apiKey);
      const asked = mock.requests.filter(q => q.url === '/v1/chat/completions').at(-1)!;
      expect(asked.authorization).toBe(`Bearer ${mock.apiKey}`);
      expect(asked.body?.model).toBe('qwen3.8-flash-next');
    },
    TURN_MS,
  );

  it(
    'a tool call asks for permission: allow runs the tool, the next turn works',
    async () => {
      const t = setup();
      const { sessionId } = await started(t, 'default');
      const target = join(t.cwd, 'out.txt');
      await send(t, sessionId, `WRITE ${target}`);
      await until(() => t.of(sessionId, 'permission.request').length === 1, 'a permission request');
      const req = t.of(sessionId, 'permission.request')[0]!.payload;
      expect(req).toMatchObject({ toolName: 'Write', kind: 'tool' });
      expect(t.of(sessionId, 'session.state').at(-1)!.payload.state).toBe('permission');
      expect(t.p.ownsRequest(String(req.requestId))).toBe(true);
      await t.p.handle(cmd('permission.response', { requestId: req.requestId, behavior: 'allow' }));
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the result after allow');
      expect(existsSync(target)).toBe(true);
      expect(JSON.stringify(t.mirror(sessionId))).toContain('"name":"Write"');
      await send(t, sessionId, 'again');
      await until(() => t.of(sessionId, 'session.result').length === 2, 'the second turn');
      expect(t.of(sessionId, 'session.result')[1]!.payload.subtype).toBe('success');
    },
    TURN_MS * 2,
  );

  it(
    'deny keeps the file away',
    async () => {
      const t = setup();
      const { sessionId } = await started(t, 'default');
      const target = join(t.cwd, 'denied.txt');
      await send(t, sessionId, `WRITE ${target}`);
      await until(() => t.of(sessionId, 'permission.request').length === 1, 'a permission request');
      await t.p.handle(cmd('permission.response', { requestId: t.of(sessionId, 'permission.request')[0]!.payload.requestId, behavior: 'deny' }));
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the result after deny');
      expect(existsSync(target)).toBe(false);
    },
    TURN_MS,
  );

  it(
    'interrupt ends a running turn with the interrupted result',
    async () => {
      const t = setup();
      const { sessionId } = await started(t, 'bypassPermissions', 'SLOW please');
      await until(() => t.of(sessionId, 'session.partial').length > 0, 'the stream to start');
      await t.p.handle(cmd('session.interrupt', { sessionId }));
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the result of the interrupted turn');
      expect(t.of(sessionId, 'session.result')[0]!.payload.subtype).toBe('interrupted');
      await until(() => t.of(sessionId, 'session.state').at(-1)?.payload.state === 'waiting', 'the waiting state');
    },
    TURN_MS,
  );

  it(
    'stop ends the process; resume continues the same session from the mirror',
    async () => {
      const t = setup();
      const { sessionId } = await started(t, 'bypassPermissions', 'first');
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the first result');
      await t.p.handle(cmd('session.stop', { sessionId, reason: 'sleep' }));
      await until(() => t.of(sessionId, 'session.exited').length === 1, 'the exit');
      expect(t.of(sessionId, 'session.exited')[0]!.payload).toMatchObject({ reason: 'stopped' });
      expect(t.p.has(sessionId)).toBe(false);
      expect(await readResumePlan(t.projectsDir, sessionId)).toMatchObject({ resume: sessionId, fork: false });
      await t.p.handle(cmd('session.resume', { sessionId, cwd: t.cwd, permissionMode: 'bypassPermissions', model: null, prompt: 'second', promptUuid: randomUUID(), provider: 'qwen' }));
      await until(() => t.of(sessionId, 'session.result').length === 2, 'the result after resume');
      expect(t.of(sessionId, 'session.result')[1]!.payload.subtype).toBe('success');
      // the model saw the first turn again: the history was restored by the CLI
      const last = mock.requests.filter(q => q.url === '/v1/chat/completions').at(-1)!;
      expect(JSON.stringify(last.body?.messages)).toContain('first');
      expect(t.mirror(sessionId).filter(l => l.type === 'user').length).toBe(2);
    },
    TURN_MS * 2,
  );

  it(
    'resume of a session without a mirror fails with transcript_missing',
    async () => {
      const t = setup();
      await expect(t.p.handle(cmd('session.resume', { sessionId: randomUUID(), cwd: t.cwd, permissionMode: 'default', model: null, provider: 'qwen' }))).rejects.toMatchObject({
        code: 'transcript_missing',
      });
    },
    TURN_MS,
  );

  it(
    'fork copies the mirror; the first resume of the copy forks the CLI chat and keeps the history',
    async () => {
      const t = setup();
      const { sessionId } = await started(t, 'bypassPermissions', 'before the fork');
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the source result');
      await t.p.handle(cmd('session.stop', { sessionId, reason: 'sleep' }));
      await until(() => t.of(sessionId, 'session.exited').length === 1, 'the source exit');
      const forked = (await t.p.handle(cmd('session.fork', { sourceSessionId: sessionId, cwd: t.cwd, title: 'copy' }))) as { newSessionId: string };
      const copy = forked.newSessionId;
      expect(await readResumePlan(t.projectsDir, copy)).toMatchObject({ resume: sessionId, fork: true });
      await t.p.handle(cmd('session.resume', { sessionId: copy, cwd: t.cwd, permissionMode: 'bypassPermissions', model: null, prompt: 'after the fork', promptUuid: randomUUID(), provider: 'qwen' }));
      await until(() => t.of(copy, 'session.result').length === 1, 'the copy result');
      const last = mock.requests.filter(q => q.url === '/v1/chat/completions').at(-1)!;
      expect(JSON.stringify(last.body?.messages)).toContain('before the fork');
      expect(await readResumePlan(t.projectsDir, copy)).toMatchObject({ resume: copy, fork: false });
      // the source keeps its own history
      expect(JSON.stringify(t.mirror(sessionId))).not.toContain('after the fork');
    },
    TURN_MS * 2,
  );

  it(
    'a refused key ends the turn with auth_rejected and marks the endpoint rejected',
    async () => {
      const t = setup();
      const { sessionId } = await started(t, 'bypassPermissions', 'FAIL401');
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the failed result');
      const res = t.of(sessionId, 'session.result')[0]!.payload;
      expect(res).toMatchObject({ isError: true, failure: { kind: 'auth_rejected' } });
      expect(t.service.status.login).toBe('rejected');
    },
    TURN_MS,
  );

  it(
    'the router sends qwen commands to the provider by payload and by session',
    async () => {
      const t = setup();
      const claude = { id: 'claude', has: () => false, ownsRequest: () => false, handle: async () => ({ claude: true }) } as unknown as SessionProvider;
      const router = new ProviderRouter(claude, [t.p]);
      const sessionId = randomUUID();
      await router.handle(cmd('session.start', { sessionId, cwd: t.cwd, permissionMode: 'bypassPermissions', model: null, prompt: 'via router', promptUuid: randomUUID(), provider: 'qwen' }));
      await until(() => t.of(sessionId, 'session.result').length === 1, 'the routed result');
      expect(router.statuses().some(s => s.id === 'qwen')).toBe(true);
      await router.handle(cmd('session.send', { sessionId, text: 'more', promptUuid: randomUUID() }));
      await until(() => t.of(sessionId, 'session.result').length === 2, 'the routed second result');
    },
    TURN_MS * 2,
  );
});
