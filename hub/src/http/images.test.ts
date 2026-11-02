// M3b backend (tasks 3.8, 3.16, 3.17, 3.19): blobs, uploads, attachments to the agent, «Показать изображение», CSP.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope } from '@agent-hub/shared';
import { PUBLIC_URL, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import type { MemoryStore } from '../storage/objectStore.js';
import { png } from '../test/transcriptFixtures.js';
import { contentSecurityPolicy, cspProvider, inlineScriptHashes } from './csp.js';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertUser, createSession } from '../auth/sessions.js';

const VAULT = 'C:\\Users\\alice\\vault';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('images (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  let token: string;
  const got: Array<{ type: string; id?: string; payload: Record<string, unknown> }> = [];
  const failing = new Map<string, string>();
  const files = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}, c = cookie) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: c }, headers: { origin: PUBLIC_URL, ...headers }, ...(payload !== undefined ? { payload: payload as never } : {}) });
  const upload = (bytes: Buffer, type = 'image/png') => api('POST', '/api/uploads', bytes, { 'content-type': type });

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    agent = connectFakeAgent(t.wsBase, token);
    agent.ws.on('message', (d, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(d.toString()) as { type: string; id?: string; payload: Record<string, unknown> };
      got.push(m);
      if (m.type === 'fs.read_image' && m.id) {
        const f = files.get(String(m.payload.path));
        if (!f) return agent.ws.send(JSON.stringify(envelope('cmd.error', { code: 'not_found', message: 'file not found' }, { re: m.id })));
        agent.ws.send(
          JSON.stringify(envelope('cmd.ok', { result: { sha256: sha(f), mime: 'image/png', size: f.length, mtimeMs: mtimes.get(String(m.payload.path)) ?? 1, binary: true } }, { re: m.id })),
        );
        agent.ws.send(f);
      }
    });
    autoReply(agent, (type, payload) => {
      if (type === 'fs.read_image') throw Object.assign(new Error('handled'), { code: '__handled' });
      const code = failing.get(type);
      if (code) throw Object.assign(new Error(`${type} failed`), { code });
      if (type === 'fs.stat') {
        const f = files.get(String((payload as { path?: string }).path));
        return f ? { exists: true, isDir: false, size: f.length, mtimeMs: mtimes.get(String((payload as { path: string }).path)) ?? 1 } : { exists: true, isDir: true };
      }
      return { models: [] };
    });
    await agent.next('welcome');
  });
  afterAll(async () => t.close());

  it('3.16: a PNG is stored once (201, then 200); text as .png → 415; 5 MB → 413; 9000 px → 422', async () => {
    const img = png(40, 30);
    const store = t.store as MemoryStore;
    const r1 = await upload(img);
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toEqual({ sha256: sha(img), mime: 'image/png', size: img.length, width: 40, height: 30 });
    const puts = store.puts;
    const r2 = await upload(img);
    expect(r2.statusCode).toBe(200);
    expect(store.puts).toBe(puts); // no second object
    expect((await upload(Buffer.from('это не картинка'))).statusCode).toBe(415);
    const big = Buffer.concat([png(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(big)).statusCode).toBe(413);
    const wide = await upload(png(9000, 1));
    expect(wide.statusCode).toBe(422);
    expect(wide.json()).toMatchObject({ error: 'image_too_large' });
    // Raw bytes are parsed for /api/uploads only: another route refuses them as an unsupported media type.
    const raw = await api('POST', '/api/sessions', png(4, 4), { 'content-type': 'image/png' });
    expect(raw.statusCode).toBe(415);
  });

  it('3.8: GET /api/blobs/:sha256 — type, immutable cache, ETag/304, nosniff; another user and unknown → 404', async () => {
    const img = png(12, 12);
    await upload(img);
    const r = await api('GET', `/api/blobs/${sha(img)}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(r.headers.etag).toBe(`"${sha(img)}"`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.rawPayload.equals(img)).toBe(true);
    expect((await api('GET', `/api/blobs/${sha(img)}`, undefined, { 'if-none-match': `"${sha(img)}"` })).statusCode).toBe(304);
    expect((await api('GET', `/api/blobs/${'a'.repeat(64)}`)).statusCode).toBe(404);
    const other = await upsertUser(t.tdb.db, 'other@example.com');
    const otherCookie = await createSession(t.tdb.db, other.id, 'test');
    expect((await api('GET', `/api/blobs/${sha(img)}`, undefined, {}, otherCookie)).statusCode).toBe(404);
  });

  async function liveSession(): Promise<string> {
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'привет' });
    return (r.json() as { id: string }).id;
  }

  it('3.17: attachments reach the agent with one-time links; the agent fetches the bytes with its token', async () => {
    const img = png(64, 48);
    await upload(img);
    const id = await liveSession();
    const before = got.length;
    const r = await api('POST', `/api/sessions/${id}/messages`, { text: '', clientUuid: randomUUID(), attachments: [{ sha256: sha(img) }] });
    expect(r.statusCode).toBe(202);
    const send = got.slice(before).find(m => m.type === 'session.send')!.payload;
    const att = (send.attachments as Array<{ sha256: string; mime: string; size: number; url: string }>)[0]!;
    expect(att).toMatchObject({ sha256: sha(img), mime: 'image/png', size: img.length });
    expect(att.url).toMatch(/^\/agent-api\/blobs\/[A-Za-z0-9_-]+$/);
    const ok = await t.hub.app.inject({ method: 'GET', url: att.url, headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(img)).toBe(true);
    expect((await t.hub.app.inject({ method: 'GET', url: att.url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200); // reusable within TTL
    const other = await t.addRunner('vm', 'ВМ');
    expect((await t.hub.app.inject({ method: 'GET', url: att.url, headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(404);
    expect((await t.hub.app.inject({ method: 'GET', url: att.url })).statusCode).toBe(401);
    const used = await t.tdb.pool.query(`SELECT used_at FROM uploads WHERE sha256 = $1`, [sha(img)]);
    expect(used.rows[0].used_at).not.toBeNull();
  });

  it('3.17: a sha256 not uploaded by the user → 422; a 1.1 runner → 409 agent_outdated', async () => {
    const id = await liveSession();
    const r = await api('POST', `/api/sessions/${id}/messages`, { text: 'x', clientUuid: randomUUID(), attachments: [{ sha256: 'b'.repeat(64) }] });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'attachment_not_found' });
    const img = png(20, 20);
    await upload(img);
    await t.tdb.pool.query(`UPDATE runners SET protocol_version = '1.1' WHERE id = 'hp'`);
    try {
      const old = await api('POST', `/api/sessions/${id}/messages`, { text: 'x', clientUuid: randomUUID(), attachments: [{ sha256: sha(img) }] });
      expect(old.statusCode).toBe(409);
      expect(old.json()).toMatchObject({ error: 'agent_outdated' });
    } finally {
      await t.tdb.pool.query(`UPDATE runners SET protocol_version = '1.2' WHERE id = 'hp'`);
    }
    // empty text without images is refused
    expect((await api('POST', `/api/sessions/${id}/messages`, { text: ' ', clientUuid: randomUUID() })).statusCode).toBe(400);
  });

  // B1: the images reach the machine (attachments.fetch) before send, resume or start; a failure is 502, nothing is
  // sent, the session is untouched and the same clientUuid goes through on the repeat.
  describe('attachments.fetch before the command', () => {
    const count = (type: string, pred: (p: Record<string, unknown>) => boolean = () => true) => got.filter(m => m.type === type && pred(m.payload)).length;
    const status = async (id: string) => (await t.tdb.pool.query(`SELECT status, process_alive FROM sessions WHERE id = $1`, [id])).rows[0] as { status: string; process_alive: boolean };

    it('send to a live session', async () => {
      const id = await liveSession();
      const img = png(21, 21);
      await upload(img);
      const clientUuid = randomUUID();
      failing.set('attachments.fetch', 'attachment_fetch_failed');
      const f = await api('POST', `/api/sessions/${id}/messages`, { text: 'с картинкой', clientUuid, attachments: [{ sha256: sha(img) }] });
      failing.delete('attachments.fetch');
      expect(f.statusCode).toBe(502);
      expect(f.json()).toMatchObject({ error: 'attachment_delivery_failed' });
      expect(count('session.send', p => p.promptUuid === clientUuid)).toBe(0);
      const fetches = count('attachments.fetch');
      expect((await api('POST', `/api/sessions/${id}/messages`, { text: 'с картинкой', clientUuid, attachments: [{ sha256: sha(img) }] })).statusCode).toBe(202);
      expect((await api('POST', `/api/sessions/${id}/messages`, { text: 'с картинкой', clientUuid, attachments: [{ sha256: sha(img) }] })).statusCode).toBe(202);
      expect(count('session.send', p => p.promptUuid === clientUuid)).toBe(1);
      expect(count('attachments.fetch')).toBe(fetches + 1);
      const fetch = got.filter(m => m.type === 'attachments.fetch').at(-1)!.payload;
      expect((fetch.attachments as Array<{ sha256: string }>)[0]!.sha256).toBe(sha(img));
    });

    it('resume of a sleeping session: a timeout too; the session stays asleep', async () => {
      const id = await liveSession();
      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false WHERE id = $1`, [id]);
      const img = png(22, 22);
      await upload(img);
      const clientUuid = randomUUID();
      failing.set('attachments.fetch', 'timeout');
      const f = await api('POST', `/api/sessions/${id}/messages`, { text: 'проснись', clientUuid, attachments: [{ sha256: sha(img) }] });
      failing.delete('attachments.fetch');
      expect(f.statusCode).toBe(502);
      expect(f.json()).toMatchObject({ error: 'attachment_delivery_failed' });
      expect(count('session.resume', p => p.promptUuid === clientUuid)).toBe(0);
      expect(await status(id)).toEqual({ status: 'sleeping', process_alive: false });
      expect((await api('POST', `/api/sessions/${id}/messages`, { text: 'проснись', clientUuid, attachments: [{ sha256: sha(img) }] })).statusCode).toBe(202);
      const resume = await waitFor(() => got.find(m => m.type === 'session.resume' && m.payload.promptUuid === clientUuid));
      expect((resume.payload.attachments as unknown[]).length).toBe(1);
    });

    it('start: nothing is created on a failure; the repeat starts the session with the image', async () => {
      const img = png(23, 23);
      await upload(img);
      const sessions = async () => Number((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n);
      const n = await sessions();
      const starts = count('session.start');
      failing.set('attachments.fetch', 'attachment_fetch_failed');
      const f = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'что на картинке?', attachments: [{ sha256: sha(img) }] });
      failing.delete('attachments.fetch');
      expect(f.statusCode).toBe(502);
      expect(f.json()).toMatchObject({ error: 'attachment_delivery_failed' });
      expect(await sessions()).toBe(n);
      expect(count('session.start')).toBe(starts);
      const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'что на картинке?', attachments: [{ sha256: sha(img) }] });
      expect(r.statusCode).toBe(201);
      const start = await waitFor(() => got.find(m => m.type === 'session.start' && m.payload.sessionId === (r.json() as { id: string }).id));
      expect((start.payload.attachments as unknown[]).length).toBe(1);
    });

    it('an agent without attachments.fetch → 409 agent_outdated', async () => {
      const id = await liveSession();
      const img = png(24, 24);
      await upload(img);
      failing.set('attachments.fetch', 'not_implemented');
      const f = await api('POST', `/api/sessions/${id}/messages`, { text: 'x', clientUuid: randomUUID(), attachments: [{ sha256: sha(img) }] });
      failing.delete('attachments.fetch');
      expect(f.statusCode).toBe(409);
      expect(f.json()).toMatchObject({ error: 'agent_outdated' });
    });
  });

  it('3.19: «Показать изображение» reads the file once, keeps a note; a missing file → 404 «Файл не найден на HP»', async () => {
    const id = await liveSession();
    const img = png(925, 83);
    files.set('C:\\Users\\alice\\Desktop\\shot.png', img);
    const r = await api('POST', `/api/sessions/${id}/images`, { path: 'C:\\Users\\alice\\Desktop\\shot.png' });
    expect(r.statusCode).toBe(200);
    const ev = (r.json() as { event: { kind: string; image: { path: string; blob: { $blob: string; width: number; height: number } } } }).event;
    expect(ev).toMatchObject({ kind: 'note', image: { path: 'C:\\Users\\alice\\Desktop\\shot.png', blob: { $blob: sha(img), width: 925, height: 83 } } });
    expect((await api('GET', `/api/blobs/${sha(img)}`)).statusCode).toBe(200);
    const reads = got.filter(m => m.type === 'fs.read_image').length;
    const again = await api('POST', `/api/sessions/${id}/images`, { path: 'C:\\Users\\alice\\Desktop\\shot.png' });
    expect(again.json()).toEqual(r.json());
    expect(got.filter(m => m.type === 'fs.read_image').length).toBe(reads); // unchanged file (size, mtime): no second read
    // The file changed on the machine: read again, a new note with the new image.
    const img2 = png(300, 200);
    files.set('C:\\Users\\alice\\Desktop\\shot.png', img2);
    mtimes.set('C:\\Users\\alice\\Desktop\\shot.png', 2);
    const changed = await api('POST', `/api/sessions/${id}/images`, { path: 'C:\\Users\\alice\\Desktop\\shot.png' });
    expect(got.filter(m => m.type === 'fs.read_image').length).toBe(reads + 1);
    expect(changed.json()).toMatchObject({ event: { image: { blob: { $blob: sha(img2), width: 300, height: 200 } } } });
    const page = (await api('GET', `/api/sessions/${id}/events`)).json() as { events: Array<{ kind: string; image?: unknown }> };
    expect(page.events.some(e => e.kind === 'note' && e.image)).toBe(true);
    const missing = await api('POST', `/api/sessions/${id}/images`, { path: 'C:\\nope.png' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'file_not_found', message: 'Файл не найден на HP' });
    expect((await api('POST', `/api/sessions/${id}/images`, { path: '\\\\evil\\share\\x.png' })).statusCode).toBe(422);
    // Offline machine: the newest stored copy is shown (the last test that needs the agent).
    agent.ws.close();
    await waitFor(() => !t.hub.agents.isOnline('hp'));
    expect((await api('POST', `/api/sessions/${id}/images`, { path: 'C:\\Users\\alice\\Desktop\\shot.png' })).json()).toEqual(changed.json());
  });

  it('CSP: HTML responses carry the policy; inline script hashes are computed', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/auth/callback' });
    expect(String(r.headers['content-type'])).toMatch(/^text\/html/);
    expect(r.headers['content-security-policy']).toContain("img-src 'self' blob: data:");
    const csp = contentSecurityPolicy('https://hub.internal.example.com', ["'sha256-abc'"]);
    expect(csp).toContain("script-src 'self' 'sha256-abc'");
    expect(csp).toContain("connect-src 'self' wss://hub.internal.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(inlineScriptHashes('/nonexistent')).toEqual([]);
    // A new web build without a hub restart: the hash follows index.html.
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-csp-'));
    try {
      const policy = cspProvider('https://hub.internal.example.com', dir);
      expect(policy()).toContain("script-src 'self';");
      writeFileSync(join(dir, 'index.html'), '<html><script>var a=1</script></html>');
      const h1 = inlineScriptHashes(dir)[0]!;
      expect(policy()).toContain(h1);
      writeFileSync(join(dir, 'index.html'), '<html><script>var theme=2</script></html>');
      utimesSync(join(dir, 'index.html'), new Date(), new Date(Date.now() + 5000));
      const p2 = policy();
      expect(p2).not.toContain(h1);
      expect(p2).toContain(inlineScriptHashes(dir)[0]!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
