// Test-only: the legacy catalogue of the fixture vault (INDEX.md, 40-automation/repos.txt), written into `projects` as
// the hub used to build it from VAULT_DIR before change catalog-db-session-context. The hub itself reads no such files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allocateProjectColor, stripRemoteUserinfo, type ColorKey } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { normalizeRemote, type ItemKind } from '../projects/catalog.js';

export interface CatalogItem {
  kind: ItemKind;
  /** Identity of the element (projects.path): vault-relative, '/' separators; built-ins: `builtin:vault`, `30-knowledge`. */
  path: string;
  areaPath: string | null;
  slug: string;
  title: string;
  summary: string;
  archived: boolean;
  colorKey: ColorKey;
  /** Normalised remotes (host/group/repo) of the element and its bound clones. */
  gitRemotes: string[];
  /** More vault prefixes that belong to the element: bound clones, the files of «Vault». */
  clonePaths: string[];
  origin: 'index' | 'repos' | 'builtin';
}

export const VAULT_BUILTIN = 'builtin:vault';
export const KNOWLEDGE_BUILTIN = '30-knowledge';
/** Files of the vault itself (D9 p. 4): edits count, reads do not. */
export const VAULT_PATHS = ['00-meta', '40-automation', '.claude', 'CLAUDE.md', 'INDEX.md'];

/** Colours of the areas in the order of INDEX.md; the areas after them and elements without an area — 'personal'. */
const AREA_PALETTE: ColorKey[] = ['scanner', 'platform', 'customers', 'support', 'infra', 'tools', 'org', 'ext'];
export const NO_AREA_COLOR: ColorKey = 'personal';

/** `s` as a whole name in a text: not followed by more of a name (`repos/sd` does not match `repos/sd2`). */
function wholeName(s: string): RegExp {
  return new RegExp(`${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, 'i');
}

const slugName = (slug: string) => slug.replace(/^\d+-/, '');

/** INDEX.md → areas, systems, projects (archived ones under «Архив проектов»). */
export function parseIndex(text: string): CatalogItem[] {
  const out: CatalogItem[] = [];
  let area: string | null = null;
  let color = NO_AREA_COLOR;
  let mode: 'system' | 'project' | 'archive' | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^##\s+(.+?)\s+\(`([^`]+)`\)\s*$/.exec(line);
    if (h) {
      area = h[2]!.replace(/\/+$/, '');
      color = AREA_PALETTE[out.filter(i => i.kind === 'area').length] ?? NO_AREA_COLOR;
      mode = null;
      out.push({
        kind: 'area',
        path: area,
        areaPath: area,
        slug: area.split('/').pop()!,
        title: h[1]!,
        summary: '',
        archived: false,
        colorKey: color,
        gitRemotes: [],
        clonePaths: [],
        origin: 'index',
      });
      continue;
    }
    if (/^\*\*Системы\*\*$/.test(line)) mode = 'system';
    else if (/^\*\*Проекты\*\*$/.test(line)) mode = 'project';
    else if (/^\*\*Архив проектов\*\*$/.test(line)) mode = 'archive';
    const m = /^- \[`([^`]+)`\]\(([^)]+?)\/?\)\s+—\s+(.*)$/.exec(line);
    if (!m || !area || !mode) continue;
    // Only `<area>/…` without `..`: a link elsewhere is not an element of the area.
    const itemPath = m[2]!.replace(/\/+$/, '');
    if (!itemPath.startsWith(`${area}/`) || itemPath.split('/').some(x => x === '..' || x === '.' || x === '')) continue;
    const summary = m[3]!.replace(/\s+·\s+\[карточка\]\([^)]*\)\s*$/, '');
    out.push({
      kind: mode === 'system' ? 'system' : 'project',
      path: itemPath,
      areaPath: area,
      slug: m[1]!,
      title: m[1]!,
      summary,
      archived: mode === 'archive',
      colorKey: color,
      gitRemotes: [],
      clonePaths: [],
      origin: 'index',
    });
  }
  return out;
}

/** repos.txt → clones bound to their system/project (remote and path added to it) or own `repo` elements. */
export function bindClones(items: CatalogItem[], reposText: string): CatalogItem[] {
  const areas = items.filter(i => i.kind === 'area').sort((a, b) => b.path.length - a.path.length);
  const out: CatalogItem[] = [];
  for (const raw of reposText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [path, url] = line.split(/\s+/);
    if (!path || !url) continue;
    const clonePath = path.replace(/\/+$/, '');
    const name = clonePath.split('/').pop()!;
    const remote = normalizeRemote(url);
    const repoPath = remote ? remote.split('/').slice(1).join('/') : '';
    const area = areas.find(a => clonePath.startsWith(`${a.path}/`));
    const siblings = items.filter(i => (i.kind === 'system' || i.kind === 'project') && area && i.areaPath === area.path);
    // Whole names only: `repos/sd` is not `repos/sd2`.
    const byClone = wholeName(`repos/${name}`);
    const byRemote = repoPath ? wholeName(repoPath) : null;
    const bySummary = siblings.find(i => byClone.test(i.summary) || (byRemote?.test(i.summary) ?? false));
    const target = bySummary ?? siblings.find(i => slugName(i.slug) === name);
    if (target) {
      if (remote && !target.gitRemotes.includes(remote)) target.gitRemotes.push(remote);
      target.clonePaths.push(clonePath);
      continue;
    }
    out.push({
      kind: 'repo',
      path: clonePath,
      areaPath: area?.path ?? null,
      slug: name,
      title: name,
      summary: stripRemoteUserinfo(url),
      archived: false,
      colorKey: area?.colorKey ?? NO_AREA_COLOR,
      gitRemotes: remote ? [remote] : [],
      clonePaths: [],
      origin: 'repos',
    });
  }
  return out;
}

export function builtins(): CatalogItem[] {
  return [
    {
      kind: 'builtin',
      path: VAULT_BUILTIN,
      areaPath: null,
      slug: 'vault',
      title: 'Vault',
      summary: 'Служебные файлы vault',
      archived: false,
      colorKey: 'personal',
      gitRemotes: [],
      clonePaths: [...VAULT_PATHS],
      origin: 'builtin',
    },
    {
      kind: 'builtin',
      path: KNOWLEDGE_BUILTIN,
      areaPath: null,
      slug: 'knowledge',
      title: 'Знания',
      summary: 'Гайды, справочники, плейбуки',
      archived: false,
      colorKey: 'personal',
      gitRemotes: [],
      clonePaths: [],
      origin: 'builtin',
    },
  ];
}

/** The elements of a vault's INDEX.md and repos.txt plus «Vault» and «Знания». */
export function fixtureCatalog(vaultDir: string): CatalogItem[] {
  const items = parseIndex(readFileSync(join(vaultDir, 'INDEX.md'), 'utf8'));
  const repos = bindClones(items, readFileSync(join(vaultDir, '40-automation', 'repos.txt'), 'utf8'));
  return [...items, ...repos, ...builtins()];
}

/** Writes the elements into `projects` of the user (upsert by path). */
export async function seedLegacyProjects(db: Db, userId: string, items: CatalogItem[]): Promise<void> {
  const used: string[] = [];
  for (const item of items) {
    const color = allocateProjectColor(used, item.path);
    used.push(color);
    const values = {
      kind: item.kind,
      area_path: item.areaPath,
      slug: item.slug,
      title: item.title,
      summary: item.summary,
      archived: item.archived,
      color_key: item.kind === 'builtin' ? item.colorKey : color,
      git_remotes: item.gitRemotes,
      clone_paths: item.clonePaths,
      origin: item.origin,
    };
    await db
      .insertInto('projects')
      .values({ user_id: userId, path: item.path, ...values })
      .onConflict(oc => oc.columns(['user_id', 'path']).doUpdateSet(values))
      .execute();
  }
}

/** Seeds the fixture vault's catalogue for every user of the database and reloads the hub's catalogue. */
export async function seedFixtureVault(db: Db, catalog: { load(): Promise<void> }, vaultDir: string): Promise<void> {
  const items = fixtureCatalog(vaultDir);
  const users = await db.selectFrom('users').select('id').execute();
  for (const u of users) await seedLegacyProjects(db, u.id, items);
  await catalog.load();
}
