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

  update(patch: Partial<Omit<StoredConfig, 'hubUrl'>>): void {
    this.stored = { ...this.stored, ...patch };
    writeText(userFile('config.json'), serializeConfig(this.stored));
  }
}
