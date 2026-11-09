// change client-versions D2: the generated SW must skip waiting and claim clients by itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SW_LIFECYCLE } from './swLifecycle';

describe('service worker lifecycle', () => {
  it('skipWaiting and clientsClaim are on', () => {
    expect(SW_LIFECYCLE).toEqual({ skipWaiting: true, clientsClaim: true });
  });

  it('vite.config.ts spreads them into the workbox options', () => {
    const cfg = readFileSync(join(import.meta.dirname, '../vite.config.ts'), 'utf8');
    const workbox = cfg.slice(cfg.indexOf('workbox: {'));
    expect(cfg.indexOf('workbox: {')).toBeGreaterThan(0);
    expect(workbox.slice(0, workbox.indexOf('runtimeCaching'))).toContain('...SW_LIFECYCLE');
  });

  it('the web build checks the generated sw.js', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { scripts: { build: string } };
    expect(pkg.scripts.build).toMatch(/vite build && node scripts\/check-sw\.mjs( &&|$)/);
  });

  it('the web build refuses scripts inlined as data: URLs (voice-conversation: CSP blocks the worklets)', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { scripts: { build: string } };
    expect(pkg.scripts.build).toMatch(/vite build && .*node scripts\/check-inline-scripts\.mjs/);
  });
});
