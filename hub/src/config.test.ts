import { describe, expect, it } from 'vitest';
import { loadConfig, loadS3Settings } from './config.js';

const base = {
  PUBLIC_URL: 'https://hub.internal.example.com/',
  DATABASE_URL: 'postgres://x',
  COOKIE_SECRET: 'x'.repeat(32),
  OIDC_GOOGLE_CLIENT_ID: 'id',
  OIDC_GOOGLE_CLIENT_SECRET: 'secret',
  OIDC_ALLOWED_EMAILS: ' Alice@example.com , other@example.com',
};

const single = {
  OIDC_ISSUER: 'https://getagenthub.dev/id/realms/agent-hub',
  OIDC_CLIENT_ID: 'agent-hub',
  OIDC_CLIENT_SECRET: 'kc-secret',
};

describe('loadConfig', () => {
  it('parses defaults, normalizes the allowlist and the public origin', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.OIDC_GOOGLE_ISSUER).toBe('https://accounts.google.com');
    expect(c.OIDC_ALLOWED_EMAILS).toEqual(['alice@example.com', 'other@example.com']);
    expect(c.PUBLIC_URL).toBe('https://hub.internal.example.com');
    expect(c.publicOrigins).toEqual(['https://hub.internal.example.com']);
  });

  it('web-push-notifications D1: push is on only with the whole VAPID set; a partial set is reported', () => {
    const none = loadConfig(base);
    expect(none.pushEnabled).toBe(false);
    expect(none.pushIncomplete).toBe(false);
    const full = loadConfig({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com' });
    expect(full.pushEnabled).toBe(true);
    expect(full.pushIncomplete).toBe(false);
    expect(loadConfig({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'https://hub.example.com/contact' }).pushEnabled).toBe(true);
    // the way production has it today: only the subject
    const partial = loadConfig({ ...base, VAPID_SUBJECT: 'mailto:ops@example.com' });
    expect(partial.pushEnabled).toBe(false);
    expect(partial.pushIncomplete).toBe(true);
    expect(loadConfig({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:ops@example.com' }).pushEnabled).toBe(false);
    // the contact must be mailto: or https:
    const bad = loadConfig({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'ops@example.com' });
    expect(bad.pushEnabled).toBe(false);
    expect(bad.pushIncomplete).toBe(true);
  });

  it('rejects a short cookie secret and a missing client secret', () => {
    expect(() => loadConfig({ ...base, COOKIE_SECRET: 'short' })).toThrow(/COOKIE_SECRET/);
    expect(() => loadConfig({ ...base, OIDC_GOOGLE_CLIENT_SECRET: undefined })).toThrow(/OIDC_GOOGLE_CLIENT_SECRET/);
  });

  it('refuses AUTH_DEV_EMAIL outside NODE_ENV=test', () => {
    expect(() => loadConfig({ ...base, AUTH_DEV_EMAIL: 'alice@example.com', NODE_ENV: 'production', PUBLIC_URL: 'http://localhost:8080' })).toThrow(/AUTH_DEV_EMAIL/);
    expect(loadConfig({ ...base, AUTH_DEV_EMAIL: 'alice@example.com', NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:8080' }).AUTH_DEV_EMAIL).toBe('alice@example.com');
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
  // Change keycloak-auth, task 3.1 (D5).
  it('keycloak-auth: OIDC_ISSUER is the single provider, not a synonym of Google', () => {
    const { OIDC_GOOGLE_CLIENT_ID: _a, OIDC_GOOGLE_CLIENT_SECRET: _b, ...rest } = base;
    const c = loadConfig({ ...rest, ...single });
    expect(c.singleProvider).toBe(true);
    expect(c.OIDC_ISSUER).toBe('https://getagenthub.dev/id/realms/agent-hub');
    expect(c.OIDC_GOOGLE_CLIENT_ID).toBeUndefined();
    expect(c.SIGNUP_MODE).toBe('invite');
    expect(c.idpHints).toEqual([]);
    expect(c.accountUrl).toBe('https://getagenthub.dev/id/realms/agent-hub/account');
    expect(loadConfig({ ...rest, ...single, OIDC_ACCOUNT_URL: 'https://acc.example/me' }).accountUrl).toBe('https://acc.example/me');
    expect(loadConfig({ ...rest, ...single, OIDC_ISSUER: 'https://accounts.google.com' }).accountUrl).toBeNull();
    expect(loadConfig({ ...rest, ...single, SIGNUP_MODE: 'open' }).SIGNUP_MODE).toBe('open');
    expect(() => loadConfig({ ...rest, ...single, SIGNUP_MODE: 'maybe' })).toThrow(/SIGNUP_MODE/);
    expect(loadConfig(base).singleProvider).toBe(false);
    expect(loadConfig(base).accountUrl).toBeNull();
  });

  it('keycloak-auth: both modes at once stop the start and name both variables', () => {
    expect(() => loadConfig({ ...base, ...single })).toThrow(/OIDC_ISSUER.*OIDC_GOOGLE_CLIENT_ID/);
    // the production .env before the change: OIDC_ISSUER=Google with the old synonyms and the second provider
    const old = {
      ...base,
      OIDC_GOOGLE_CLIENT_ID: undefined,
      OIDC_GOOGLE_CLIENT_SECRET: undefined,
      OIDC_ISSUER: 'https://accounts.google.com',
      OIDC_CLIENT_ID: 'g',
      OIDC_CLIENT_SECRET: 's',
      OIDC_KEYCLOAK_ISSUER: 'https://sso.example.com/realms/acme',
    };
    expect(() => loadConfig(old)).toThrow(/OIDC_ISSUER.*OIDC_KEYCLOAK_ISSUER/);
    // the old names without OIDC_ISSUER are not Google either
    expect(() => loadConfig({ ...base, OIDC_CLIENT_ID: 'g' })).toThrow(/OIDC_CLIENT_ID needs OIDC_ISSUER/);
    const { OIDC_GOOGLE_CLIENT_ID: _a, OIDC_GOOGLE_CLIENT_SECRET: _b, ...rest } = base;
    expect(() => loadConfig({ ...rest, ...single, OIDC_CLIENT_SECRET: undefined })).toThrow(/OIDC_ISSUER needs OIDC_CLIENT_SECRET/);
    expect(() => loadConfig(rest)).toThrow(/OIDC_GOOGLE_CLIENT_ID/);
    // empty values from .env.example do not count
    expect(loadConfig({ ...rest, ...single, OIDC_KEYCLOAK_ISSUER: '', OIDC_GOOGLE_CLIENT_ID: '' }).singleProvider).toBe(true);
  });

  it('keycloak-auth: OIDC_IDP_HINTS — buttons per address; an unknown address stops the start', () => {
    const { OIDC_GOOGLE_CLIENT_ID: _a, OIDC_GOOGLE_CLIENT_SECRET: _b, ...rest } = base;
    const env = { ...rest, ...single, EXTRA_PUBLIC_URLS: 'https://second.example,https://third.example' };
    const c = loadConfig({ ...env, OIDC_IDP_HINTS: 'corp:Corp@https://second.example/,https://third.example, google:Google' });
    expect(c.idpHints).toEqual([
      { id: 'corp', label: 'Corp', origins: ['https://second.example', 'https://third.example'] },
      { id: 'google', label: 'Google', origins: [] },
    ]);
    expect(() => loadConfig({ ...env, OIDC_IDP_HINTS: 'corp:Corp@https://foreign.example' })).toThrow(/OIDC_IDP_HINTS contains an unknown public origin/);
    expect(() => loadConfig({ ...env, OIDC_IDP_HINTS: 'corp:Corp@not a url' })).toThrow(/OIDC_IDP_HINTS/);
    expect(() => loadConfig({ ...env, OIDC_IDP_HINTS: 'corp' })).toThrow(/OIDC_IDP_HINTS/);
    expect(() => loadConfig({ ...env, OIDC_IDP_HINTS: 'a:A,a:B' })).toThrow(/repeats/);
    expect(() => loadConfig({ ...base, OIDC_IDP_HINTS: 'a:A' })).toThrow(/OIDC_IDP_HINTS needs OIDC_ISSUER/);
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

  it('voice-conversation: the signed-URL key is VOICE_AGENT_API_KEY, else ELEVENLABS_API_KEY', () => {
    const talk = { ...base, VOICE_AGENT_ID: 'agent_x', VOICE_LLM_KEY: 'k'.repeat(32) };
    expect(loadConfig(talk).voiceTalkEnabled).toBe(false);
    const dictation = loadConfig({ ...talk, ELEVENLABS_API_KEY: 'sk_stt' });
    expect(dictation.voiceTalkEnabled).toBe(true);
    expect(dictation.voiceAgentApiKey).toBe('sk_stt');
    const own = loadConfig({ ...talk, ELEVENLABS_API_KEY: 'sk_stt', VOICE_AGENT_API_KEY: 'sk_agents' });
    expect(own.voiceAgentApiKey).toBe('sk_agents');
    const onlyAgent = loadConfig({ ...talk, VOICE_AGENT_API_KEY: 'sk_agents', ELEVENLABS_API_KEY: '' });
    expect(onlyAgent.voiceTalkEnabled).toBe(true);
    expect(onlyAgent.ELEVENLABS_API_KEY).toBeUndefined();
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

describe('loadConfig: PaaS-provided names (paas-deployment D1)', () => {
  const { OIDC_ALLOWED_EMAILS: _admins, ...noAdmins } = base;
  const platformS3 = {
    S3_ENDPOINT: 'https://s3.example.com',
    S3_BUCKET: 'paas-bucket',
    S3_REGION: 'region-1',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_FORCE_PATH_STYLE: 'true',
  };

  it('takes the bucket, region, endpoint and keys of the platform when the hub names are not set', () => {
    const c = loadConfig({ ...base, ...platformS3 });
    expect(c.S3_BUCKET_DATA).toBe('paas-bucket');
    expect(c.AWS_REGION).toBe('region-1');
    expect(c.S3_ENDPOINT).toBe('https://s3.example.com');
    expect(c.S3_FORCE_PATH_STYLE).toBe(true);
    expect(c.S3_ACCESS_KEY_ID).toBe('key');
    expect(c.S3_SECRET_ACCESS_KEY).toBe('secret');
  });

  it('the hub names win when both are set; the AWS installation keeps its defaults', () => {
    const c = loadConfig({ ...base, ...platformS3, S3_BUCKET_DATA: 'agent-hub-data', AWS_REGION: 'eu-central-1' });
    expect(c.S3_BUCKET_DATA).toBe('agent-hub-data');
    expect(c.AWS_REGION).toBe('eu-central-1');
    const aws = loadConfig({ ...base, S3_BUCKET_DATA: 'agent-hub-data' });
    expect(aws.AWS_REGION).toBe('eu-central-1');
    expect(aws.S3_ENDPOINT).toBeUndefined();
    expect(aws.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('rejects an S3_FORCE_PATH_STYLE value other than true/false/1/0', () => {
    expect(() => loadConfig({ ...base, ...platformS3, S3_FORCE_PATH_STYLE: 'yes' })).toThrow(/S3_FORCE_PATH_STYLE/);
  });

  it('rejects one static key without the other', () => {
    const { S3_SECRET_ACCESS_KEY: _secret, ...halfKeys } = platformS3;
    expect(() => loadConfig({ ...base, ...halfKeys })).toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    expect(() => loadS3Settings(halfKeys)).toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
  });

  it('the CLI resolves S3 settings like the server', () => {
    const server = loadConfig({ ...base, ...platformS3 });
    const cli = loadS3Settings({ ...platformS3, S3_PREFIX: '' });
    expect(cli).toEqual({
      AWS_REGION: server.AWS_REGION,
      S3_BUCKET_DATA: server.S3_BUCKET_DATA,
      S3_ENDPOINT: server.S3_ENDPOINT,
      S3_FORCE_PATH_STYLE: server.S3_FORCE_PATH_STYLE,
      S3_ACCESS_KEY_ID: server.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: server.S3_SECRET_ACCESS_KEY,
      S3_PREFIX: server.S3_PREFIX,
    });
    expect(() => loadS3Settings({ S3_FORCE_PATH_STYLE: 'yes' })).toThrow(/S3_FORCE_PATH_STYLE/);
  });

  it('HUB_ADMIN_EMAILS fills OIDC_ALLOWED_EMAILS; OIDC_ALLOWED_EMAILS wins when both are set', () => {
    expect(loadConfig({ ...noAdmins, HUB_ADMIN_EMAILS: 'Bob@corp.example' }).OIDC_ALLOWED_EMAILS).toEqual(['bob@corp.example']);
    expect(loadConfig({ ...base, HUB_ADMIN_EMAILS: 'bob@corp.example' }).OIDC_ALLOWED_EMAILS).toEqual(['alice@example.com', 'other@example.com']);
  });

  it('refuses to start without either list of administrators', () => {
    expect(() => loadConfig(noAdmins)).toThrow(/OIDC_ALLOWED_EMAILS or HUB_ADMIN_EMAILS/);
    expect(() => loadConfig({ ...noAdmins, HUB_ADMIN_EMAILS: '' })).toThrow(/OIDC_ALLOWED_EMAILS or HUB_ADMIN_EMAILS/);
  });
});
