// B3 of QA: the installer is one-click per-user (no install-mode page), and the update installs silently.
// QA-2: the one-click per-user install directory is %LOCALAPPDATA%\Programs\Agent Hub, not …\@agent-hubdesktop.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const lines = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8').split(/\r?\n/);
const updater = readFileSync(new URL('../main/updater.ts', import.meta.url), 'utf8');

/** Lines of a top-level YAML section (comments dropped). */
function section(name: string): string[] {
  const start = lines.indexOf(`${name}:`);
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.length > 0 && !l.startsWith(' ') && !l.startsWith('#'));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter(l => !l.trimStart().startsWith('#'));
}

function topLevel(key: string): string | undefined {
  return lines
    .find(l => l.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim();
}

describe('NSIS installer and update mode', () => {
  const nsis = section('nsis');
  it('one-click, per-user, no elevation, no installation directory choice', () => {
    expect(nsis.length).toBeGreaterThan(0);
    expect(nsis).toContain('  oneClick: true');
    expect(nsis).toContain('  perMachine: false');
    expect(nsis).toContain('  allowElevation: false');
    expect(nsis.some(l => l.includes('allowToChangeInstallationDirectory'))).toBe(false);
  });
  it('the update is installed silently and the app is started again', () => {
    expect(updater).toMatch(/quitAndInstall\(true, true\)/);
  });
});

describe('install directory (QA-2)', () => {
  // electron-builder's own rule: APP_FILENAME = getWindowsInstallationDirName(appInfo, !oneClick || perMachine);
  // for one-click per-user it is appInfo.sanitizedName = sanitizeFileName(<package name after extraMetadata>).
  const require = createRequire(import.meta.url);
  const { getWindowsInstallationDirName } = require('app-builder-lib/out/targets/targetUtil.js') as {
    getWindowsInstallationDirName(appInfo: { productFilename: string; sanitizedName: string }, tryProductName: boolean): string;
  };
  const { sanitizeFileName } = require('builder-util/out/filename') as { sanitizeFileName(s: string): string };

  it('extraMetadata.name is «Agent Hub», so the one-click per-user directory is …\\Programs\\Agent Hub', () => {
    const name = section('extraMetadata')
      .find(l => l.startsWith('  name:'))
      ?.slice('  name:'.length)
      .trim();
    expect(name).toBe('Agent Hub');
    expect(getWindowsInstallationDirName({ productFilename: 'Agent Hub', sanitizedName: sanitizeFileName(name!) }, false)).toBe('Agent Hub');
    // Without it the directory came from the npm name.
    expect(sanitizeFileName('@agent-hub/desktop')).toBe('@agent-hubdesktop');
  });
  it('appId (uninstall key and InstallLocation key) and productName (userData) stay the same', () => {
    expect(topLevel('appId')).toBe('io.github.jonasasx.agenthub');
    expect(topLevel('productName')).toBe('Agent Hub');
  });
});

// Requirement: Адрес хаба по умолчанию и перенос со старого адреса — the feed baked into the package (app-update.yml).
describe('update feed of the package', () => {
  it('points at the public hub address', () => {
    expect(section('publish')).toContain('    url: https://hub.example.com/api/desktop/updates/');
  });
});

// Requirement: Адрес хаба по умолчанию и перенос со старого адреса — the feed baked into the installer is the public hub.
describe('update feed', () => {
  it('publish url is the public hub address', () => {
    expect(section('publish')).toContain('    url: https://hub.example.com/api/desktop/updates/');
  });
});
