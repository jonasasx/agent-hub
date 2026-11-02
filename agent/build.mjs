// Bundles the agent into dist/agent.mjs. The Agent SDK stays external: it ships a native Claude Code
// binary per platform, installed next to the bundle by the installer (`npm install --omit=dev` in the app dir).
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const out = new URL('./dist/', import.meta.url);
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'warning',
};
await build({
  ...common,
  entryPoints: [fileURLToPath(new URL('./src/supervisor.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/supervisor.mjs', import.meta.url)),
});
// `agent-hub` command (login, enroll, restart): no SDK, runs from the app dir next to supervisor.mjs.
await build({
  ...common,
  entryPoints: [fileURLToPath(new URL('./src/cliMain.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/cli.mjs', import.meta.url)),
});
await build({
  entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/agent.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // ws loads its optional native helpers in try/catch; they are not installed.
  external: ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

// Runtime manifest for the installed app: the SDK and the Codex CLI (agent-providers D5) are installed from npm.
const sdk = pkg.dependencies['@anthropic-ai/claude-agent-sdk'];
const codex = pkg.dependencies['@openai/codex'];
await writeFile(
  new URL('./dist/package.json', import.meta.url),
  JSON.stringify({ name: 'agent-hub-agent', version: pkg.version, private: true, type: 'module', dependencies: { '@anthropic-ai/claude-agent-sdk': sdk, '@openai/codex': codex } }, null, 2) + '\n',
);
await copyFile(new URL('./scripts/s4u-check.mjs', import.meta.url), new URL('./dist/s4u-check.mjs', import.meta.url));
console.log(`agent ${pkg.version} bundled to dist/agent.mjs`);
