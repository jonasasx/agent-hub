// AskUserQuestion and ExitPlanMode through the session manager with the real SDK 0.3.310 (haiku), M4b. Opt-in:
// AGENT_HUB_REAL_SDK=1 npx vitest run agent/src/sessions/questions.sdk.test.ts
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import { createLogger } from '../log.js';
import { encodeCwd } from '../transcripts/tailer.js';
import { SessionManager } from './manager.js';

const RUN = process.env.AGENT_HUB_REAL_SDK === '1';
const MODEL = process.env.AGENT_HUB_TEST_MODEL ?? 'haiku';

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}
const cmd = <T extends HubMessage['type']>(type: T, payload: PayloadOf<HubMessage, T>): HubMessage => ({ v: 1, ts: Date.now(), id: randomUUID(), type, payload }) as HubMessage;

/** `autoAllowTools`: ordinary tool requests (Write of the plan file in plan mode) are allowed at once. */
function harness(autoAllowTools = false) {
  const sent: Sent[] = [];
  let mgrRef: SessionManager | null = null;
  const waiters: Array<{ pred: (m: Sent) => boolean; resolve: (m: Sent) => void }> = [];
  const mgr = new SessionManager({
    send: (type, payload) => {
      const m = { type, payload: payload as Record<string, unknown> };
      sent.push(m);
      if (autoAllowTools && m.type === 'permission.request' && m.payload.kind === 'tool') {
        setTimeout(() => void mgrRef?.handle(cmd('permission.response', { requestId: m.payload.requestId as string, behavior: 'allow', scope: 'once' })), 0);
      }
      for (const w of [...waiters]) {
        if (!w.pred(m)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    },
    log: createLogger({ level: 'error', write: () => undefined }),
    queryFn: p => query(p),
    stopGraceMs: 10_000,
  });
  mgrRef = mgr;
  const next = (pred: (m: Sent) => boolean, after: number, ms = 120_000) =>
    new Promise<Sent>((resolve, reject) => {
      const have = sent.slice(after).find(pred);
      if (have) return resolve(have);
      const t = setTimeout(() => reject(new Error(`timeout; last: ${JSON.stringify(sent.slice(-3)).slice(0, 600)}`)), ms);
      waiters.push({ pred, resolve: m => (clearTimeout(t), resolve(m)) });
    });
  return { mgr, sent, next };
}

describe.skipIf(!RUN)('questions and plans with the real SDK (haiku)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) {
      for (const p of [join(homedir(), '.claude', 'projects', encodeCwd(d)), d]) {
        try {
          rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {
          // a Claude process of a failed test may still hold it on Windows: left in %TEMP%
        }
      }
    }
  });
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'agenthub-ask-'));
    dirs.push(d);
    return d;
  };
  const tail = (cwd: string, id: string) =>
    readFileSync(join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${id}.jsonl`), 'utf8')
      .split('\n')
      .slice(-8)
      .join('\n');

  it('bypassPermissions: AskUserQuestion still comes as a question; the answer B reaches the model', { timeout: 300_000 }, async () => {
    const h = harness();
    const cwd = mk();
    const sessionId = randomUUID();
    await h.mgr.handle(
      cmd('session.start', {
        sessionId,
        cwd,
        permissionMode: 'bypassPermissions',
        model: MODEL,
        prompt: 'Задай мне вопрос через инструмент AskUserQuestion: один вопрос «Какую букву выбрать?» с вариантами A и B. Затем ответь одной строкой: «Выбрано: <буква>».',
        promptUuid: randomUUID(),
      }),
    );
    const req = await h.next(m => m.type === 'permission.request', 0);
    expect(req.payload).toMatchObject({ toolName: 'AskUserQuestion', kind: 'question' });
    const q = (req.payload.input as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0]!;
    expect(q.options.map(o => o.label)).toEqual(expect.arrayContaining(['A', 'B']));
    const at = h.sent.length;
    await h.mgr.handle(cmd('permission.response', { requestId: req.payload.requestId as string, behavior: 'allow', scope: 'once', answers: { [q.question]: 'B' } }));
    await h.next(m => m.type === 'session.result', at);
    expect(tail(cwd, sessionId)).toMatch(/Выбрано: B/);
    await h.mgr.stopAll();
  });

  it('a mode set in the header stays: set_mode default → session.state carries default, bypass does not return after a turn', { timeout: 300_000 }, async () => {
    const h = harness(true);
    const cwd = mk();
    const sessionId = randomUUID();
    await h.mgr.handle(cmd('session.start', { sessionId, cwd, permissionMode: 'bypassPermissions', model: MODEL, prompt: 'Ответь одним словом: раз.', promptUuid: randomUUID() }));
    await h.next(m => m.type === 'session.result', 0);
    const at = h.sent.length;
    await h.mgr.handle(cmd('session.set_mode', { sessionId, mode: 'default' }));
    expect(h.sent.slice(at).find(m => m.type === 'session.state')?.payload.permissionMode).toBe('default');
    const t2 = h.sent.length;
    await h.mgr.handle(cmd('session.send', { sessionId, text: 'Ответь одним словом: два.', promptUuid: randomUUID() }));
    await h.next(m => m.type === 'session.result', t2);
    await new Promise(r => setTimeout(r, 500));
    const modes = h.sent
      .slice(at)
      .filter(m => m.type === 'session.state' && m.payload.permissionMode)
      .map(m => m.payload.permissionMode);
    expect(modes.length).toBeGreaterThan(0);
    expect(modes).not.toContain('bypassPermissions');
    await h.mgr.stopAll();
  });

  it('plan mode: ExitPlanMode comes as a plan; «Продолжить планирование» with a comment, then «Утвердить»', { timeout: 400_000 }, async () => {
    const h = harness(true);
    const cwd = mk();
    const sessionId = randomUUID();
    await h.mgr.handle(
      cmd('session.start', {
        sessionId,
        cwd,
        permissionMode: 'plan',
        model: MODEL,
        prompt: 'Составь короткий план: создать файл hello.txt со словом привет. Когда план готов, вызови ExitPlanMode. После утверждения выполни план.',
        promptUuid: randomUUID(),
      }),
    );
    const plan1 = await h.next(m => m.type === 'permission.request' && m.payload.toolName === 'ExitPlanMode', 0, 180_000);
    expect(plan1.payload).toMatchObject({ kind: 'plan' });
    expect(String((plan1.payload.input as { plan?: unknown }).plan)).toMatch(/hello\.txt/);
    const at1 = h.sent.length;
    await h.mgr.handle(
      cmd('permission.response', { requestId: plan1.payload.requestId as string, behavior: 'deny', scope: 'once', message: 'Добавь в план третий пункт: прочитать файл и проверить слово.' }),
    );
    const plan2 = await h.next(m => m.type === 'permission.request' && m.payload.toolName === 'ExitPlanMode', at1, 180_000);
    expect(String((plan2.payload.input as { plan?: unknown }).plan)).toMatch(/прочит|провер/i);
    const at2 = h.sent.length;
    await h.mgr.handle(cmd('permission.response', { requestId: plan2.payload.requestId as string, behavior: 'allow', scope: 'once' }));
    await h.next(m => m.type === 'session.result', at2, 180_000);
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toMatch(/привет/);
    // the approved plan leaves plan mode: the agent reports the actual mode (the hub stores it for a later resume)
    const modes = h.sent.filter(m => m.type === 'session.state' && m.payload.sessionId === sessionId && m.payload.permissionMode).map(m => m.payload.permissionMode);
    const mode = modes.at(-1) as 'default' | 'acceptEdits';
    expect(mode).toBeDefined();
    expect(mode).not.toBe('plan');
    // sleep, then resume with that mode: the session acts instead of planning again
    const st = h.sent.length;
    await h.mgr.handle(cmd('session.stop', { sessionId, reason: 'sleep' }));
    await h.next(m => m.type === 'session.exited' && m.payload.sessionId === sessionId, st, 20_000);
    const rs = h.sent.length;
    await h.mgr.handle(cmd('session.resume', { sessionId, cwd, permissionMode: mode, model: MODEL, prompt: 'Создай файл bye.txt со словом пока. Сразу, без плана.', promptUuid: randomUUID() }));
    await h.next(m => m.type === 'session.result' && m.payload.sessionId === sessionId, rs, 180_000);
    expect(h.sent.slice(rs).some(m => m.type === 'permission.request' && m.payload.toolName === 'ExitPlanMode')).toBe(false);
    expect(readFileSync(join(cwd, 'bye.txt'), 'utf8')).toMatch(/пока/);
    await h.mgr.stopAll();
  });
});
