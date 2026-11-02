// change client-versions D2: the built SW must activate itself (skipWaiting on install, not only on a SKIP_WAITING
// message) and claim the open pages. Runs after `vite build`; a failure fails the build (and the hub image).
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? new URL('../dist/sw.js', import.meta.url);
const src = readFileSync(path, 'utf8');
const all = src.match(/skipWaiting\(\)/g)?.length ?? 0;
const onMessage = src.match(/SKIP_WAITING[^;]{0,80}?skipWaiting\(\)/g)?.length ?? 0;
const errors = [];
if (all - onMessage < 1) errors.push('no unconditional skipWaiting()');
if (!/clientsClaim\(\)/.test(src)) errors.push('no clientsClaim()');
if (errors.length) {
  console.error(`check-sw: ${path}: ${errors.join(', ')} — set workbox skipWaiting/clientsClaim (web/src/swLifecycle.ts)`);
  process.exit(1);
}
console.log('check-sw: sw.js has skipWaiting() and clientsClaim()');
