// The Codex provider against the real `codex app-server` (change agent-providers, task 2.11). Opt-in, uses the
// machine's ChatGPT sign-in: AGENT_HUB_REAL_CODEX=1 npx vitest run agent/src/providers/codex/provider.codex.test.ts
// Without a sign-in only the start is checked (the turn ends with auth_rejected); with AGENT_HUB_CODEX_SIGNED_IN=1 a
// full turn, a command, resume and a fork are checked too.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../log.js';
import { findCodexBin } from './bin.js';
import { mirrorPath } from './mirror.js';
import { CodexProvider } from './provider.js';

const RUN = process.env.AGENT_HUB_REAL_CODEX === '1';
const SIGNED_IN = process.env.AGENT_HUB_CODEX_SIGNED_IN === '1';

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

function harness(projectsDir: string) {
  const sent: Sent[] = [];
  const waiters: Array<{ pred: (m: Sent) => boolean; resolve: (m: Sent) => void }> = [];
  const logs: string[] = [];
  const bin = findCodexBin();
  if (!bin) throw new Error('no Codex CLI');
  const p = new CodexProvider({
    bin,
    send: (type, payload) => {
      const m = { type, payload: payload as Record<string, unknown> };
      sent.push(m);
      for (const w of [...waiters])
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
    },
    log: createLogger({ level: 'debug', write: l => logs.push(l) }),
    projectsDir,
    agentVersion: '0.0.0-test',
    images: async () => [],
  });
  const waitFor = (pred: (m: Sent) => boolean, ms = 180_000) =>
    new Promise<Sent>((resolve, reject) => {
      const hit = sent.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timeout; sent: ${sent.map(s => s.type).join(', ')}\n${logs.slice(-20).join('\n')}`)), ms);
      waiters.push({ pred, resolve: m => (clearTimeout(t), resolve(m)) });
    });
  return { p, sent, waitFor, logs };
}

const cmd = (type: string, payload: unknown) => ({ v: 1, ts: Date.now(), type, id: randomUUID(), payload }) as never;

describe.runIf(RUN)('Codex provider (real app-server)', () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'ah-codex-projects-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ah-codex-cwd-'));
  afterAll(() => {
    rmSync(projectsDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('starts a thread, writes the mirror header and reports models', async () => {
    const h = harness(projectsDir);
    const sessionId = randomUUID();
    const r = (await h.p.handle(cmd('session.start', { sessionId, cwd, permissionMode: 'bypassPermissions', model: 'gpt-6.1-sol', prompt: '', promptUuid: randomUUID(), provider: 'codex' }))) as {
      models: unknown[];
    };
    expect(Array.isArray(r.models)).toBe(true);
    const header = JSON.parse(readFileSync(mirrorPath(projectsDir, sessionId), 'utf8').split('\n')[0]!);
    expect(header).toMatchObject({ type: 'system', subtype: 'agent_provider', provider: 'codex', sessionId });
    expect(typeof header.threadId).toBe('string');
    await h.waitFor(m => m.type === 'session.state' && m.payload.state === 'waiting');
    // Registry-only configuration: without a synced snapshot, no project/user MCP servers enter Codex.
    const expected: string[] = [];
    const snap = (await h.p.handle(cmd('mcp.status.get', { sessionId }))) as { snapshot: { servers: Array<{ name: string; status: string }> } };
    const names = snap.snapshot.servers.map(s => s.name);
    for (const n of expected) expect(names).toContain(n);

    const promptUuid = randomUUID();
    await h.p.handle(cmd('session.send', { sessionId, text: SIGNED_IN ? 'Run the shell command `echo agent-hub-probe` and reply with its output only.' : 'hi', promptUuid }));
    const result = await h.waitFor(m => m.type === 'session.result');
    const lines = readFileSync(mirrorPath(projectsDir, sessionId), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(lines.some(l => l.type === 'user' && l.uuid === promptUuid)).toBe(true);
    if (SIGNED_IN) {
      expect(result.payload.isError).toBe(false);
      expect(lines.some(l => l.type === 'assistant' && l.message.content.some((c: { type: string; name?: string }) => c.type === 'tool_use' && c.name === 'Bash'))).toBe(true);
      expect(lines.some(l => l.type === 'assistant' && l.message.content.some((c: { type: string; text?: string }) => c.type === 'text' && /agent-hub-probe/.test(c.text ?? '')))).toBe(true);
    } else {
      expect(result.payload.isError).toBe(true);
    }
    await h.p.handle(cmd('session.stop', { sessionId, reason: 'sleep' }));
    await h.waitFor(m => m.type === 'session.exited');

    if (!SIGNED_IN) return;
    // resume: the same thread remembers the conversation
    const h2 = harness(projectsDir);
    await h2.p.handle(
      cmd('session.resume', {
        sessionId,
        cwd,
        permissionMode: 'bypassPermissions',
        prompt: 'What exact text did the command print? Reply with that text only.',
        promptUuid: randomUUID(),
        provider: 'codex',
      }),
    );
    const r2 = await h2.waitFor(m => m.type === 'session.result');
    expect(r2.payload.isError).toBe(false);
    const after = readFileSync(mirrorPath(projectsDir, sessionId), 'utf8');
    expect(after.match(/agent-hub-probe/g)!.length).toBeGreaterThan(2);
    // fork: a copy with its own thread
    const f = (await h2.p.handle(cmd('session.fork', { sourceSessionId: sessionId, cwd, provider: 'codex' }))) as { newSessionId: string };
    const copy = readFileSync(mirrorPath(projectsDir, f.newSessionId), 'utf8').split('\n')[0]!;
    expect(JSON.parse(copy).threadId).not.toBe(JSON.parse(after.split('\n')[0]!).threadId);
    await h2.p.stopAll();
  }, 600_000);
});
