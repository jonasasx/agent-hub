import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  PUBLIC_URL: 'https://hub.internal.example.com/',
  DATABASE_URL: 'postgres://x',
  COOKIE_SECRET: 'x'.repeat(32),
  OIDC_CLIENT_ID: 'id',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_ALLOWED_EMAILS: ' Jonasasx@gmail.com , other@example.com',
};

describe('loadConfig', () => {
  it('parses defaults, normalizes the allowlist and the public origin', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.OIDC_GOOGLE_ISSUER).toBe('https://accounts.google.com');
    expect(c.OIDC_ALLOWED_EMAILS).toEqual(['jonasasx@gmail.com', 'other@example.com']);
    expect(c.PUBLIC_URL).toBe('https://hub.internal.example.com');
    expect(c.publicOrigins).toEqual(['https://hub.internal.example.com']);
  });

  it('rejects a short cookie secret and a missing client secret', () => {
    expect(() => loadConfig({ ...base, COOKIE_SECRET: 'short' })).toThrow(/COOKIE_SECRET/);
    expect(() => loadConfig({ ...base, OIDC_CLIENT_SECRET: undefined })).toThrow(/OIDC_GOOGLE_CLIENT_SECRET/);
  });

  it('refuses AUTH_DEV_EMAIL outside NODE_ENV=test', () => {
    expect(() => loadConfig({ ...base, AUTH_DEV_EMAIL: 'jonasasx@gmail.com', NODE_ENV: 'production', PUBLIC_URL: 'http://localhost:8080' })).toThrow(/AUTH_DEV_EMAIL/);
    expect(loadConfig({ ...base, AUTH_DEV_EMAIL: 'jonasasx@gmail.com', NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:8080' }).AUTH_DEV_EMAIL).toBe('jonasasx@gmail.com');
  });
  it('M3c: empty values from .env take the defaults (DISK_ALERT_FREE_PCT=, METRICS_TOKEN=); a short METRICS_TOKEN is refused', () => {
    const c = loadConfig({ ...base, DISK_ALERT_FREE_PCT: '', METRICS_TOKEN: '', DATA_VOLUME_PATH: '', TELEGRAM_BOT_TOKEN: '' });
    expect(c.DISK_ALERT_FREE_PCT).toBe(15);
    expect(c.METRICS_TOKEN).toBeUndefined();
    expect(c.DATA_VOLUME_PATH).toBe('/hostdata');
    expect(c.ALERT_HOST_LABEL).toBe('hub');
    expect(() => loadConfig({ ...base, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
  });

  // Change multi-user, task 2.1.
  it('multi-user: the old OIDC_* names are synonyms of OIDC_GOOGLE_*; the new name wins', () => {
    const c = loadConfig({ ...base, OIDC_ISSUER: 'https://old.example' });
    expect(c.OIDC_GOOGLE_CLIENT_ID).toBe('id');
    expect(c.OIDC_GOOGLE_CLIENT_SECRET).toBe('secret');
    expect(c.OIDC_GOOGLE_ISSUER).toBe('https://old.example');
    expect(loadConfig({ ...base, OIDC_GOOGLE_CLIENT_ID: 'new' }).OIDC_GOOGLE_CLIENT_ID).toBe('new');
    const { OIDC_CLIENT_ID: _a, OIDC_CLIENT_SECRET: _b, ...rest } = base;
    expect(loadConfig({ ...rest, OIDC_GOOGLE_CLIENT_ID: 'g', OIDC_GOOGLE_CLIENT_SECRET: 's' }).OIDC_GOOGLE_CLIENT_ID).toBe('g');
  });

  it('multi-user: the second provider is off without an issuer, client id or secret, on with all three', () => {
    const issuer = 'https://sso.example.com/realms/acme';
    expect(loadConfig(base).keycloakEnabled).toBe(false);
    expect(loadConfig({ ...base, OIDC_KEYCLOAK_ISSUER: issuer, OIDC_KEYCLOAK_CLIENT_ID: 'agent-hub' }).keycloakEnabled).toBe(false);
    expect(loadConfig({ ...base, OIDC_KEYCLOAK_CLIENT_ID: 'agent-hub', OIDC_KEYCLOAK_CLIENT_SECRET: 'x' }).keycloakEnabled).toBe(false);
    const c = loadConfig({ ...base, OIDC_KEYCLOAK_ISSUER: issuer, OIDC_KEYCLOAK_CLIENT_ID: 'agent-hub', OIDC_KEYCLOAK_CLIENT_SECRET: 'x' });
    expect(c.keycloakEnabled).toBe(true);
    expect(c.OIDC_KEYCLOAK_LABEL).toBe('Keycloak');
  });

  it('multi-user: TRUSTED_PROXIES list (default loopback)', () => {
    expect(loadConfig(base).TRUSTED_PROXIES).toEqual(['127.0.0.1', '::1']);
    expect(loadConfig({ ...base, TRUSTED_PROXIES: '10.0.0.1, 172.18.0.0/16' }).TRUSTED_PROXIES).toEqual(['10.0.0.1', '172.18.0.0/16']);
  });

  it('voice-input: dictation defaults; an empty ELEVENLABS_API_KEY= means «not set»', () => {
    const c = loadConfig({ ...base, ELEVENLABS_API_KEY: '', VOICE_TIMEOUT_MS: '' });
    expect(c.ELEVENLABS_API_KEY).toBeUndefined();
    expect(c.ELEVENLABS_API_URL).toBe('https://api.elevenlabs.io');
    expect(c.VOICE_MODEL).toBe('scribe_v2');
    expect(c.VOICE_LANGUAGE).toBe('ru');
    expect(c.VOICE_TIMEOUT_MS).toBe(60_000);
    expect(c.VOICE_CONCURRENCY).toBe(2);
    const set = loadConfig({ ...base, ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_API_URL: 'http://127.0.0.1:9999/', VOICE_CONCURRENCY: '3' });
    expect(set.ELEVENLABS_API_KEY).toBe('sk_test');
    expect(set.ELEVENLABS_API_URL).toBe('http://127.0.0.1:9999');
    expect(set.VOICE_CONCURRENCY).toBe(3);
    expect(() => loadConfig({ ...base, VOICE_CONCURRENCY: '0' })).toThrow(/VOICE_CONCURRENCY/);
  });

  it('claude-subscriptions 4.2: SUBSCRIPTION_TOKEN_KEY — base64 of 32 bytes, else a clear error; unset or empty — subscriptions off', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const on = loadConfig({ ...base, SUBSCRIPTION_TOKEN_KEY: key });
    expect(on.subscriptionsEnabled).toBe(true);
    expect(on.SUBSCRIPTION_CONNECTORS_HINT).toBe(true);
    expect(() => loadConfig({ ...base, SUBSCRIPTION_TOKEN_KEY: Buffer.alloc(31, 7).toString('base64') })).toThrow(/SUBSCRIPTION_TOKEN_KEY must be base64 of exactly 32 bytes/);
    expect(() => loadConfig({ ...base, SUBSCRIPTION_TOKEN_KEY: Buffer.alloc(33, 7).toString('base64') })).toThrow(/exactly 32 bytes/);
    expect(() => loadConfig({ ...base, SUBSCRIPTION_TOKEN_KEY: 'not base64 at all!' })).toThrow(/SUBSCRIPTION_TOKEN_KEY/);
    expect(loadConfig(base).subscriptionsEnabled).toBe(false);
    expect(loadConfig({ ...base, SUBSCRIPTION_TOKEN_KEY: '' }).subscriptionsEnabled).toBe(false);
    expect(loadConfig({ ...base, SUBSCRIPTION_CONNECTORS_HINT: 'false' }).SUBSCRIPTION_CONNECTORS_HINT).toBe(false);
    expect(() => loadConfig({ ...base, SUBSCRIPTION_CONNECTORS_HINT: 'maybe' })).toThrow(/SUBSCRIPTION_CONNECTORS_HINT/);
  });

  it('subscription-limits 5.2: LIMITS_* defaults and checks', () => {
    const c = loadConfig(base);
    expect([c.LIMITS_PROBE_ENABLED, c.LIMITS_PROBE_IDLE_SEC, c.LIMITS_PROBE_TIMEOUT_SEC, c.LIMITS_PROBE_MODEL, c.LIMITS_REFRESH_MIN_SEC, c.LIMITS_PROBE_LAST_HOSTS]).toEqual([
      true,
      1800,
      60,
      'haiku',
      30,
      [],
    ]);
    const set = loadConfig({ ...base, LIMITS_PROBE_ENABLED: 'false', LIMITS_PROBE_IDLE_SEC: '0', LIMITS_PROBE_MODEL: 'claude-haiku-4-5', LIMITS_PROBE_LAST_HOSTS: 'vm, ip-10-0-0-3 ,' });
    expect([set.LIMITS_PROBE_ENABLED, set.LIMITS_PROBE_IDLE_SEC, set.LIMITS_PROBE_MODEL, set.LIMITS_PROBE_LAST_HOSTS]).toEqual([false, 0, 'claude-haiku-4-5', ['vm', 'ip-10-0-0-3']]);
    expect(() => loadConfig({ ...base, LIMITS_PROBE_ENABLED: 'maybe' })).toThrow(/LIMITS_PROBE_ENABLED/);
    expect(() => loadConfig({ ...base, LIMITS_PROBE_IDLE_SEC: '-1' })).toThrow(/LIMITS_PROBE_IDLE_SEC/);
    expect(() => loadConfig({ ...base, LIMITS_PROBE_TIMEOUT_SEC: '1' })).toThrow(/LIMITS_PROBE_TIMEOUT_SEC/);
    // review A2: below the agent's own 55 s the hub would give up on answers still coming
    expect(() => loadConfig({ ...base, LIMITS_PROBE_TIMEOUT_SEC: '59' })).toThrow(/LIMITS_PROBE_TIMEOUT_SEC/);
    expect(loadConfig({ ...base, LIMITS_PROBE_TIMEOUT_SEC: '60' }).LIMITS_PROBE_TIMEOUT_SEC).toBe(60);
  });
});

describe('Keycloak public addresses', () => {
  it('empty list offers Keycloak everywhere', () => {
    expect(loadConfig(base).keycloakOrigins).toEqual([]);
    expect(loadConfig({ ...base, OIDC_KEYCLOAK_PUBLIC_URLS: '' }).keycloakOrigins).toEqual([]);
  });

  it('normalizes URLs and compares origins, preserving configured order', () => {
    const c = loadConfig({
      ...base,
      EXTRA_PUBLIC_URLS: 'https://second.example/',
      OIDC_KEYCLOAK_PUBLIC_URLS: ' https://second.example///, https://hub.internal.example.com/path/, ',
    });
    expect(c.keycloakOrigins).toEqual(['https://second.example', 'https://hub.internal.example.com']);
  });

  it.each(['https://foreign.example', 'not a URL'])('rejects an invalid address: %s', value => {
    expect(() => loadConfig({ ...base, OIDC_KEYCLOAK_PUBLIC_URLS: value })).toThrow(/OIDC_KEYCLOAK_PUBLIC_URLS/);
  });
});
