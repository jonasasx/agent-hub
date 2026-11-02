// Bundles the main process into dist/main.cjs (design D1). Everything except `electron` is bundled, so the packaged
// app carries no node_modules. ws' optional native addons are left out (ws falls back to JS).
// AGENTHUB_DEFAULT_URL (optional) — the hub a fresh install opens, baked into the bundle.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
  define: { 'process.env.AGENTHUB_DEFAULT_URL': JSON.stringify(process.env.AGENTHUB_DEFAULT_URL ?? '') },
});
