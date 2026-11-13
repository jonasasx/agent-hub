/**
 * `config.json` (D17): created with defaults on the first run, saved on every change from the tray menu and when a
 * migration changed it on start.
 */
import { DEFAULT_CONFIG, effectiveConfig, loadStoredConfig, serializeConfig, type AppConfig, type StoredConfig } from '../core/config.js';
import { readText, userFile, writeText } from './files.js';

export class ConfigStore {
  private stored: StoredConfig;
  readonly firstRun: boolean;

  constructor() {
    const path = userFile('config.json');
    const text = readText(path);
    this.firstRun = text === null;
    const { stored, changed } = loadStoredConfig(text);
    this.stored = stored;
    if (this.firstRun || changed) writeText(path, serializeConfig({ ...DEFAULT_CONFIG, ...this.stored }));
  }

  get effective(): AppConfig {
    return effectiveConfig(this.stored, process.env);
  }

  /** The address in the file, without the `AGENTHUB_URL` override. */
  get storedHubUrl(): string {
    return this.stored.hubUrl;
  }

  /** The hub of the installer (change desktop-download, D4); the caller validated the origin. */
  setHubUrl(hubUrl: string): void {
    this.stored = { ...this.stored, hubUrl };
    writeText(userFile('config.json'), serializeConfig(this.stored));
  }

  update(patch: Partial<Omit<StoredConfig, 'hubUrl'>>): void {
    this.stored = { ...this.stored, ...patch };
    writeText(userFile('config.json'), serializeConfig(this.stored));
  }
}
