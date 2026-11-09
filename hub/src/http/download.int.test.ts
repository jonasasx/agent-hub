// Tasks 3.1-3.3 (change `file-download`): fs/download of the hub against scripted agents and a real database.
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FS_CHUNK_MAX, PROTOCOL_VERSION } from '@agent-hub/shared';
import { autoReply, connectFakeAgent, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { attachmentDisposition } from './files.js';

interface FakeFile {
  path: string;
  data: Buffer;
  mtimeMs: number;
}

describe('fs/download (integration)', () => {
  let t: TestHub;
  let agent: FakeAgent;
  let browseOnly: FakeAgent;
  let cookie: string;
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const files = new Map<string, FakeFile>();
  /** called after each piece is answered: lets a test change the file in the middle of a download */
  let afterPiece: ((offset: number) => void) | null = null;

  const put = (path: string, size: number, mtimeMs = 1000): FakeFile => {
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i++) data[i] = (i * 7) % 256;
    const f = { path, data, mtimeMs };
    files.set(path, f);
    return f;
  };
  const get = (url: string, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> =>
    t.hub.app.inject({ method: 'GET', url, cookies: { ah_session: cookie }, headers: { 'sec-fetch-site': 'same-origin', origin: PUBLIC_URL, ...headers } });
  const enc = encodeURIComponent;
  const chunks = () => commands.filter(c => c.type === 'fs.read_chunk');

  beforeAll(async () => {
    t = await startTestHub({ logStream: { write: line => logs.push(line) } });
    const vmToken = await t.addRunner('vm', 'VM');
    const hpToken = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    agent = connectFakeAgent(t.wsBase, vmToken, { protocol: PROTOCOL_VERSION, capabilities: ['fs.list-dirs', 'fs.browse', 'fs.download'], homeDir: '/home/test' });
    autoReply(agent, (type, payload) => {
      if (type !== 'fs.read_chunk') return {};
      commands.push({ type, payload });
      const p = payload as { path: string; root: string; offset: number; length: number };
      if (p.path.includes('/.ssh/')) throw { code: 'restricted', message: 'restricted' };
      const f = files.get(p.path);
      if (!f) throw { code: 'not_found', message: 'not_found' };
      const slice = f.data.subarray(p.offset, Math.min(f.data.length, p.offset + p.length));
      const meta = { path: f.path, size: f.data.length, mtimeMs: f.mtimeMs, offset: p.offset, bytes: slice.length };
      if (afterPiece) afterPiece(p.offset);
      if (slice.length === 0) return meta;
      setTimeout(() => agent.ws.send(Buffer.from(slice)), 2);
      return { ...meta, binary: true };
    });
    await agent.next('welcome');
    // an agent of 1.15: can browse, cannot download
    browseOnly = connectFakeAgent(t.wsBase, hpToken, { protocol: '1.15', capabilities: ['fs.list-dirs', 'fs.browse'], homeDir: '/home/old' });
    autoReply(browseOnly, (type, payload) => {
      if (type.startsWith('fs.')) commands.push({ type, payload });
      return {};
    });
    await browseOnly.next('welcome');
    await waitFor(() => t.hub.agents.isOnline('vm') && t.hub.agents.isOnline('hp'));
  });
  afterAll(async () => {
    agent.ws.close();
    browseOnly.ws.close();
    await t.close();
  });

  it('streams a file of several pieces whole, with attachment headers and Content-Length', async () => {
    const f = put('/home/test/out/agent-hub-promo-ru.mp4', 2 * FS_CHUNK_MAX + 12345);
    const before = chunks().length;
    const r = await get(`/api/runners/vm/fs/download?path=${enc(f.path)}`);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(f.data.length);
    expect(r.rawPayload.equals(f.data)).toBe(true);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-length']).toBe(String(f.data.length));
    expect(r.headers['content-disposition']).toBe(`attachment; filename="agent-hub-promo-ru.mp4"; filename*=UTF-8''agent-hub-promo-ru.mp4`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('private, no-store');
    const sent = chunks().slice(before);
    expect(sent.map(c => c.payload.offset)).toEqual([0, FS_CHUNK_MAX, 2 * FS_CHUNK_MAX]);
    expect(sent.every(c => c.payload.length === FS_CHUNK_MAX && c.payload.root === '/home/test')).toBe(true);
  });

  it('serves an empty file and a file smaller than one piece', async () => {
    const empty = put('/home/test/empty.bin', 0);
    const r = await get(`/api/runners/vm/fs/download?path=${enc(empty.path)}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe('0');
    expect(r.rawPayload.length).toBe(0);
    const small = put('/home/test/a.zip', 777);
    const s = await get(`/api/runners/vm/fs/download?path=${enc(small.path)}`);
    expect(s.rawPayload.equals(small.data)).toBe(true);
  });

  it('answers the probe with name, size and mtime and reads no content', async () => {
    const f = put('/home/test/отчёт за ноябрь.pdf', 5 * 1024 * 1024, 4242);
    const before = chunks().length;
    const r = await get(`/api/runners/vm/fs/download?path=${enc(f.path)}&probe=1`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ name: 'отчёт за ноябрь.pdf', size: f.data.length, mtimeMs: 4242 });
    expect(
      chunks()
        .slice(before)
        .map(c => c.payload.length),
    ).toEqual([0]);
  });

  it('keeps a Cyrillic name in filename* and an ASCII fallback', async () => {
    const f = put('/home/test/отчёт за ноябрь.pdf', 10);
    const r = await get(`/api/runners/vm/fs/download?path=${enc(f.path)}`);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="_____ __ ______.pdf"; filename*=UTF-8''${enc('отчёт за ноябрь.pdf')}`);
    expect(attachmentDisposition(`a"b\\c'(1).txt`)).toBe(`attachment; filename="a_b_c'(1).txt"; filename*=UTF-8''a%22b%5Cc%27%281%29.txt`);
  });

  it('cuts the answer when the file changes in the middle of the download', async () => {
    const f = put('/home/test/growing.log', 2 * FS_CHUNK_MAX + 10);
    afterPiece = offset => {
      if (offset === 0) f.mtimeMs += 1;
    };
    try {
      const r = await get(`/api/runners/vm/fs/download?path=${enc(f.path)}`).catch((error: Error) => error);
      if (!(r instanceof Error)) expect(r.rawPayload.length).toBeLessThan(f.data.length);
    } finally {
      afterPiece = null;
    }
    const aborted = await waitFor(() => logs.find(l => l.includes('fs download aborted')));
    expect(aborted).toContain('file_changed');
    expect(aborted).not.toContain('growing.log');
  });

  it('refuses a secret and a missing file with an ordinary error before any byte', async () => {
    const secret = await get(`/api/runners/vm/fs/download?path=${enc('/home/test/.ssh/id_ed25519')}`);
    expect(secret.statusCode).toBe(403);
    expect(secret.json()).toMatchObject({ error: 'restricted' });
    expect(secret.headers['content-disposition']).toBeUndefined();
    const probe = await get(`/api/runners/vm/fs/download?path=${enc('/home/test/.ssh/id_ed25519')}&probe=1`);
    expect(probe.json()).toMatchObject({ error: 'restricted' });
    const missing = await get(`/api/runners/vm/fs/download?path=${enc('/home/test/none.bin')}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not_found' });
  });

  it('answers 409 capability_unavailable for an agent without fs.download and sends it nothing', async () => {
    const before = commands.length;
    const r = await get(`/api/runners/hp/fs/download?path=${enc('/home/old/a.bin')}&probe=1`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'capability_unavailable' });
    expect(commands.length).toBe(before);
  });

  it('refuses a cross-site request and an unsafe path', async () => {
    const f = put('/home/test/x.bin', 5);
    const cross = await get(`/api/runners/vm/fs/download?path=${enc(f.path)}`, { 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toMatchObject({ error: 'forbidden_origin' });
    const bad = await get(`/api/runners/vm/fs/download?path=${enc('/home/test/../../etc/passwd')}`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_path' });
  });
});
