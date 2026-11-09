// /auth/dev-login (NODE_ENV=test only) uses the same return-path rules as the OIDC callback.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieValue, startTestHub, type TestHub } from '../test/harness.js';

describe('/auth/dev-login', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub({ env: { AUTH_DEV_EMAIL: 'alice@example.com' } });
  });
  afterAll(async () => t.close());

  it.each([
    ['/s/1', '/s/1'],
    ['/..//evil.example', '/'],
    ['/%2e%2e//evil.example', '/'],
    ['/\t/evil.example', '/'],
    ['//evil.example', '/'],
  ])('return=%s → Location %s', async (ret, location) => {
    const r = await t.hub.app.inject({ method: 'GET', url: `/auth/dev-login?return=${encodeURIComponent(ret)}` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(location);
    expect(cookieValue(r.headers['set-cookie'], 'ah_session')).toBeTruthy();
  });
});
