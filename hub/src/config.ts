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

/** S3 settings of the hub; the server and the CLI read them alike (change paas-deployment D1). */
const s3Fields = {
  AWS_REGION: z.string().default('eu-central-1'),
  /** S3 bucket for raw transcripts and blobs (D7). Required in production; tests inject a store. */
  S3_BUCKET_DATA: z.string().optional(),
  /** S3-compatible endpoint (MinIO, Ceph RGW and others); unset — AWS by region. */
  S3_ENDPOINT: z.url().optional(),
  /** Path-style addressing (`<endpoint>/<bucket>/<key>`), needed by most S3-compatible stores. */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform(v => v === 'true' || v === '1'),
  /** Static keys of the store; unset — the AWS SDK default chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). */
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Key prefix inside the bucket (empty in production, `test/` for the integration check). */
  S3_PREFIX: z.string().default(''),
};

const s3Schema = z.object(s3Fields);

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  // projects-catalog: the session classifier runs one turn of a small model under the user's subscription on the utility runner
  PROJECT_CLASSIFIER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform(v => v === 'true'),
  SESSION_TITLE_TIMEOUT_MS: z.coerce.number().int().min(1).max(180_000).default(60_000),
  PROJECT_CLASSIFIER_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  PROJECT_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().min(1).max(180_000).default(90_000),
  PROJECT_CLASSIFIER_MAX_MESSAGES: z.coerce.number().int().min(1).max(5).default(5),
  PROJECT_CLASSIFIER_MAX_INPUT_CHARS: z.coerce.number().int().min(1).max(6000).default(6000),
  PROJECT_CLASSIFIER_MAX_CANDIDATES: z.coerce.number().int().min(1).max(300).default(150),
  /** At or above: the session is assigned without asking; below: a card with options. */
  PROJECT_CLASSIFIER_AUTO_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  PROJECT_CLASSIFIER_MAX_CALLS_PER_SESSION: z.coerce.number().int().min(1).max(10).default(3),
  PROJECT_CLASSIFIER_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(1).max(1000).default(200),
  /** The model sees only sessions that started within this window; replicated history keeps the rules only. */
  PROJECT_CLASSIFIER_MAX_SESSION_AGE_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
  PUBLIC_URL: z.url().transform(u => u.replace(/\/+$/, '')),
  /** More addresses the hub is served on (comma-separated): login, Origin checks and CSP accept each of them. */
  EXTRA_PUBLIC_URLS: z
    .string()
    .default('')
    .transform(s =>
      s
        .split(',')
        .map(x => x.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    )
    .pipe(z.array(z.url())),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),
  /**
   * Single provider (change keycloak-auth, D5): the one OIDC issuer the hub signs in through (Keycloak of the installation).
   * Unset — the former two-provider mode with OIDC_GOOGLE_* and OIDC_KEYCLOAK_*; both modes at once is a configuration error.
   */
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  /** Caption of the main login button; unset — «Войти» in the language of the request. */
  OIDC_PROVIDER_LABEL: z.string().optional(),
  /** Login buttons that skip the provider's own page: `hint:Label[@url,url]`, comma-separated, e.g. `corp:Corp@https://a.example`. */
  OIDC_IDP_HINTS: z.string().default(''),
  /** «Управление входом» link; unset — `<OIDC_ISSUER>/account` when the issuer is a Keycloak realm (`/realms/`). */
  OIDC_ACCOUNT_URL: z.url().optional(),
  /** invite — only invited addresses get an account; open — anyone with a verified address becomes a user. */
  SIGNUP_MODE: z.enum(['invite', 'open']).default('invite'),
  /** Google (multi-user M2) of the two-provider mode. */
  OIDC_GOOGLE_ISSUER: z.url().default('https://accounts.google.com'),
  OIDC_GOOGLE_CLIENT_ID: z.string().optional(),
  OIDC_GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Second provider (Keycloak or any OIDC issuer); without an issuer, client id or secret it is off. */
  OIDC_KEYCLOAK_ISSUER: z.url().optional(),
  /** Its name on the login button: «Войти через <label>». */
  OIDC_KEYCLOAK_LABEL: z.string().min(1).default('Keycloak'),
  OIDC_KEYCLOAK_CLIENT_ID: z.string().optional(),
  OIDC_KEYCLOAK_CLIENT_SECRET: z.string().optional(),
  OIDC_KEYCLOAK_PUBLIC_URLS: z
    .string()
    .default('')
    .transform(s =>
      s
        .split(',')
        .map(x => x.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    )
    .pipe(z.array(z.url())),
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
  /** Web Push (change web-push-notifications): the VAPID pair and the contact (`mailto:` or `https:`); push is on only with all three. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  WEB_DIST_DIR: z.string().default(fileURLToPath(new URL('../../web/dist/', import.meta.url))),
  IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(30),
  PERMISSION_IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(120),
  EXTERNAL_WRITE_GUARD_MIN: z.coerce.number().int().nonnegative().default(10),
  ...s3Fields,
  /** GET /metrics needs `Authorization: Bearer <METRICS_TOKEN>`; unset — /metrics answers 404 (task 3.10). */
  METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
  /** The Postgres data volume as mounted into the hub (statfs for free space, D17). */
  DATA_VOLUME_PATH: z.string().default('/hostdata'),
  DISK_ALERT_FREE_PCT: z.coerce.number().min(1).max(99).default(15),
  /** How the warning names the host: «Agent Hub: на <label> свободно N% диска…». */
  ALERT_HOST_LABEL: z.string().default('hub'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
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
  /** Voice conversation (change voice-conversation, D10): the ElevenLabs agent whose Custom LLM is this hub. */
  VOICE_AGENT_ID: z.string().min(1).optional(),
  /** ElevenLabs key that issues the agent's signed URLs (ElevenAgents access); unset — ELEVENLABS_API_KEY. */
  VOICE_AGENT_API_KEY: z.string().optional(),
  /** Bearer key of the Custom LLM endpoint (the agent's secret) and the signing key of conversation tokens. */
  VOICE_LLM_KEY: z.string().min(32, 'VOICE_LLM_KEY must be at least 32 characters').optional(),
  /**
   * A voice turn longer than this is not spoken to the end: a phrase ends the stream, the turn goes on, ms. ElevenLabs
   * ends the whole conversation when a Custom LLM response runs past ~45 s (1002 «took too long»), heartbeat spaces do
   * not extend it — the default stays below that.
   */
  VOICE_TURN_MAX_MS: z.coerce.number().int().positive().default(35_000),
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

/** A login button of the single-provider mode: `/auth/login?hint=<id>` → `kc_idp_hint=<id>`. */
export interface IdpHint {
  id: string;
  label: string;
  /** Origins showing the button; empty — every public origin. */
  origins: string[];
}

export type Config = z.infer<typeof schema> & {
  /** OIDC_ISSUER is set: one provider, users `provider='oidc'` (keycloak-auth D5). */
  singleProvider: boolean;
  /** Parsed OIDC_IDP_HINTS. */
  idpHints: IdpHint[];
  /** «Управление входом»: OIDC_ACCOUNT_URL or `<issuer>/account` of a Keycloak realm; null — no link. */
  accountUrl: string | null;
  /** PUBLIC_URL first, then EXTRA_PUBLIC_URLS. */
  publicUrls: string[];
  /** Their origins, compared with the Origin header of mutating requests and WebSockets. */
  publicOrigins: string[];
  /** The second provider is configured (issuer, client id and secret): «Войти через <OIDC_KEYCLOAK_LABEL>» is offered. */
  keycloakEnabled: boolean;
  /** Origins offering Keycloak; empty means every public origin. */
  keycloakOrigins: string[];
  /** SUBSCRIPTION_TOKEN_KEY is set: tokens can be stored (claude-subscriptions P1). */
  subscriptionsEnabled: boolean;
  /** VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are all set: push can be sent (web-push-notifications D1). */
  pushEnabled: boolean;
  /** Some of the three are set, but push is off (a key or the contact is missing, or the contact is not mailto:/https:). */
  pushIncomplete: boolean;
  /** An ElevenLabs key, the agent and the bridge key are set: voice conversation is on (voice-conversation D10). */
  voiceTalkEnabled: boolean;
  /** Key of the signed-URL request: VOICE_AGENT_API_KEY, else ELEVENLABS_API_KEY. */
  voiceAgentApiKey: string | undefined;
};

const SINGLE_PROVIDER_REQUIRED = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const;
const LEGACY_REQUIRED = ['OIDC_GOOGLE_CLIENT_ID', 'OIDC_GOOGLE_CLIENT_SECRET'] as const;

/**
 * OIDC_IDP_HINTS: `hint:Label@url,url` items. An item starting with `id:` opens the next hint; an item without a colon is one
 * more address of the previous hint (`corp:Corp@https://a,https://b`).
 */
function parseIdpHints(raw: string, publicOrigins: string[]): IdpHint[] {
  const hints: IdpHint[] = [];
  for (const item of raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)) {
    const head = /^([A-Za-z0-9_.-]+):([^@]+?)(?:@(.+))?$/.exec(item);
    if (head && !/^https?:\/\//i.test(item)) {
      const [, id = '', label = '', url] = head;
      if (hints.some(h => h.id === id)) throw new Error(`OIDC_IDP_HINTS repeats the hint ${id}`);
      hints.push({ id, label: label.trim(), origins: url ? [hintOrigin(url)] : [] });
      continue;
    }
    const last = hints.at(-1);
    if (!last || last.origins.length === 0) throw new Error(`OIDC_IDP_HINTS: expected hint:Label[@url], got ${item}`);
    last.origins.push(hintOrigin(item));
  }
  for (const origin of hints.flatMap(h => h.origins)) {
    if (!publicOrigins.includes(origin)) throw new Error(`OIDC_IDP_HINTS contains an unknown public origin: ${origin}`);
  }
  return hints;
}

function hintOrigin(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    throw new Error(`OIDC_IDP_HINTS contains an invalid address: ${url}`);
  }
}

/** Both modes at once (keycloak-auth D5): the old `.env` with OIDC_ISSUER=Google must not start as single-provider. */
function checkProviderMode(given: Record<string, string | undefined>): void {
  if (given.OIDC_ISSUER === undefined) {
    for (const name of SINGLE_PROVIDER_REQUIRED) {
      if (given[name] !== undefined) throw new Error(`${name} needs OIDC_ISSUER`);
    }
    const missing = LEGACY_REQUIRED.filter(name => given[name] === undefined);
    if (missing.length > 0) throw new Error(`Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or ${missing.join(' and ')}`);
    return;
  }
  const legacy = Object.keys(given).filter(k => k.startsWith('OIDC_GOOGLE_') || k.startsWith('OIDC_KEYCLOAK_'));
  if (legacy.length > 0) throw new Error(`OIDC_ISSUER cannot be combined with ${legacy.sort().join(', ')}: remove one of the modes`);
  const missing = SINGLE_PROVIDER_REQUIRED.filter(name => given[name] === undefined);
  if (missing.length > 0) throw new Error(`OIDC_ISSUER needs ${missing.join(' and ')}`);
}

/**
 * Names a PaaS may give the hub (change paas-deployment, D1): each fills the hub's own name when that
 * one is not set. `OIDC_*` cannot be a platform secret, hence HUB_ADMIN_EMAILS.
 */
const PLATFORM_ALIASES = [
  ['S3_BUCKET', 'S3_BUCKET_DATA'],
  ['S3_REGION', 'AWS_REGION'],
  ['HUB_ADMIN_EMAILS', 'OIDC_ALLOWED_EMAILS'],
] as const;

/** The environment with empty values dropped (`METRICS_TOKEN=` from .env.example means «not set») and platform aliases applied. */
export function hubEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  for (const [alias, name] of PLATFORM_ALIASES) {
    if (given[name] === undefined && given[alias] !== undefined) given[name] = given[alias];
  }
  return given;
}

/** Static keys come as a pair: one without the other would silently fall back to the AWS SDK default chain. */
function checkS3Keys(c: { S3_ACCESS_KEY_ID?: string | undefined; S3_SECRET_ACCESS_KEY?: string | undefined }): void {
  if ((c.S3_ACCESS_KEY_ID === undefined) !== (c.S3_SECRET_ACCESS_KEY === undefined)) {
    throw new Error('Invalid hub configuration: set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY or neither');
  }
}

/** S3 settings for the hub CLI: the same names, aliases and validation as loadConfig, without the rest of the hub config. */
export function loadS3Settings(env: NodeJS.ProcessEnv): z.infer<typeof s3Schema> {
  const parsed = s3Schema.safeParse(hubEnv(env));
  if (!parsed.success) {
    throw new Error(`Invalid hub configuration:
${z.prettifyError(parsed.error)}`);
  }
  checkS3Keys(parsed.data);
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const given = hubEnv(env);
  if (given.OIDC_ALLOWED_EMAILS === undefined) {
    throw new Error('Invalid hub configuration: set OIDC_ALLOWED_EMAILS or HUB_ADMIN_EMAILS (the bootstrap administrators)');
  }
  checkProviderMode(given);
  const parsed = schema.safeParse(given);
  if (!parsed.success) {
    throw new Error(`Invalid hub configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  checkS3Keys(c);
  const url = new URL(c.PUBLIC_URL);
  // Requirement: Вход через Google OIDC — the dev login bypass exists only for e2e tests.
  if (c.AUTH_DEV_EMAIL && c.NODE_ENV !== 'test') {
    throw new Error('AUTH_DEV_EMAIL is allowed only with NODE_ENV=test');
  }
  const publicOrigins = [url.origin, ...c.EXTRA_PUBLIC_URLS.map(u => new URL(u).origin)];
  const keycloakOrigins = c.OIDC_KEYCLOAK_PUBLIC_URLS.map(u => new URL(u).origin);
  for (const origin of keycloakOrigins) {
    if (!publicOrigins.includes(origin)) {
      throw new Error(`OIDC_KEYCLOAK_PUBLIC_URLS contains an unknown public origin: ${origin}`);
    }
  }
  const singleProvider = c.OIDC_ISSUER !== undefined;
  if (!singleProvider && c.OIDC_IDP_HINTS !== '') throw new Error('OIDC_IDP_HINTS needs OIDC_ISSUER');
  const idpHints = parseIdpHints(c.OIDC_IDP_HINTS, publicOrigins);
  const issuer = c.OIDC_ISSUER?.replace(/\/+$/, '');
  const accountUrl = c.OIDC_ACCOUNT_URL ?? (issuer && issuer.includes('/realms/') ? `${issuer}/account` : null);
  const vapidGiven = [c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY, c.VAPID_SUBJECT].filter(Boolean).length;
  const pushEnabled = Boolean(c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY && c.VAPID_SUBJECT && /^(mailto:|https:)/.test(c.VAPID_SUBJECT));
  return {
    ...c,
    singleProvider,
    idpHints,
    accountUrl,
    publicUrls: [c.PUBLIC_URL, ...c.EXTRA_PUBLIC_URLS],
    publicOrigins,
    keycloakOrigins,
    keycloakEnabled: Boolean(c.OIDC_KEYCLOAK_ISSUER && c.OIDC_KEYCLOAK_CLIENT_ID && c.OIDC_KEYCLOAK_CLIENT_SECRET),
    subscriptionsEnabled: c.SUBSCRIPTION_TOKEN_KEY !== undefined,
    pushEnabled,
    pushIncomplete: vapidGiven > 0 && !pushEnabled,
    voiceTalkEnabled: Boolean((c.VOICE_AGENT_API_KEY || c.ELEVENLABS_API_KEY) && c.VOICE_AGENT_ID && c.VOICE_LLM_KEY),
    voiceAgentApiKey: c.VOICE_AGENT_API_KEY || c.ELEVENLABS_API_KEY,
  };
}
