// The legacy project catalogue (`projects`): path groups, matched by vault path and by remote for the signals. The
// database is its only source (change catalog-db-session-context, D1): the hub reads no user files to build it. Rows
// change only through the hub (colour), so they are loaded once at start and after a change.
// Requirement (project-catalog-source): Каталог проектов только в базе хаба.
import type { FastifyBaseLogger } from 'fastify';
import type { ColorKey } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { PathMatcher, type ItemKind } from './catalog.js';
import type { ItemInfo } from './classify.js';

export interface ProjectRow {
  id: string;
  kind: ItemKind;
  path: string;
  areaPath: string | null;
  slug: string;
  title: string;
  colorKey: ColorKey;
  archived: boolean;
}

export interface CatalogOptions {
  db: Db;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

/** `builtin:vault`: an element grouped by its clone paths only (the files of the vault itself). */
const isPseudoPath = (path: string) => path.startsWith('builtin:');

interface UserCatalog {
  matcher: PathMatcher;
  /** Normalised remote → id. */
  remotes: Map<string, string>;
  ids: string[];
}

export class ProjectCatalog {
  private readonly rows = new Map<string, ProjectRow>(); // id → row
  private readonly users = new Map<string, UserCatalog>();

  constructor(private readonly o: CatalogOptions) {}

  /** Reads `projects` of every user. */
  async load(): Promise<void> {
    const rows = await this.o.db.selectFrom('projects').select(['id', 'user_id', 'path', 'kind', 'area_path', 'slug', 'title', 'color_key', 'archived', 'git_remotes', 'clone_paths']).execute();
    this.rows.clear();
    this.users.clear();
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) {
      this.rows.set(r.id, { id: r.id, kind: r.kind, path: r.path, areaPath: r.area_path, slug: r.slug, title: r.title, colorKey: r.color_key as ColorKey, archived: r.archived });
      let list = byUser.get(r.user_id);
      if (!list) byUser.set(r.user_id, (list = []));
      list.push(r);
    }
    for (const [userId, list] of byUser) {
      const remotes = new Map<string, string>();
      for (const r of list) for (const remote of r.git_remotes) if (!remotes.has(remote)) remotes.set(remote, r.id);
      const matcher = new PathMatcher(list.map(r => ({ id: r.id, prefixes: isPseudoPath(r.path) ? r.clone_paths : [r.path, ...r.clone_paths] })));
      this.users.set(userId, { matcher, remotes, ids: list.map(r => r.id) });
    }
    this.o.log.info({ items: rows.length }, 'project catalogue loaded');
  }

  /** The element of a vault path for the user; null outside the catalogue. */
  matchPath(userId: string, rel: string): string | null {
    return this.users.get(userId)?.matcher.match(rel) ?? null;
  }

  /** The element of a normalised remote; null when none. */
  matchRemote(userId: string, remote: string): string | null {
    return this.users.get(userId)?.remotes.get(remote) ?? null;
  }

  /** The id is an element of the catalogue now (a touch with any other id is stored without a project). */
  has(id: string): boolean {
    return this.rows.has(id);
  }

  row(id: string | null): ProjectRow | null {
    return id ? (this.rows.get(id) ?? null) : null;
  }

  /** Elements of the user for the classifier; an element without a path of its own (the vault's files) does not count reads. */
  infos(userId: string): Map<string, ItemInfo> {
    const out = new Map<string, ItemInfo>();
    for (const r of this.list(userId)) {
      out.set(r.id, { id: r.id, kind: r.kind, areaPath: r.areaPath, path: r.path, title: r.title, ...(isPseudoPath(r.path) ? { readsFree: true } : {}) });
    }
    return out;
  }

  /** The catalogue of the user for GET /api/projects. */
  list(userId: string): ProjectRow[] {
    return (this.users.get(userId)?.ids ?? []).map(id => this.rows.get(id)!);
  }

  /** Per-user legacy color override. */
  async setColor(userId: string, id: string, colorKey: ColorKey): Promise<boolean> {
    const result = await this.o.db.updateTable('projects').set({ color_key: colorKey }).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!Number(result.numUpdatedRows)) return false;
    await this.load();
    return true;
  }
}
