// Task 3.17 with the real SDK (haiku) on Windows: an image «ОШИБКА <code>» uploaded through the hub reaches the model
// on start, on send to a live session and on resume of a sleeping one. Opt-in: AGENT_HUB_REAL_SDK=1.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventsPage, HubEvent, SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { createAgent, type Agent } from './agent.js';
import { createLogger } from './log.js';
import { encodeCwd } from './transcripts/tailer.js';

const RUN = process.env.AGENT_HUB_REAL_SDK === '1' && process.platform === 'win32';
let offsetMs = 0;

/** A PNG with «ОШИБКА <code>» drawn by System.Drawing. */
function errorImage(dir: string, code: number): Buffer {
  const file = join(dir, `e${code}.png`);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 420,120; $g=[System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); ` +
      `$f = New-Object System.Drawing.Font('Arial',36,[System.Drawing.FontStyle]::Bold); $g.DrawString('ОШИБКА ${code}',$f,[System.Drawing.Brushes]::Black,10,30); ` +
      `$b.Save('${file}',[System.Drawing.Imaging.ImageFormat]::Png)`,
  ]);
  return readFileSync(file);
}

function assistantText(events: HubEvent[]): string {
  return events
    .filter((e): e is Extract<HubEvent, { kind: 'line' }> => e.kind === 'line' && e.line.type === 'assistant')
    .flatMap(e => ((e.line.message as { content?: Array<{ type: string; text?: string }> }).content ?? []).filter(b => b.type === 'text').map(b => b.text ?? ''))
    .join('\n');
}

describe.skipIf(!RUN)('images reach the model (real SDK, haiku)', () => {
  let t: TestHub;
  let agent: Agent;
  let cookie: string;
  let cwd: string;
  beforeAll(async () => {
    t = await startTestHub({ sessions: { now: () => new Date(Date.now() + offsetMs), idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    cwd = mkdtempSync(join(tmpdir(), 'agenthub-img-'));
    agent = createAgent({
      hubUrl: `${t.wsBase}/ws/agent`,
      token,
      vaultRoot: cwd,
      claudeProjectsDir: join(homedir(), '.claude', 'projects'),
      log: createLogger({ level: 'warn', write: () => undefined }),
      backoff: { minMs: 50, maxMs: 300 },
      tailPollMs: 100,
      replMaxBytesPerSec: 1,
    });
    agent.start();
    await waitFor(() => t.hub.agents.isOnline('hp'), 10_000);
  });
  afterAll(async () => {
    await agent.stop();
    await t.close();
    for (const p of [cwd, join(homedir(), '.claude', 'projects', encodeCwd(cwd))]) {
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        // left in %TEMP%
      }
    }
  });

  const api = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL, ...headers }, ...(payload !== undefined ? { payload: payload as never } : {}) });
  const upload = async (img: Buffer) => ((await api('POST', '/api/uploads', img, { 'content-type': 'image/png' })).json() as { sha256: string }).sha256;
  const answered = (id: string, code: number) =>
    waitFor(
      async () => {
        const p = (await api('GET', `/api/sessions/${id}/events?limit=500`)).json() as EventsPage;
        return assistantText(p.events).includes(String(code));
      },
      180_000,
      500,
    );
  const view = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  const QUESTION = 'Какой код ошибки на картинке? Ответь только числом.';

  it('start, send and resume each deliver the image', { timeout: 600_000 }, async () => {
    // start
    const a = await upload(errorImage(cwd, 4817));
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd, model: 'haiku', prompt: QUESTION, attachments: [{ sha256: a }] });
    expect(r.statusCode).toBe(201);
    const s = r.json() as SessionView;
    await answered(s.id, 4817);
    await waitFor(async () => (await view(s.id)).status === 'waiting', 60_000, 200);

    // send to the live session
    const b = await upload(errorImage(cwd, 5923));
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: QUESTION, clientUuid: randomUUID(), attachments: [{ sha256: b }] })).statusCode).toBe(202);
    await answered(s.id, 5923);
    await waitFor(async () => (await view(s.id)).status === 'waiting', 60_000, 200);

    // resume of a sleeping session
    offsetMs = 31 * 60_000;
    expect(await t.hub.sessions.checkIdle()).toBe(1);
    offsetMs = 0;
    await waitFor(async () => (await view(s.id)).status === 'sleeping', 30_000, 200);
    const c = await upload(errorImage(cwd, 7361));
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: QUESTION, clientUuid: randomUUID(), attachments: [{ sha256: c }] })).statusCode).toBe(202);
    await answered(s.id, 7361);
  });
});
