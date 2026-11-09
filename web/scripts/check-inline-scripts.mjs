// change voice-conversation: the hub's CSP (script-src 'self') refuses scripts from data: URLs, so a worklet or worker
// that Vite inlined as data:text/javascript breaks in production while tests pass. Runs after `vite build`; a failure
// fails the build (and the hub image). Fix: import the file with `?url&no-inline`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('../dist/assets/', import.meta.url));
const bad = readdirSync(dir).filter(f => /\.m?js$/.test(f) && readFileSync(join(dir, f), 'utf8').includes('data:text/javascript'));
if (bad.length) {
  console.error(`check-inline-scripts: data:text/javascript in ${bad.join(', ')} — import the script with ?url&no-inline`);
  process.exit(1);
}
console.log('check-inline-scripts: no scripts inlined as data: URLs');
