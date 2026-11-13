// Downloads the desktop update feed of the release desktop-v<version> into <dir> at image build time (change
// desktop-download, D6). A missing release or no network fails the build: an empty feed would stay in the layer cache
// until the next desktop version. With DESKTOP_FEED_OPTIONAL=1 it leaves <dir> without the feed and only warns — the hub
// then shows no download button.
//   [DESKTOP_FEED_OPTIONAL=1] node scripts/fetch-desktop-release.mjs <repo owner/name> <dir>
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
  const reason = err instanceof Error ? err.message : err;
  if (process.env.DESKTOP_FEED_OPTIONAL === '1') {
    console.warn(`WARNING: desktop feed desktop-v${version} not fetched, the hub has no download button: ${reason}`);
  } else {
    console.error(`desktop feed desktop-v${version} not fetched: ${reason}`);
    console.error('Publish the release (desktop/scripts/publish-release.mjs) or build with --build-arg DESKTOP_FEED_OPTIONAL=1.');
    process.exitCode = 1;
  }
}
