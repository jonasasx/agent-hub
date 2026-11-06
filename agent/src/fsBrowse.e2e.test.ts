// Tasks 2.4 and 8.2 (change `tool-windows-file-explorer`): a real agent behind a real hub. A browser request for a folder or a file goes
// hub (owner check, root) -> agent (fs.list / fs.read) -> disk and back, including the refusals: `..`, a link out of the root, `.ssh`.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_URL, startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { createAgent, type Agent } from './agent.js';
import { createLogger } from './log.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');

describe('file explorer end to end (hub + real agent)', () => {
  let t: TestHub;
  let agent: Agent;
  let cookie: string;
  let base: string;
  let outside: string;
  let sessionId: string;
  let linked = false;
  const enc = encodeURIComponent;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-fs-'));
    base = join(dir, 'proj');
    outside = join(dir, 'outside');
    mkdirSync(join(base, 'docs'), { recursive: true });
    mkdirSync(join(base, '.ssh'));
    mkdirSync(outside);
    writeFileSync(join(base, 'README.md'), '# Title\n\ntext\n');
    writeFileSync(join(base, 'docs', 'a.txt'), 'plain a');
    writeFileSync(join(base, 'pic.png'), PNG);
    writeFileSync(join(base, 'doc.pdf'), PDF);
    writeFileSync(join(base, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(base, '.env'), 'SECRET=1');
    writeFileSync(join(base, '.ssh', 'id_rsa'), 'PRIVATE');
    writeFileSync(join(outside, 'leak.txt'), 'outside the root');
    try {
      symlinkSync(outside, join(base, 'escape'), 'junction');
      linked = true;
    } catch {
      linked = false;
    }
    t = await startTestHub();
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    agent = createAgent({
      hubUrl: `${t.wsBase}/ws/agent`,
      token,
      vaultRoot: dir,
      claudeProjectsDir: join(dir, 'claude-projects'),
      log: createLogger({ level: 'warn', write: () => undefined }),
      backoff: { minMs: 50, maxMs: 300 },
      tailPollMs: 100,
      replMaxBytesPerSec: 1,
    });
    agent.start();
    await waitFor(() => t.hub.agents.isOnline('hp'), 10_000);
    const user = (await t.tdb.pool.query(`SELECT user_id FROM runners WHERE id='hp'`)).rows[0].user_id as string;
    sessionId = (await t.tdb.pool.query(`INSERT INTO sessions(user_id,runner_id,claude_session_id,source,status,cwd) VALUES ($1,'hp',gen_random_uuid(),'hub','closed',$2) RETURNING id`, [user, base]))
      .rows[0].id as string;
  });

  afterAll(async () => {
    await agent.stop();
    await t.close();
    rmSync(join(base, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const get = (route: 'list' | 'file', path: string | null) =>
    t.hub.app.inject({
      method: 'GET',
      url: `/api/runners/hp/fs/${route}?sessionId=${sessionId}${path === null ? '' : `&path=${enc(path)}`}`,
      cookies: { ah_session: cookie },
      headers: { 'sec-fetch-site': 'same-origin', origin: PUBLIC_URL },
    });

  it('lists the root of the session: folders first, the secret file is not offered as readable content', async () => {
    const r = await get('list', null);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { entries: Array<{ name: string; kind: string }>; truncated: boolean };
    const names = body.entries.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(['docs', 'README.md', 'pic.png', 'doc.pdf', 'blob.bin']));
    expect(names).not.toContain('.env');
    expect(body.entries.findIndex(e => e.name === 'docs')).toBeLessThan(body.entries.findIndex(e => e.name === 'README.md'));
    expect(body.truncated).toBe(false);
  });

  it('lists a subfolder', async () => {
    const r = await get('list', join(base, 'docs'));
    expect(r.statusCode).toBe(200);
    expect((r.json() as { entries: Array<{ name: string }> }).entries.map(e => e.name)).toEqual(['a.txt']);
  });

  it('reads markdown and plain text as text', async () => {
    const md = await get('file', join(base, 'README.md'));
    expect(md.statusCode).toBe(200);
    expect(md.body).toBe('# Title\n\ntext\n');
    expect(md.headers['x-file-kind']).toBe('markdown');
    expect(md.headers['content-type']).toBe('text/plain; charset=utf-8');
    const txt = await get('file', join(base, 'docs', 'a.txt'));
    expect(txt.body).toBe('plain a');
    expect(txt.headers['x-file-kind']).toBe('text');
  });

  it('reads a png and a pdf byte for byte', async () => {
    const img = await get('file', join(base, 'pic.png'));
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(PNG)).toBe(true);
    const pdf = await get('file', join(base, 'doc.pdf'));
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.equals(PDF)).toBe(true);
  });

  it('answers 415 for a binary file', async () => {
    const r = await get('file', join(base, 'blob.bin'));
    expect(r.statusCode).toBe(415);
    expect(r.json()).toMatchObject({ error: 'unsupported', kind: 'binary', size: 6 });
  });

  it('answers 404 for a missing file and 400 for a path with ..', async () => {
    expect((await get('file', join(base, 'nope.txt'))).statusCode).toBe(404);
    const up = await get('file', `${base}/docs/../../outside/leak.txt`);
    expect(up.statusCode).toBe(400);
    expect(up.json().error).toBe('invalid_path');
  });

  it('refuses a sibling folder and a path outside the root', async () => {
    const r = await get('file', join(outside, 'leak.txt'));
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('outside_root');
    expect(r.body).not.toContain('outside the root');
  });

  it('refuses a link that leads out of the root', async () => {
    if (!linked) return; // creating a link needs a privilege on this machine
    const r = await get('file', join(base, 'escape', 'leak.txt'));
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('outside the root');
    expect((await get('list', join(base, 'escape'))).statusCode).toBe(403);
  });

  it('refuses .ssh and .env with restricted, without telling whether they exist', async () => {
    for (const [route, p] of [
      ['list', join(base, '.ssh')],
      ['file', join(base, '.ssh', 'id_rsa')],
      ['file', join(base, '.env')],
      ['file', join(base, '.env.missing')],
    ] as const) {
      const r = await get(route, p);
      expect(r.statusCode, p).toBe(403);
      expect(r.json().error, p).toBe('restricted');
      expect(r.body).not.toContain('PRIVATE');
      expect(r.body).not.toContain('SECRET=1');
    }
  });
});
