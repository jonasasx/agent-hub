// Downloads the desktop update feed of the release desktop-v<version> into <dir> at image build time (change
// desktop-download, D6). Soft: a missing release or no network leaves <dir> without the feed and only warns — the hub
// then shows no download button.
//   node scripts/fetch-desktop-release.mjs <repo owner/name> <dir>
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [repo, dir] = process.argv.slice(2);
if (!repo || !dir) {
  console.error('usage: fetch-desktop-release.mjs <owner/name> <dir>');
  process.exit(2);
}

const pkgPath = fileURLToPath(new URL('../desktop/package.json', import.meta.url));
const { version } = JSON.parse(await readFile(pkgPath, 'utf8'));
const installer = `Agent-Hub-Setup-${version}.exe`;
// latest.yml last: the hub reads the feed only when latest.yml names an installer that is present.
const files = [installer, `${installer}.blockmap`, 'latest.yml'];
const base = `https://github.com/${repo}/releases/download/desktop-v${version}`;

await mkdir(dir, { recursive: true });
try {
  for (const f of files) {
    const res = await fetch(`${base}/${f}`, { signal: AbortSignal.timeout(1_200_000) });
    if (!res.ok) throw new Error(`${base}/${f} -> ${res.status}`);
    await writeFile(join(dir, f), Buffer.from(await res.arrayBuffer()));
    console.log(`desktop feed: ${f}`);
  }
} catch (err) {
  for (const f of files) await rm(join(dir, f), { force: true });
  console.warn(`WARNING: desktop feed ${version} not fetched, the hub has no download button: ${err instanceof Error ? err.message : err}`);
}
