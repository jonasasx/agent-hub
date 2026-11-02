import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const emailList = z
  .string()
  .min(1)
  .transform(s =>
    s
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.email()).min(1));

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PUBLIC_URL: z.url().transform(u => u.replace(/\/+$/, '')),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),
  /** Google (multi-user M2): OIDC_GOOGLE_* — the old names OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET are synonyms. */
  OIDC_GOOGLE_ISSUER: z.url().default('https://accounts.google.com'),
  OIDC_GOOGLE_CLIENT_ID: z.string().min(1),
  OIDC_GOOGLE_CLIENT_SECRET: z.string().min(1),
  /** Second provider (Keycloak or any OIDC issuer); without an issuer, client id or secret it is off. */
  OIDC_KEYCLOAK_ISSUER: z.url().optional(),
  /** Its name on the login button: «Войти через <label>». */
  OIDC_KEYCLOAK_LABEL: z.string().min(1).default('Keycloak'),
  OIDC_KEYCLOAK_CLIENT_ID: z.string().optional(),
  OIDC_KEYCLOAK_CLIENT_SECRET: z.string().optional(),
  /** Bootstrap administrators only (multi-user M2): everyone else enters by invite. */
  OIDC_ALLOWED_EMAILS: emailList,
  /**
   * Proxies whose X-Forwarded-For is trusted (Fastify trustProxy): comma-separated addresses or CIDRs — nginx on YM in
   * the VPN, the Traefik network. Default: loopback only (an X-Forwarded-For from anyone else is ignored).
   */
  TRUSTED_PROXIES: z
    .string()
    .default('127.0.0.1,::1')
    .transform(s =>
      s
        .split(',')
        .map(x => x.trim())
        .filter(Boolean),
    ),
  /** The agent build served at /agent/ (latest.json, agent-<v>.tgz); unset or missing — 404. */
  AGENT_DIST_DIR: z.string().default(fileURLToPath(new URL('../../agent/release/', import.meta.url))),
  /** Templates install.sh / install.ps1 (deploy/agent/); HUB_URL is substituted; missing file — 404. */
  INSTALLERS_DIR: z.string().default(fileURLToPath(new URL('../../deploy/agent/', import.meta.url))),
  AUTH_DEV_EMAIL: z.email().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  WEB_DIST_DIR: z.string().default(fileURLToPath(new URL('../../web/dist/', import.meta.url))),
  IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(30),
  PERMISSION_IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(120),
  EXTERNAL_WRITE_GUARD_MIN: z.coerce.number().int().nonnegative().default(10),
  AWS_REGION: z.string().default('eu-central-1'),
  /** S3 bucket for raw transcripts and blobs (D7). Required in production; tests inject a store. */
  S3_BUCKET_DATA: z.string().optional(),
  /** Key prefix inside the bucket (empty in production, `test/` for the integration check). */
  S3_PREFIX: z.string().default(''),
  /** GET /metrics needs `Authorization: Bearer <METRICS_TOKEN>`; unset — /metrics answers 404 (task 3.10). */
  METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
  /** The Postgres data volume as mounted into the hub (statfs for free space, D17). */
  DATA_VOLUME_PATH: z.string().default('/hostdata'),
  DISK_ALERT_FREE_PCT: z.coerce.number().min(1).max(99).default(15),
  /** How the warning names the host: «Agent Hub: на <label> свободно N% диска…». */
  ALERT_HOST_LABEL: z.string().default('hub'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** The vault as mounted into the hub (D9 p. 1: INDEX.md, 40-automation/repos.txt); unset — built-in projects only. */
  VAULT_DIR: z.string().optional(),
  /** mapping.csv of the 2026-10-04 restructuring (old vault paths → new, D9 p. 3); unset or missing — no translation. */
  LEGACY_PATHS_FILE: z.string().optional(),
  /** Remotes of the vault itself (comma-separated): no project by remote. */
  VAULT_REMOTES: z.string().default(''),
  /** The model of handoff.generate (D14; brief Q48: Sonnet until measured). */
  HANDOFF_MODEL: z.string().min(1).default('sonnet'),
  /** import:drive (task 3.12, D16): Google OAuth token file (read-only) and the Drive folder of session exports. */
  DRIVE_TOKEN_FILE: z.string().optional(),
  DRIVE_FOLDER_NAME: z.string().default('vault-sessions'),
  /** Update feed of the desktop app (latest.yml, Agent-Hub-Setup-<v>.exe[.blockmap]); unset — /api/desktop/updates/* → 404. */
  DESKTOP_UPDATES_DIR: z.string().optional(),
  /** Dictation (change voice-input, D4): ElevenLabs key; unset — dictation is off (`/api/me` voiceInput: false, 503). */
  ELEVENLABS_API_KEY: z.string().optional(),
  /** Base URL of the ElevenLabs API (a mock in tests). */
  ELEVENLABS_API_URL: z
    .url()
    .default('https://api.elevenlabs.io')
    .transform(u => u.replace(/\/+$/, '')),
  /** Scribe model and `language_code` of the transcription request. */
  VOICE_MODEL: z.string().min(1).default('scribe_v2'),
  VOICE_LANGUAGE: z.string().min(1).default('ru'),
  /** How long the hub waits for ElevenLabs, ms. */
  VOICE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Simultaneous transcriptions of the hub; one more gets 429 voice_busy. */
  VOICE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /**
   * claude-subscriptions P1: AES-256-GCM key of subscription tokens, base64 of exactly 32 bytes (`openssl rand -base64 32`).
   * Unset — the registry is read-only (adding/replacing a token → 503 subscriptions_disabled), sessions run under the
   * machine login.
   */
  SUBSCRIPTION_TOKEN_KEY: z
    .string()
    .refine(v => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
      message: 'SUBSCRIPTION_TOKEN_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)',
    })
    .optional(),
  /** claude-subscriptions P11: show the hint that claude.ai connectors may be unavailable under a subscription. */
  SUBSCRIPTION_CONNECTORS_HINT: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform(v => v === 'true' || v === '1'),
  /** subscription-limits L2/L5: probe turns under subscription tokens (false — only session events feed the limits). */
  LIMITS_PROBE_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform(v => v === 'true' || v === '1'),
  /** Data older than this gets a probe turn; 0 — periodic probes off, only «Обновить». */
  LIMITS_PROBE_IDLE_SEC: z.coerce.number().int().nonnegative().default(1800),
  /** How long the hub waits for a probe's answer; at least 60 s — the agent gives up after 55 s (PROBE_MAX_MS), a shorter
   * hub wait would drop answers the agent still sends (review A2). */
  LIMITS_PROBE_TIMEOUT_SEC: z.coerce.number().int().min(60).max(600).default(60),
  /** The model of a probe turn: the cheapest one. */
  LIMITS_PROBE_MODEL: z.string().min(1).max(64).default('haiku'),
  /** «Обновить» at most this often per subscription. */
  LIMITS_REFRESH_MIN_SEC: z.coerce.number().int().nonnegative().default(30),
  /** Runner ids or hostnames tried last for probes, comma-separated (e.g. the hub's own host). */
  LIMITS_PROBE_LAST_HOSTS: z
    .string()
    .default('')
    .transform(v =>
      v
        .split(',')
        .map(x => x.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema> & {
  /** Origin of PUBLIC_URL, compared with the Origin header of mutating requests. */
  publicOrigin: string;
  /** The second provider is configured (issuer, client id and secret): «Войти через <OIDC_KEYCLOAK_LABEL>» is offered. */
  keycloakEnabled: boolean;
  /** SUBSCRIPTION_TOKEN_KEY is set: tokens can be stored (claude-subscriptions P1). */
  subscriptionsEnabled: boolean;
};

/** Old single-provider names (MVP) are synonyms of OIDC_GOOGLE_*; the new name wins when both are set. */
const SYNONYMS: Array<[string, string]> = [
  ['OIDC_ISSUER', 'OIDC_GOOGLE_ISSUER'],
  ['OIDC_CLIENT_ID', 'OIDC_GOOGLE_CLIENT_ID'],
  ['OIDC_CLIENT_SECRET', 'OIDC_GOOGLE_CLIENT_SECRET'],
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value in .env (`DISK_ALERT_FREE_PCT=`, `METRICS_TOKEN=` from .env.example) means «not set»: the default applies.
  const given: Record<string, string | undefined> = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  for (const [old, now] of SYNONYMS) if (given[now] === undefined && given[old] !== undefined) given[now] = given[old];
  const parsed = schema.safeParse(given);
  if (!parsed.success) {
    throw new Error(`Invalid hub configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  const url = new URL(c.PUBLIC_URL);
  // Requirement: Вход через Google OIDC — the dev login bypass exists only for e2e tests.
  if (c.AUTH_DEV_EMAIL && c.NODE_ENV !== 'test') {
    throw new Error('AUTH_DEV_EMAIL is allowed only with NODE_ENV=test');
  }
  return {
    ...c,
    publicOrigin: url.origin,
    keycloakEnabled: Boolean(c.OIDC_KEYCLOAK_ISSUER && c.OIDC_KEYCLOAK_CLIENT_ID && c.OIDC_KEYCLOAK_CLIENT_SECRET),
    subscriptionsEnabled: c.SUBSCRIPTION_TOKEN_KEY !== undefined,
  };
}
