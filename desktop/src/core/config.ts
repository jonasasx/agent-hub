/**
 * App settings `%APPDATA%\Agent Hub\config.json` (design D17). Pure: the file text and the environment come in,
 * the effective settings go out. No secrets here — the session lives only in the Chromium cookie store.
 */
import { HOTKEY_DEFAULT } from './hotkey.js';

/* Requirement: Адрес хаба по умолчанию */
/** The hub of a fresh install: AGENTHUB_DEFAULT_URL at build time (scripts/build.mjs), else a placeholder. */
export const DEFAULT_HUB_URL = validateHubUrl(process.env.AGENTHUB_DEFAULT_URL) ?? 'https://hub.example.com';

export interface AppConfig {
  /** Origin of the hub, no trailing slash. */
  hubUrl: string;
  /** Electron accelerator; null — disabled. */
  hotkey: string | null;
  autostart: boolean;
}

/** What is stored in the file (the effective `hubUrl` may come from `AGENTHUB_URL` and is not written back). */
export interface StoredConfig {
  hubUrl: string;
  hotkey: string | null;
  autostart: boolean;
}

export const DEFAULT_CONFIG: StoredConfig = { hubUrl: DEFAULT_HUB_URL, hotkey: HOTKEY_DEFAULT, autostart: true };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * `https:` anywhere, `http:` only for localhost/127.0.0.1; path, query and credentials are not allowed.
 * Returns the origin (no trailing slash) or null.
 */
export function validateHubUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return u.origin;
  return null;
}

/** Parses the file text (null — no file). A broken file or field gives the default of that field. */
export function parseStoredConfig(text: string | null): StoredConfig {
  if (text === null) return { ...DEFAULT_CONFIG };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  const o = raw as Record<string, unknown>;
  const hubUrl = validateHubUrl(o.hubUrl) ?? DEFAULT_CONFIG.hubUrl;
  const hotkey = o.hotkey === null ? null : typeof o.hotkey === 'string' && o.hotkey.trim() ? o.hotkey.trim() : DEFAULT_CONFIG.hotkey;
  const autostart = typeof o.autostart === 'boolean' ? o.autostart : DEFAULT_CONFIG.autostart;
  return { hubUrl, hotkey, autostart };
}

/** Reads the file; `changed` — reserved for migrations of the stored settings (none now), the caller writes it back. */
export function loadStoredConfig(text: string | null): { stored: StoredConfig; changed: boolean } {
  return { stored: parseStoredConfig(text), changed: false };
}

/** Effective settings: `AGENTHUB_URL` overrides `hubUrl` when it is valid. */
export function effectiveConfig(stored: StoredConfig, env: Record<string, string | undefined>): AppConfig {
  const override = env.AGENTHUB_URL ? validateHubUrl(env.AGENTHUB_URL) : null;
  return { hubUrl: override ?? stored.hubUrl, hotkey: stored.hotkey, autostart: stored.autostart };
}

export function serializeConfig(c: StoredConfig): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}
