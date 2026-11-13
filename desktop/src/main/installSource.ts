/**
 * The hub of the installer (change desktop-download, D3, D4). The NSIS hook writes the installer path to
 * `installer-source.txt` (UTF-16LE); the first start after an install reads it once, deletes it and binds the app to
 * the hub the installer came from: silently on a fresh install, after a question when another hub is already set.
 */
import { readFileSync, rmSync } from 'node:fs';
import { dialog } from 'electron';
import { DEFAULT_HUB_URL } from '../core/config.js';
import { dt } from '../core/i18n.js';
import { hubFromInstaller, installDecision } from '../core/installSource.js';
import type { ConfigStore } from './configStore.js';
import { log, userFile } from './files.js';

function readInstallerPath(path: string): string | null {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString('utf16le') : raw.toString('utf8');
  return text.trim() || null;
}

function readZone(installer: string): string | null {
  try {
    return readFileSync(`${installer}:Zone.Identifier`, 'utf8');
  } catch {
    return null;
  }
}

/** Runs before the windows open; returns true when the hub address changed. */
export function applyInstallSource(config: ConfigStore): boolean {
  const installer = readInstallerPath(userFile('installer-source.txt'));
  if (!installer) return false;
  const source = hubFromInstaller(installer, readZone(installer));
  const stored = config.storedHubUrl;
  const decision = installDecision(source, stored, config.firstRun, DEFAULT_HUB_URL);
  log(`installer source ${source ?? 'unknown'} decision=${decision}`);
  if (!source || decision === 'none') return false;
  if (decision === 'ask') {
    const answer = dialog.showMessageBoxSync({
      type: 'question',
      title: 'Agent Hub',
      message: dt('desktop.installSource.message', { hub: source }),
      detail: dt('desktop.installSource.detail', { current: stored }),
      buttons: [dt('desktop.installSource.connect'), dt('desktop.installSource.keep')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer !== 0) return false;
  }
  config.setHubUrl(source);
  return true;
}
