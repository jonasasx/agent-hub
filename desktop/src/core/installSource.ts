/**
 * The hub the installer was downloaded from (change desktop-download, D1–D3). The hub names the installer
 * `Agent-Hub-Setup-<version> [<host>[_<port>]].exe`; a browser that renamed the file still leaves the address of the
 * download in the `Zone.Identifier` stream (`HostUrl=`). Pure: the main process reads the files.
 */
import { validateHubUrl } from './config.js';

/** `[host]` or `[host_port]` before `.exe`; a browser may add ` (1)` for a second download of the same name. */
const TAG = /\[([A-Za-z0-9.-]+)(?:_(\d{1,5}))?\](?: \(\d+\))?\.exe$/i;

const DOWNLOAD_PATH = '/api/desktop/download';

function fromTag(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const m = TAG.exec(base);
  const host = m?.[1]?.toLowerCase();
  if (!m || !host) return null;
  return validateHubUrl(m[2] ? `https://${host}:${m[2]}` : `https://${host}`);
}

function fromZone(zoneText: string | null): string | null {
  if (!zoneText) return null;
  const line = /^HostUrl=(.+)$/m.exec(zoneText.replace(/^\uFEFF/, ''));
  if (!line?.[1]) return null;
  let u: URL;
  try {
    u = new URL(line[1].trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.pathname !== DOWNLOAD_PATH) return null;
  return validateHubUrl(u.origin);
}

/** The hub address from the installer path and its `Zone.Identifier` text; null — unknown. The tag wins. */
export function hubFromInstaller(fileName: string, zoneText: string | null): string | null {
  return fromTag(fileName) ?? fromZone(zoneText);
}

export type InstallDecision = 'none' | 'apply' | 'ask';

/**
 * D4: a fresh install or the placeholder address takes the hub of the installer silently; another hub already set
 * asks the user first.
 */
export function installDecision(source: string | null, stored: string, firstRun: boolean, placeholder: string): InstallDecision {
  if (!source || source === stored) return 'none';
  if (firstRun || stored === placeholder) return 'apply';
  return 'ask';
}
