// Publishes the desktop build as the GitHub release desktop-v<version> (change desktop-download, D6): latest.yml, the
// installer and its blockmap. The hub image downloads these three files at build time (scripts/fetch-desktop-release.mjs).
// An existing release is an error: published assets are never replaced.
//
// Run from the repository root after `npm run dist -w desktop`:
//   GITHUB_TOKEN=<token with contents:write> [GITHUB_REPO=owner/name] node desktop/scripts/publish-release.mjs
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPO || 'jonasasx/agent-hub';
if (!token) throw new Error('GITHUB_TOKEN is not set');

const { version } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const release = join(desktop, 'release');
const installer = `Agent-Hub-Setup-${version}.exe`;
// latest.yml last: a failed upload leaves no feed that names a missing installer.
const files = [installer, `${installer}.blockmap`, 'latest.yml'];
for (const f of files) {
  await stat(join(release, f)).catch(() => {
    throw new Error(`No ${f} in ${release}: run npm run dist -w desktop first`);
  });
}
const latest = await readFile(join(release, 'latest.yml'), 'utf8');
const feedVersion = /^version:\s*(\S+)/m.exec(latest)?.[1];
if (feedVersion !== version) throw new Error(`latest.yml describes ${feedVersion}, package.json ${version}`);

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function github(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}

const tag = `desktop-v${version}`;
const existing = await fetch(`${API}/repos/${repo}/releases/tags/${tag}`, { headers });
if (existing.ok) throw new Error(`Release ${tag} already exists in ${repo}: bump the desktop version`);
if (existing.status !== 404) throw new Error(`GET release ${tag} -> ${existing.status}`);

const created = await github(`${API}/repos/${repo}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: tag, name: `Agent Hub desktop ${version}`, body: `Windows installer of Agent Hub desktop ${version}.` }),
});
console.log(`Created release ${tag}: ${created.html_url}`);

for (const f of files) {
  const data = await readFile(join(release, f));
  const url = `${UPLOADS}/repos/${repo}/releases/${created.id}/assets?name=${encodeURIComponent(f)}`;
  const asset = await github(url, { method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' } });
  console.log(`Uploaded ${asset.name} (${asset.size} bytes)`);
}
