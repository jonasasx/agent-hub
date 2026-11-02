// The project catalogue (design D9 p. 1–4, task 4.3): areas, systems and projects of the vault's INDEX.md, code clones
// of 40-automation/repos.txt (bound to the system/project they belong to, or own elements), the built-in «Vault» and
// «Знания», and the translation of paths of the vault structure before 2026-10-04 (mapping.csv). Pure functions:
// the DB sync and the reload by mtime are in catalogService.ts.
// Requirement (project-grouping): Справочник проектов.
import { stripRemoteUserinfo, type ColorKey } from '@agent-hub/shared';

export type ItemKind = 'area' | 'system' | 'project' | 'repo' | 'builtin';

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

export interface Catalog {
  items: CatalogItem[];
  /**
   * Old path → new path (exact files) and old prefix → new prefix (depth 3 and 2, ≥60% to one element); `current` —
   * the first directories of the new structure (the new paths of mapping.csv): a path starting otherwise may be an old one.
   */
  legacy: { exact: Map<string, string>; prefixes: Map<string, string>; current: Set<string> };
}

export const VAULT_BUILTIN = 'builtin:vault';
export const KNOWLEDGE_BUILTIN = '30-knowledge';
/** Files of the vault itself (D9 p. 4): edits count, reads do not. */
export const VAULT_PATHS = ['00-meta', '40-automation', '.claude', 'CLAUDE.md', 'INDEX.md'];

/** Colours of the areas in the order of INDEX.md; the areas after them and elements without an area — 'personal'. */
const AREA_PALETTE: ColorKey[] = ['scanner', 'platform', 'customers', 'support', 'infra', 'tools', 'org', 'ext'];
export const NO_AREA_COLOR: ColorKey = 'personal';

/**
 * A git remote as `host/group/repo`: no scheme, no `user[:password]@`, `host:path` → `host/path`, no `.git`, lower
 * case. Null for an empty value.
 */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  s = s.replace(/^[^/]*@/, ''); // userinfo (git@, oauth2:token@, a password with @)
  s = s.replace(/^([^/:]+):(?!\d+\/)/, '$1/'); // scp form host:path (not host:port/)
  s = s.replace(/^([^/:]+):\d+\//, '$1/'); // port
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  return s.toLowerCase();
}

/** `user[:password]@` removed from a remote URL (shared with the agent, D9 p. 7). */
export { stripRemoteUserinfo as stripUserinfo } from '@agent-hub/shared';

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

/** A matcher over vault-relative paths: the element of the longest matching prefix (case-insensitive). */
export class PathMatcher {
  private readonly prefixes: Array<{ prefix: string; item: CatalogItem }> = [];
  constructor(items: CatalogItem[]) {
    for (const item of items) {
      if (item.path !== VAULT_BUILTIN) this.prefixes.push({ prefix: item.path.toLowerCase(), item });
      for (const p of item.clonePaths) this.prefixes.push({ prefix: p.toLowerCase(), item });
    }
    this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  match(rel: string): CatalogItem | null {
    const r = rel.toLowerCase();
    for (const { prefix, item } of this.prefixes) if (r === prefix || r.startsWith(`${prefix}/`)) return item;
    return null;
  }
}

/** mapping.csv (old,new,kind,note) → exact files and prefixes of depth 3 and 2 that lead to one element (≥60%). */
export function buildLegacy(csv: string, items: CatalogItem[]): Catalog['legacy'] {
  const matcher = new PathMatcher(items);
  const exact = new Map<string, string>();
  const all: Array<[string, string]> = [];
  for (const raw of csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .slice(1)) {
    if (!raw.trim()) continue;
    const [oldPath, newPath] = splitCsv(raw);
    if (!oldPath || !newPath) continue;
    all.push([oldPath.replace(/\\/g, '/').replace(/\/+$/, ''), newPath.replace(/\\/g, '/').replace(/\/+$/, '')]);
  }
  const current = new Set(all.map(([, n]) => n.split('/')[0]!));
  const rows = all.filter(([o, n]) => o !== n && !current.has(o.split('/')[0]!));
  for (const [o, n] of rows) exact.set(o.toLowerCase(), n);
  const prefixes = new Map<string, string>();
  for (const depth of [3, 2]) {
    const groups = new Map<string, Array<[string, string]>>();
    for (const [o, n] of rows) {
      const parts = o.split('/');
      if (parts.length <= depth) continue;
      const p = parts.slice(0, depth).join('/').toLowerCase();
      let g = groups.get(p);
      if (!g) groups.set(p, (g = []));
      g.push([o, n]);
    }
    for (const [p, g] of groups) {
      if (prefixes.has(p)) continue;
      const votes = new Map<string, number>();
      for (const [, n] of g) {
        const item = matcher.match(n);
        const k = item ? item.path : '';
        votes.set(k, (votes.get(k) ?? 0) + 1);
      }
      const [best, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!;
      if (!best || count / g.length < 0.6) continue;
      // The new prefix: the element's path (the rest of the old path follows it).
      const item = items.find(i => i.path === best)!;
      prefixes.set(p, item.path === VAULT_BUILTIN ? item.clonePaths[0]! : item.path);
    }
  }
  return { exact, prefixes, current };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** An old-structure path in the new structure, or the path unchanged (current structure, or no translation). */
export function translateLegacy(rel: string, legacy: Catalog['legacy']): string {
  const first = rel.split('/')[0]!;
  if (legacy.current.has(first) || !/^\d\d-/.test(first)) return rel;
  const low = rel.toLowerCase();
  const exact = legacy.exact.get(low);
  if (exact) return exact;
  const parts = rel.split('/');
  // A moved directory is a row of its own (`04-systems/16-scanner-fleet` → `…/repos/scanner-fleet`): its files follow.
  for (let n = parts.length - 1; n >= 2; n--) {
    const dir = legacy.exact.get(parts.slice(0, n).join('/').toLowerCase());
    if (dir) return `${dir}/${parts.slice(n).join('/')}`;
  }
  for (const depth of [3, 2]) {
    if (parts.length <= depth) continue;
    const p = parts.slice(0, depth).join('/').toLowerCase();
    const to = legacy.prefixes.get(p);
    if (to) return `${to}/${parts.slice(depth).join('/')}`;
  }
  return rel;
}

export function buildCatalog(indexText: string, reposText: string, mappingCsv: string | null): Catalog {
  const items = parseIndex(indexText);
  const repos = bindClones(items, reposText);
  const all = [...items, ...repos, ...builtins()];
  return { items: all, legacy: mappingCsv ? buildLegacy(mappingCsv, all) : { exact: new Map(), prefixes: new Map(), current: new Set() } };
}
