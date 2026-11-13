// Task 2.4: GET /api/desktop/updates/:file (Requirement: Автообновление — the feed on the hub).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestHub, type TestHub } from '../test/harness.js';
import { hubTag, parseLatestYml } from './desktopUpdates.js';

const LATEST = [
  'version: 0.1.1',
  'files:',
  '  - url: Agent-Hub-Setup-0.1.1.exe',
  '    sha512: abc',
  '    size: 20',
  'path: Agent-Hub-Setup-0.1.1.exe',
  'sha512: abc',
  "releaseDate: '2026-11-13T00:00:00.000Z'",
  '',
].join('\n');
const SECOND = 'https://second.example:8443';

describe('/api/desktop/updates (integration)', () => {
  let t: TestHub;
  let none: TestHub;
  let cookie: string;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ah-desktop-'));
    const feed = join(root, 'feed');
    const web = join(root, 'web');
    mkdirSync(feed);
    mkdirSync(web);
    writeFileSync(join(feed, 'latest.yml'), LATEST);
    writeFileSync(join(feed, 'Agent-Hub-Setup-0.1.1.exe'), Buffer.from('0123456789abcdefghij'));
    writeFileSync(join(feed, 'Agent-Hub-Setup-0.1.1.exe.blockmap'), Buffer.from([1, 2, 3]));
    writeFileSync(join(feed, 'Agent-Hub-Setup-1.exe'), 'x');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>web</title>');
    // The web static plugin is registered too (as in production): both coexist.
    t = await startTestHub({ env: { DESKTOP_UPDATES_DIR: feed, WEB_DIST_DIR: web, EXTRA_PUBLIC_URLS: SECOND } });
    cookie = await t.login();
    none = await startTestHub();
  });
  afterAll(async () => {
    await t.close();
    await none.close();
    rmSync(root, { recursive: true, force: true });
  });

  const get = (h: TestHub['hub'], url: string, headers: Record<string, string> = {}, withCookie = true) =>
    h.app.inject({ method: 'GET', url, headers, ...(withCookie ? { cookies: { ah_session: cookie } } : {}) });

  it('Лента без входа → 401', async () => {
    const r = await get(t.hub, '/api/desktop/updates/latest.yml', {}, false);
    expect(r.statusCode).toBe(401);
  });

  it('latest.yml → 200, no-cache', async () => {
    const r = await get(t.hub, '/api/desktop/updates/latest.yml');
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(LATEST);
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('installer: 200 immutable; Range bytes=0-9 → 206', async () => {
    const full = await get(t.hub, '/api/desktop/updates/Agent-Hub-Setup-0.1.1.exe');
    expect(full.statusCode).toBe(200);
    expect(full.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await get(t.hub, '/api/desktop/updates/Agent-Hub-Setup-0.1.1.exe', { range: 'bytes=0-9' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('0123456789');
    expect(part.headers['content-range']).toBe('bytes 0-9/20');
    const map = await get(t.hub, '/api/desktop/updates/Agent-Hub-Setup-0.1.1.exe.blockmap');
    expect(map.statusCode).toBe(200);
    expect(map.rawPayload).toEqual(Buffer.from([1, 2, 3]));
  });

  it.each([
    '/api/desktop/updates/..%2F.env',
    '/api/desktop/updates/..%2F..%2F.env',
    '/api/desktop/updates/Agent-Hub-Setup-1.exe',
    '/api/desktop/updates/Agent-Hub-Setup-0.1.2.exe',
    '/api/desktop/updates/latest.yaml',
    '/api/desktop/updates/',
  ])('Чужое имя файла %s → 404', async url => {
    const r = await get(t.hub, url);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('SECRET');
  });

  it('without DESKTOP_UPDATES_DIR → 404', async () => {
    const c = await none.login();
    const r = await none.hub.app.inject({ method: 'GET', url: '/api/desktop/updates/latest.yml', cookies: { ah_session: c } });
    expect(r.statusCode).toBe(404);
  });

  it('the web SPA still answers next to the feed', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/s/abc' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<title>web</title>');
  });
});

// Change desktop-download, Requirement: Установщик на хабе.
describe('/api/desktop/info and /api/desktop/download (integration)', () => {
  let t: TestHub;
  let none: TestHub;
  let broken: TestHub;
  let cookie: string;
  let root: string;
  const https = { 'x-forwarded-proto': 'https' };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ah-desktop-dl-'));
    const feed = join(root, 'feed');
    const half = join(root, 'half');
    mkdirSync(feed);
    mkdirSync(half);
    writeFileSync(join(feed, 'latest.yml'), LATEST);
    writeFileSync(join(feed, 'Agent-Hub-Setup-0.1.1.exe'), Buffer.from('0123456789abcdefghij'));
    // latest.yml points to an installer that is not there.
    writeFileSync(join(half, 'latest.yml'), LATEST);
    t = await startTestHub({ env: { DESKTOP_UPDATES_DIR: feed, EXTRA_PUBLIC_URLS: SECOND } });
    cookie = await t.login();
    none = await startTestHub();
    broken = await startTestHub({ env: { DESKTOP_UPDATES_DIR: half } });
  });
  afterAll(async () => {
    await t.close();
    await none.close();
    await broken.close();
    rmSync(root, { recursive: true, force: true });
  });

  const get = (h: TestHub, url: string, headers: Record<string, string> = {}, session: string | null = cookie) =>
    h.hub.app.inject({ method: 'GET', url, headers, ...(session ? { cookies: { ah_session: session } } : {}) });

  it('Скачивание с основного адреса: bytes of the feed installer under the tagged name', async () => {
    const r = await get(t, '/api/desktop/download', { host: 'agents.test.example', ...https });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('0123456789abcdefghij');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-length']).toBe('20');
    expect(r.headers['cache-control']).toBe('private, no-cache');
    const name = 'Agent-Hub-Setup-0.1.1 [agents.test.example].exe';
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  it('info: version, size and the tagged name', async () => {
    const r = await get(t, '/api/desktop/info', { host: 'agents.test.example', ...https });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ available: true, version: '0.1.1', size: 20, fileName: 'Agent-Hub-Setup-0.1.1 [agents.test.example].exe' });
  });

  it('Второй публичный адрес: its host and port in the name', async () => {
    const r = await get(t, '/api/desktop/info', { host: 'second.example:8443', ...https });
    expect(r.json()).toMatchObject({ fileName: 'Agent-Hub-Setup-0.1.1 [second.example_8443].exe' });
  });

  it('Чужой адрес запроса: the host of PUBLIC_URL', async () => {
    const r = await get(t, '/api/desktop/download', { host: 'evil.example', ...https });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('filename="Agent-Hub-Setup-0.1.1 [agents.test.example].exe"');
  });

  it('Без входа: 401 for both', async () => {
    expect((await get(t, '/api/desktop/info', {}, null)).statusCode).toBe(401);
    expect((await get(t, '/api/desktop/download', {}, null)).statusCode).toBe(401);
  });

  it('Ленты нет: available false and 404', async () => {
    const c = await none.login();
    expect((await get(none, '/api/desktop/info', {}, c)).json()).toEqual({ available: false });
    expect((await get(none, '/api/desktop/download', {}, c)).statusCode).toBe(404);
  });

  it('latest.yml without its installer: available false and 404', async () => {
    const c = await broken.login();
    expect((await get(broken, '/api/desktop/info', {}, c)).json()).toEqual({ available: false });
    expect((await get(broken, '/api/desktop/download', {}, c)).statusCode).toBe(404);
  });
});

describe('parseLatestYml, hubTag', () => {
  it('reads top-level version and path, ignores files[].url', () => {
    expect(parseLatestYml(LATEST)).toEqual({ version: '0.1.1', path: 'Agent-Hub-Setup-0.1.1.exe' });
    expect(parseLatestYml("version: '0.1.8'\r\npath: Agent-Hub-Setup-0.1.8.exe\r\n")).toEqual({ version: '0.1.8', path: 'Agent-Hub-Setup-0.1.8.exe' });
    expect(parseLatestYml('version: 0.1.1\n')).toBeNull();
  });

  it('host, and host_port for a non-default port', () => {
    expect(hubTag('https://hub.example.com')).toBe('hub.example.com');
    expect(hubTag('https://hub.example.com:443')).toBe('hub.example.com');
    expect(hubTag('https://hub.example.com:8443')).toBe('hub.example.com_8443');
  });
});
