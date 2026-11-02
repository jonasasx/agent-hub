// Tasks 2.2 and 2.3 against the real Agent SDK and the user's Claude subscription (model haiku).
// Slow and billed to the subscription, so opt-in: AGENT_HUB_REAL_SDK=1 npx vitest run agent/src/sessions/manager.sdk.test.ts
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  at: number;
}

function harness() {
  const sent: Sent[] = [];
  const waiters: Array<{ pred: (m: Sent) => boolean; resolve: (m: Sent) => void }> = [];
  const lines: string[] = [];
  const mgr = new SessionManager({
    send: (type, payload) => {
      const m = { type, payload: payload as Record<string, unknown>, at: Date.now() };
      sent.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    },
    log: createLogger({ level: 'debug', write: l => lines.push(l) }),
    queryFn: p => query(p),
    stopGraceMs: 10_000,
  });
  // `after` is a position in `sent` (from mark()): timestamps of adjacent messages can be equal.
  const next = (pred: (m: Sent) => boolean, ms = 120_000, after = 0) =>
    new Promise<Sent>((resolve, reject) => {
      const have = sent.slice(after).find(pred);
      if (have) return resolve(have);
      const t = setTimeout(() => reject(new Error(`timeout; last sent: ${JSON.stringify(sent.slice(-5))}`)), ms);
      waiters.push({ pred, resolve: m => (clearTimeout(t), resolve(m)) });
    });
  const mark = () => sent.length;
  return { mgr, sent, next, mark, lines };
}

const cmd = <T extends HubMessage['type']>(type: T, payload: PayloadOf<HubMessage, T>): HubMessage => ({ v: 1, ts: Date.now(), id: randomUUID(), type, payload }) as HubMessage;

describe.skipIf(!RUN)('session manager with the real SDK (haiku)', () => {
  const dirs: string[] = [];
  const mkcwd = () => {
    const d = mkdtempSync(join(tmpdir(), 'agenthub-sdk-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) {
      // A Claude process of a failed test may still hold the directory on Windows.
      for (const p of [d, join(homedir(), '.claude', 'projects', encodeCwd(d))]) {
        try {
          rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {
          // left in %TEMP%
        }
      }
    }
  });

  it('start, two turns, interrupt of `sleep 120` within 5 s, stop ends the process', { timeout: 300_000 }, async () => {
    const { mgr, next, mark, sent } = harness();
    const cwd = mkcwd();
    const sessionId = randomUUID();
    const t0 = Date.now();
    const ok = await mgr.handle(
      cmd('session.start', { sessionId, cwd, permissionMode: 'bypassPermissions', model: MODEL, prompt: 'Reply with exactly the word ONE and nothing else.', promptUuid: randomUUID() }),
    );
    expect((ok as { models: unknown[] }).models.length).toBeGreaterThan(0);
    expect(mgr.liveSessions()).toEqual([{ sessionId, state: 'working' }]);
    const r1 = await next(m => m.type === 'session.result');
    const r1m = sent.indexOf(r1);
    expect(r1.payload).toMatchObject({ sessionId, subtype: 'success', isError: false });
    await next(m => m.type === 'session.state' && m.payload.state === 'waiting', 30_000, r1m);
    expect(sent.some(m => m.type === 'session.partial' && String(m.payload.textDelta).includes('ONE'))).toBe(true);

    const t1m = mark();
    await mgr.handle(cmd('session.send', { sessionId, text: 'Now reply with exactly the word TWO.', promptUuid: randomUUID() }));
    const r2 = await next(m => m.type === 'session.result', 120_000, t1m);
    expect(r2.payload.isError).toBe(false);
    const transcript = join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
    expect(existsSync(transcript)).toBe(true);
    expect(readFileSync(transcript, 'utf8')).toContain('TWO');

    const t2 = Date.now();
    await mgr.handle(cmd('session.send', { sessionId, text: 'Use the Bash tool to run exactly this command: sleep 120', promptUuid: randomUUID() }));
    // Wait until the command is actually running (tool_use written to the transcript).
    const deadline = Date.now() + 120_000;
    while (!/"name":"Bash"[^\n]*sleep 120/.test(readFileSync(transcript, 'utf8'))) {
      if (Date.now() > deadline) throw new Error('Bash sleep 120 was not started');
      await new Promise(r => setTimeout(r, 200));
    }
    const tInt = Date.now();
    const tIntm = mark();
    await mgr.handle(cmd('session.interrupt', { sessionId }));
    const waiting = await next(m => m.type === 'session.state' && m.payload.state === 'waiting', 10_000, tIntm);
    expect(waiting.at - tInt).toBeLessThan(5000);
    expect(waiting.at - t2).toBeLessThan(110_000); // did not wait for sleep to finish

    // The session keeps its context after the interrupt.
    const t3m = mark();
    await mgr.handle(cmd('session.send', { sessionId, text: 'What word did you reply with in your first answer? Reply with that word only.', promptUuid: randomUUID() }));
    await next(m => m.type === 'session.result', 120_000, t3m);
    expect(readFileSync(transcript, 'utf8').split('\n').slice(-30).join('\n')).toContain('ONE');

    const tStopm = mark();
    await mgr.handle(cmd('session.stop', { sessionId, reason: 'user' }));
    const exited = await next(m => m.type === 'session.exited', 15_000, tStopm);
    expect(exited.payload).toMatchObject({ sessionId, reason: 'stopped' });
    expect(mgr.liveSessions()).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(300_000);
  });

  it('default mode: Bash asks; «allow in this session» stops further prompts; mode stays default', { timeout: 300_000 }, async () => {
    const { mgr, next, mark, sent } = harness();
    const cwd = mkcwd();
    const sessionId = randomUUID();
    await mgr.handle(
      cmd('session.start', {
        sessionId,
        cwd,
        permissionMode: 'default',
        model: MODEL,
        prompt: 'Use the Bash tool to run exactly this command: touch agenthub-perm-check.txt',
        promptUuid: randomUUID(),
      }),
    );
    const req = await next(m => m.type === 'permission.request');
    const reqm = sent.indexOf(req);
    expect(req.payload).toMatchObject({ sessionId, toolName: 'Bash' });
    expect(mgr.liveSessions()).toEqual([{ sessionId, state: 'permission' }]);
    await mgr.handle({ v: 1, ts: Date.now(), type: 'permission.response', payload: { requestId: req.payload.requestId as string, behavior: 'allow', scope: 'session' } });
    const r1 = await next(m => m.type === 'session.result', 120_000, reqm);
    expect(r1.payload.isError).toBe(false);

    const t1 = Date.now();
    const t1m = mark();
    await mgr.handle(
      cmd('session.send', {
        sessionId,
        text: 'Call the Bash tool once more with exactly this command, even though you already ran it (I need the timestamp updated): touch agenthub-perm-check.txt',
        promptUuid: randomUUID(),
      }),
    );
    await next(m => m.type === 'session.result', 120_000, t1m);
    expect(sent.filter(m => m.type === 'permission.request')).toHaveLength(1);
    const transcript = readFileSync(join(homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`), 'utf8');
    const calls = transcript.split('\n').filter(l => /"name":"Bash"/.test(l) && l.includes('touch agenthub-perm-check.txt'));
    if (calls.length !== 2) {
      const dialog = transcript.split('\n').filter(l => /"type":"(user|assistant)"/.test(l));
      console.log(dialog.map(l => l.slice(0, 400)).join('\n'));
      console.log(
        sent
          .filter(m => m.type !== 'session.partial')
          .map(m => `${m.at - t1} ${m.type} ${JSON.stringify(m.payload).slice(0, 200)}`)
          .join('\n'),
      );
    }
    expect(calls.length).toBe(2); // the second call ran without a permission request
    // The mode was not switched: no permission-mode line other than default.
    const modes = transcript
      .split('\n')
      .filter(l => l.includes('"permission-mode"'))
      .map(l => (JSON.parse(l) as { permissionMode?: string }).permissionMode);
    expect(modes.every(m => m === 'default')).toBe(true);

    await mgr.handle(cmd('session.stop', { sessionId, reason: 'user' }));
  });
});
