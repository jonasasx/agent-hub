// Tasks 4.12 and 4.14 against the real Agent SDK 0.3.310 and the subscription (model haiku). Opt-in, billed:
// AGENT_HUB_REAL_SDK=1 npx vitest run agent/src/sessions/fork.sdk.test.ts
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkSession, query } from '@anthropic-ai/claude-agent-sdk';
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

function harness(scratchDir: string) {
  const sent: Sent[] = [];
  const waiters: Array<{ pred: (m: Sent) => boolean; resolve: (m: Sent) => void }> = [];
  const mgr = new SessionManager({
    send: (type, payload) => {
      const m = { type, payload: payload as Record<string, unknown> };
      sent.push(m);
      for (const w of [...waiters]) {
        if (!w.pred(m)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    },
    log: createLogger({ level: 'error', write: () => undefined }),
    queryFn: p => query(p),
    oneShotFn: p => query(p),
    forkFn: (id, o) => forkSession(id, o),
    scratchDir,
    stopGraceMs: 10_000,
  });
  const next = (pred: (m: Sent) => boolean, after: number, ms = 120_000) =>
    new Promise<Sent>((resolve, reject) => {
      const have = sent.slice(after).find(pred);
      if (have) return resolve(have);
      const t = setTimeout(() => reject(new Error(`timeout; last: ${JSON.stringify(sent.slice(-3))}`)), ms);
      waiters.push({ pred, resolve: m => (clearTimeout(t), resolve(m)) });
    });
  return { mgr, sent, next };
}

describe.skipIf(!RUN)('fork with the real SDK (haiku)', () => {
  const dirs: string[] = [];
  const mk = () => {
    // as it comes: %TEMP% may be an 8.3 short name (C:\Users\IVOLYN~1) — the agent resolves it for forkSession
    const d = mkdtempSync(join(tmpdir(), 'agenthub-fork-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) for (const p of [join(homedir(), '.claude', 'projects', encodeCwd(d)), d]) rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  // Claude Code keys the project folder by the directory as given
  const jsonl = (cwd: string, id: string) => join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${id}.jsonl`);
  const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  /** One turn: start or resume, wait for the result, stop the process (the session sleeps). */
  async function turn(h: ReturnType<typeof harness>, type: 'session.start' | 'session.resume', sessionId: string, cwd: string, prompt: string) {
    const at = h.sent.length;
    await h.mgr.handle(cmd(type, { sessionId, cwd, permissionMode: 'bypassPermissions', model: MODEL, prompt, promptUuid: randomUUID() }));
    await h.next(m => m.type === 'session.result' && m.payload.sessionId === sessionId, at);
    const st = h.sent.length;
    await h.mgr.handle(cmd('session.stop', { sessionId, reason: 'sleep' }));
    await h.next(m => m.type === 'session.exited' && m.payload.sessionId === sessionId, st, 20_000);
  }

  it('full copy continues the context; the source .jsonl does not change and still knows its number', { timeout: 400_000 }, async () => {
    const cwd = mk();
    const h = harness(mk());
    const src = randomUUID();
    await turn(h, 'session.start', src, cwd, 'Запомни число 4817. Ответь одним словом: запомнил.');
    const srcFile = jsonl(cwd, src);
    const before = lines(srcFile);
    const r = (await h.mgr.handle(cmd('session.fork', { sourceSessionId: src, cwd, title: 'проба (копия)' }))) as { newSessionId: string };
    expect(r.newSessionId).not.toBe(src);
    expect(existsSync(jsonl(cwd, r.newSessionId))).toBe(true);
    expect(lines(srcFile)).toBe(before);
    await turn(h, 'session.resume', r.newSessionId, cwd, 'Замени запомненное число на 9999 и повтори его. Ответь только числом.');
    expect(readFileSync(jsonl(cwd, r.newSessionId), 'utf8').split('\n').slice(-12).join('\n')).toContain('9999');
    expect(lines(srcFile)).toBe(before);
    await turn(h, 'session.resume', src, cwd, 'Какое число я просил запомнить? Ответь только числом.');
    const tail = readFileSync(srcFile, 'utf8').split('\n').slice(-12).join('\n');
    expect(tail).toContain('4817');
    expect(tail).not.toContain('9999');
  });

  it('handoff.generate writes no transcript on the machine; a new session started with the prompt knows the goal', { timeout: 400_000 }, async () => {
    const scratch = mk();
    const h = harness(scratch);
    const transcript = [
      'Пользователь: Цель — переименовать функцию parseLedgerRow в parseBankRow во всём модуле importer.ts и обновить тесты.',
      'Tool: Grep parseLedgerRow',
      'Ассистент: Нашёл 3 вызова в importer.ts и 2 в importer.test.ts. Переименовал в importer.ts, тесты ещё не правил.',
    ].join('\n\n');
    const { text } = (await h.mgr.handle(
      cmd('handoff.generate', {
        transcript,
        model: MODEL,
        systemPrompt: 'Напиши handoff-промпт для новой сессии с разделами: ## Цель, ## Что сделано, ## Следующий шаг. Ответь только текстом промпта.',
      }),
    )) as { text: string };
    expect(text).toMatch(/^#+ Цель/m);
    expect(text).toMatch(/parseBankRow/);
    // persistSession: false — no project directory for the scratch directory
    expect(existsSync(join(homedir(), '.claude', 'projects', encodeCwd(scratch)))).toBe(false);
    const cwd = mk();
    const s = randomUUID();
    await turn(h, 'session.start', s, cwd, `${text}\n\nНичего не делай с файлами. Ответь одной строкой: какое новое имя функции?`);
    expect(readFileSync(jsonl(cwd, s), 'utf8').split('\n').slice(-12).join('\n')).toContain('parseBankRow');
  });
});
