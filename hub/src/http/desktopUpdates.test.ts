// Task 2.4: GET /api/desktop/updates/:file (Requirement: Автообновление — the feed on the hub).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestHub, type TestHub } from '../test/harness.js';

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
    writeFileSync(join(feed, 'latest.yml'), 'version: 0.1.1\n');
    writeFileSync(join(feed, 'Agent-Hub-Setup-0.1.1.exe'), Buffer.from('0123456789abcdefghij'));
    writeFileSync(join(feed, 'Agent-Hub-Setup-0.1.1.exe.blockmap'), Buffer.from([1, 2, 3]));
    writeFileSync(join(feed, 'Agent-Hub-Setup-1.exe'), 'x');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>web</title>');
    // The web static plugin is registered too (as in production): both coexist.
    t = await startTestHub({ env: { DESKTOP_UPDATES_DIR: feed, WEB_DIST_DIR: web } });
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
    expect(r.body).toBe('version: 0.1.1\n');
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
