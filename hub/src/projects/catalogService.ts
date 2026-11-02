// The catalogue in the hub (design D9 p. 1, task 4.3): built from VAULT_DIR (INDEX.md, 40-automation/repos.txt) and
// LEGACY_PATHS_FILE, re-read when a file's mtime changes (checked every 60 s), synced to `projects` per user (upsert by
// path; an element that moved inside its area with the same slug — into projects/99-archive — keeps its id; a vanished
// one is deleted: sessions → «Без проекта», pinned ones get «проект удалён из справочника»). Lookups by vault path and
// by remote for the signals. Requirement (project-grouping): Справочник проектов.
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { ColorKey } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { buildCatalog, builtins, normalizeRemote, PathMatcher, translateLegacy, VAULT_BUILTIN, type Catalog, type CatalogItem } from './catalog.js';
import type { ItemInfo } from './classify.js';

export interface ProjectRow {
  id: string;
  kind: CatalogItem['kind'];
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
  /** The vault as mounted into the hub (/vault); null — only the built-in elements. */
  vaultDir: string | null;
  /** mapping.csv of the 2026-10-04 restructuring; null or missing — no translation of old paths. */
  legacyFile: string | null;
  /** Remotes of the vault itself (normalised host/group/repo): no project. */
  vaultRemotes: string[];
  /** Called after a sync that changed the catalogue (touches re-matched, unpinned sessions reclassified). */
  onChanged?: (userIds: string[], orphans: string[]) => Promise<void>;
  /** projects:reclassify --dry-run: nothing written; elements not in `projects` yet get the id `path:<path>`. */
  readOnly?: boolean;
}

export class ProjectCatalog {
  private catalog: Catalog = { items: builtins(), legacy: { exact: new Map(), prefixes: new Map(), current: new Set() } };
  private matcher = new PathMatcher(this.catalog.items);
  private readonly ids = new Map<string, string>(); // `${userId}:${path}` → id
  private readonly rows = new Map<string, ProjectRow>(); // id → row
  private mtimes = '';
  private timer: NodeJS.Timeout | null = null;
  private loading: Promise<void> | null = null;
  readonly vaultRemotes: Set<string>;

  constructor(private readonly o: CatalogOptions) {
    this.vaultRemotes = new Set(o.vaultRemotes.map(r => normalizeRemote(r)).filter((r): r is string => !!r));
  }

  /** First load and the check every `everyMs` (60 s). */
  async start(everyMs = 60_000): Promise<void> {
    await this.reload();
    if (everyMs > 0) {
      this.timer = setInterval(() => void this.reload().catch((err: unknown) => this.o.log.warn({ err }, 'catalog reload failed')), everyMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private files(): string[] {
    const v = this.o.vaultDir;
    return [...(v ? [join(v, 'INDEX.md'), join(v, '40-automation', 'repos.txt')] : []), ...(this.o.legacyFile ? [this.o.legacyFile] : [])];
  }

  /** Re-reads the files when one of them changed (or `force`) and syncs `projects` of every user. */
  async reload(force = false): Promise<boolean> {
    if (this.loading) {
      await this.loading;
      if (!force) return false;
    }
    let changed = false;
    this.loading = (async () => {
      const stamps = await Promise.all(
        this.files().map(f =>
          stat(f)
            .then(s => `${f}:${s.mtimeMs}:${s.size}`)
            .catch(() => `${f}:-`),
        ),
      );
      const key = stamps.join('|');
      if (!force && key === this.mtimes && this.ids.size) return;
      const read = (f: string) => readFile(f, 'utf8').catch(() => null);
      const v = this.o.vaultDir;
      const index = v ? await read(join(v, 'INDEX.md')) : null;
      const repos = v ? await read(join(v, '40-automation', 'repos.txt')) : null;
      const legacy = this.o.legacyFile ? await read(this.o.legacyFile) : null;
      if (v && index === null) this.o.log.warn({ vaultDir: v }, 'INDEX.md not found: only the built-in projects');
      this.catalog = buildCatalog(index ?? '', repos ?? '', legacy);
      this.matcher = new PathMatcher(this.catalog.items);
      changed = this.o.readOnly ? (await this.refreshIds(), false) : await this.sync();
      this.mtimes = key;
      this.o.log.info({ items: this.catalog.items.length, legacyPrefixes: this.catalog.legacy.prefixes.size, changed }, 'project catalogue loaded');
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
    return changed;
  }

  /**
   * Users who get the vault catalogue: administrators only (change multi-user, design M6, requirement «Справочник
   * проектов vault только у администратора»). A user of role `user` has git-remote and manual groups only.
   */
  private async catalogUsers(): Promise<string[]> {
    return (await this.o.db.selectFrom('users').select('id').where('role', '=', 'admin').execute()).map(u => u.id);
  }

  /** Upsert of the catalogue for every administrator; true when rows were added, moved or removed. */
  private async sync(): Promise<boolean> {
    const users = await this.catalogUsers();
    let changed = false;
    const touchedUsers: string[] = [];
    // Unpinned sessions of a vanished project: decided again by rematch (no pass over all sessions).
    const orphans: string[] = [];
    for (const userId of users) {
      const had = await this.o.db.selectFrom('projects').selectAll().where('user_id', '=', userId).execute();
      const byPath = new Map(had.map(r => [r.path, r]));
      const wanted = new Map(this.catalog.items.map(i => [i.path, i]));
      let userChanged = false;
      // An element that moved inside its area with the same slug (projects/99-archive) keeps its id.
      for (const r of had) {
        if (wanted.has(r.path)) continue;
        const moved = this.catalog.items.find(i => !byPath.has(i.path) && i.kind === r.kind && i.areaPath === r.area_path && i.slug === r.slug);
        if (moved) {
          await this.o.db.updateTable('projects').set({ path: moved.path }).where('id', '=', r.id).execute();
          byPath.delete(r.path);
          byPath.set(moved.path, { ...r, path: moved.path });
          userChanged = true;
        }
      }
      for (const item of this.catalog.items) {
        const values = {
          kind: item.kind,
          area_path: item.areaPath,
          slug: item.slug,
          title: item.title,
          summary: item.summary,
          archived: item.archived,
          color_key: item.colorKey,
          git_remotes: item.gitRemotes,
          clone_paths: item.clonePaths,
          origin: item.origin,
        };
        const cur = byPath.get(item.path);
        if (!cur) {
          await this.o.db
            .insertInto('projects')
            .values({ user_id: userId, path: item.path, ...values })
            .onConflict(oc => oc.columns(['user_id', 'path']).doUpdateSet(values))
            .execute();
          userChanged = true;
        } else if (
          cur.title !== item.title ||
          cur.archived !== item.archived ||
          cur.kind !== item.kind ||
          cur.summary !== item.summary ||
          cur.color_key !== item.colorKey ||
          cur.git_remotes.join() !== item.gitRemotes.join() ||
          cur.clone_paths.join() !== item.clonePaths.join() ||
          cur.area_path !== item.areaPath
        ) {
          await this.o.db
            .updateTable('projects')
            .set({ ...values, updated_at: sql`now()` })
            .where('id', '=', cur.id)
            .execute();
          userChanged = true;
        }
      }
      const gone = [...byPath.values()].filter(r => !wanted.has(r.path)).map(r => r.id);
      if (gone.length) {
        // Lookups stop naming them before the rows go: a touch computed now does not reference a deleted id.
        for (const id of gone) this.rows.delete(id);
        for (const [k, id] of this.ids) if (gone.includes(id)) this.ids.delete(k);
        await this.o.db
          .updateTable('sessions')
          .set({ project_evidence: JSON.stringify({ edits: 0, reads: 0, cwd: 0, remote: null, text: 'проект удалён из справочника' }) })
          .where('project_id', 'in', gone)
          .where('project_source', '=', 'manual')
          .execute();
        const reset = await this.o.db
          .updateTable('sessions')
          .set({ project_source: 'none', project_evidence: null })
          .where('project_id', 'in', gone)
          .where('project_source', '<>', 'manual')
          .returning('id')
          .execute();
        orphans.push(...reset.map(r => r.id));
        await this.o.db.deleteFrom('projects').where('id', 'in', gone).execute();
        userChanged = true;
      }
      if (userChanged) {
        changed = true;
        touchedUsers.push(userId);
      }
    }
    await this.refreshIds();
    if (changed && this.o.onChanged) await this.o.onChanged(touchedUsers, orphans);
    return changed;
  }

  private async refreshIds(): Promise<void> {
    const rows = await this.o.db.selectFrom('projects').select(['id', 'user_id', 'path', 'kind', 'area_path', 'slug', 'title', 'color_key', 'archived']).execute();
    this.ids.clear();
    this.rows.clear();
    for (const r of rows) {
      this.ids.set(`${r.user_id}:${r.path}`, r.id);
      this.rows.set(r.id, { id: r.id, kind: r.kind, path: r.path, areaPath: r.area_path, slug: r.slug, title: r.title, colorKey: r.color_key as ColorKey, archived: r.archived });
    }
    if (this.o.readOnly) {
      const users = await this.catalogUsers();
      for (const userId of users) {
        for (const i of this.catalog.items) {
          if (this.ids.has(`${userId}:${i.path}`)) continue;
          const id = `path:${i.path}`;
          this.ids.set(`${userId}:${i.path}`, id);
          this.rows.set(id, { id, kind: i.kind, path: i.path, areaPath: i.areaPath, slug: i.slug, title: i.title, colorKey: i.colorKey, archived: i.archived });
        }
      }
    }
  }

  /** A user who signed up after the last sync (first login, a new runner owner) gets the catalogue now. */
  async ensureUser(userId: string): Promise<void> {
    for (const k of this.ids.keys()) if (k.startsWith(`${userId}:`)) return;
    // design M6: a user of role `user` never gets the vault catalogue (and no reload is spent on him).
    const u = await this.o.db.selectFrom('users').select('role').where('id', '=', userId).executeTakeFirst();
    if (u?.role !== 'admin') return;
    await this.reload(true);
  }

  /** The element of a vault path (old-structure paths translated) for the user; null outside the catalogue. */
  matchPath(userId: string, rel: string): string | null {
    const item = this.matcher.match(translateLegacy(rel, this.catalog.legacy));
    return item ? (this.ids.get(`${userId}:${item.path}`) ?? null) : null;
  }

  /** The path as stored in path_touches: an old-structure path in the new structure. */
  normalizePath(rel: string): string {
    return translateLegacy(rel, this.catalog.legacy);
  }

  /** The element of a normalised remote (not the vault's own); null when none. */
  matchRemote(userId: string, remote: string): string | null {
    if (this.vaultRemotes.has(remote)) return null;
    const item = this.catalog.items.find(i => i.gitRemotes.includes(remote));
    return item ? (this.ids.get(`${userId}:${item.path}`) ?? null) : null;
  }

  /** The id is an element of the catalogue now (a touch with any other id is stored without a project). */
  has(id: string): boolean {
    return this.rows.has(id);
  }

  row(id: string | null): ProjectRow | null {
    return id ? (this.rows.get(id) ?? null) : null;
  }

  /** Elements of the user for the classifier. */
  infos(userId: string): Map<string, ItemInfo> {
    const out = new Map<string, ItemInfo>();
    for (const [k, id] of this.ids) {
      if (!k.startsWith(`${userId}:`)) continue;
      const r = this.rows.get(id)!;
      out.set(id, { id, kind: r.kind, areaPath: r.areaPath, path: r.path, title: r.title, ...(r.path === VAULT_BUILTIN ? { readsFree: true } : {}) });
    }
    return out;
  }

  /** The catalogue of the user for GET /api/projects. */
  list(userId: string): ProjectRow[] {
    return [...this.ids.entries()].filter(([k]) => k.startsWith(`${userId}:`)).map(([, id]) => this.rows.get(id)!);
  }

  /** The catalogue as built (tests). */
  get items(): CatalogItem[] {
    return this.catalog.items;
  }
}
