// The hub serves the web build: SPA routes get index.html, missing assets are 404, server routes stay server routes.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestHub, type TestHub } from '../test/harness.js';

const WEB = fileURLToPath(new URL(`../../../node_modules/.cache/agent-hub-test-web/${process.pid}`, import.meta.url));

const BUILD = { version: '0.1.0', commit: 'a1b2c3d', builtAt: '2026-10-28T06:15:00Z' };

describe('static web serving', () => {
  let t: TestHub;
  beforeAll(async () => {
    mkdirSync(`${WEB}/assets`, { recursive: true });
    writeFileSync(`${WEB}/index.html`, '<!doctype html><title>Agent Hub</title>');
    writeFileSync(`${WEB}/assets/app-123.js`, 'console.log(1)');
    writeFileSync(`${WEB}/manifest.webmanifest`, '{"name":"Agent Hub"}');
    // client-versions: the build info the web build writes (fixture; the real file comes from the web build).
    writeFileSync(`${WEB}/version.json`, JSON.stringify(BUILD));
    writeFileSync(`${WEB}/sw.js`, 'self.skipWaiting()');
    writeFileSync(`${WEB}/push-sw.js`, "self.addEventListener('push', () => {})");
    t = await startTestHub({ env: { WEB_DIST_DIR: WEB, VAPID_PUBLIC_KEY: '' } });
  });
  afterAll(async () => {
    await t.close();
    rmSync(WEB, { recursive: true, force: true });
  });

  it.each([
    ['/', 200, /text\/html/],
    ['/s/6f1c2a3b', 200, /text\/html/],
    ['/assets/app-123.js', 200, /javascript/],
    ['/manifest.webmanifest', 200, /manifest\+json/],
    ['/assets/app-old.js', 404, /json/],
    ['/api/unknown', 401, /json/],
    ['/auth/unknown', 404, /json/],
    // mcp-management B1: the MCP callback is a server route, never the SPA's index.html
    ['/mcp/unknown', 404, /json/],
    ['/mcp', 404, /json/],
  ])('GET %s → %d', async (url, status, type) => {
    const r = await t.hub.app.inject({ method: 'GET', url });
    expect(r.statusCode).toBe(status);
    expect(String(r.headers['content-type'])).toMatch(type);
  });

  // client-versions D1: the files that name the build are revalidated on every request; hashed bundles are not.
  it.each(['/', '/index.html', '/version.json', '/sw.js', '/push-sw.js', '/s/6f1c2a3b'])('GET %s → Cache-Control: no-cache', async url => {
    const r = await t.hub.app.inject({ method: 'GET', url });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('GET /mcp/oauth/callback without a session goes to the login, not to index.html', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/mcp/oauth/callback?code=c&state=s' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toMatch(/^\/auth\/login\?return=/);
  });

  it('a hashed bundle keeps the default Cache-Control', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=0');
  });

  it('/version.json is served without a session cookie, as JSON', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/version.json?t=1730000000000' });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/application\/json/);
    expect(r.json()).toEqual(BUILD);
  });

  it('an empty VAPID_PUBLIC_KEY is reported as null', async () => {
    const session = await t.login();
    const r = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(r.json()).toMatchObject({ vapidPublicKey: null });
  });
});
