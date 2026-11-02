// A9 of the review: one source of the Electron version — the exact `electron` pin in package.json; the
// `electronVersion` electron-builder packages with must be equal to it (and to what is installed).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> };
const yml = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');

describe('Electron version', () => {
  it('is pinned exactly and electron-builder.yml packages the same version', () => {
    const pinned = pkg.devDependencies.electron;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(/^electronVersion:\s*(\S+)\s*$/m.exec(yml)?.[1]).toBe(pinned);
  });
  it('the installed electron is the pinned one', () => {
    const require = createRequire(import.meta.url);
    const installed = (require('electron/package.json') as { version: string }).version;
    expect(installed).toBe(pkg.devDependencies.electron);
  });
});
