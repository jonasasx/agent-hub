// The legacy catalogue from the DB (change catalog-db-session-context, D1): path and remote matching from `projects`
// rows, remote normalisation. Requirement (project-catalog-source): Каталог проектов только в базе хаба.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/db.js';
import { FIXTURE_VAULT } from '../test/harness.js';
import { fixtureCatalog, seedLegacyProjects } from '../test/legacyCatalog.js';
import { normalizeRemote, PathMatcher, stripUserinfo } from './catalog.js';
import { ProjectCatalog } from './catalogService.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('path matcher', () => {
  const m = new PathMatcher([
    { id: 'pos', prefixes: ['20-personal/05-pos'] },
    { id: 'ah', prefixes: ['20-personal/05-pos/systems/05-agent-hub', '20-personal/05-pos/repos/agent-hub'] },
  ]);

  it('the longest prefix wins, case-insensitive, whole path segments only', () => {
    expect(m.match('20-personal/05-pos/systems/05-agent-hub/x.md')).toBe('ah');
    expect(m.match('20-personal/05-pos/repos/agent-hub/hub/src/app.ts')).toBe('ah');
    expect(m.match('20-PERSONAL/05-POS/notes.md')).toBe('pos');
    expect(m.match('20-personal/05-pos')).toBe('pos');
    expect(m.match('20-personal/05-posx/a')).toBeNull();
    expect(m.match('50-unknown/x')).toBeNull();
  });
});

describe('remotes', () => {
  it('normalisation and credentials', () => {
    expect(normalizeRemote('git@git.example.com:development/scanner/fleet-ops.git')).toBe('git.example.com/development/scanner/fleet-ops');
    expect(normalizeRemote('https://oauth2:glpat-xyz@git.example.com/alice/pos.git')).toBe('git.example.com/alice/pos');
    expect(normalizeRemote('ssh://git@git.example.com:22/Alice/Agent-Hub.git/')).toBe('git.example.com/alice/agent-hub');
    expect(normalizeRemote('https://u:p@ss@git.example.com/a/b.git')).toBe('git.example.com/a/b');
    expect(stripUserinfo('https://oauth2:glpat-xyz@git.example.com/alice/pos.git')).toBe('https://git.example.com/alice/pos.git');
    expect(stripUserinfo('https://u:p@ss@git.example.com/a/b.git')).toBe('https://git.example.com/a/b.git');
    expect(stripUserinfo('git@git.example.com:a/b.git')).toBe('git@git.example.com:a/b.git');
  });
});

describe('catalogue from the DB (Postgres)', () => {
  let t: TestDb;
  let ivan: string;
  let bob: string;
  beforeAll(async () => {
    t = await createTestDb();
    ivan = (await t.pool.query(`INSERT INTO users (email, role) VALUES ('alice@example.com', 'admin') RETURNING id`)).rows[0].id;
    bob = (await t.pool.query(`INSERT INTO users (email) VALUES ('bob@example.com') RETURNING id`)).rows[0].id;
    await seedLegacyProjects(t.db, ivan, fixtureCatalog(FIXTURE_VAULT));
  });
  afterAll(async () => t.drop());

  it('Новый путь сопоставляется по базе: path, clone paths, «Vault» files, remotes; per user', async () => {
    const catalog = new ProjectCatalog({ db: t.db, log });
    await catalog.load();
    const slug = (id: string | null) => catalog.row(id)?.slug ?? null;
    expect(slug(catalog.matchPath(ivan, '20-personal/01-finance/systems/01-ledger/x.py'))).toBe('01-ledger');
    expect(slug(catalog.matchPath(ivan, '20-personal/05-pos/repos/agent-hub/hub/src/app.ts'))).toBe('05-agent-hub');
    expect(slug(catalog.matchPath(ivan, '10-work/04-support/repos/sms-bridge/src/x.ts'))).toBe('03-sms-bridge');
    expect(catalog.row(catalog.matchPath(ivan, 'CLAUDE.md'))?.title).toBe('Vault');
    expect(catalog.row(catalog.matchPath(ivan, '10-work/04-support/notes.md'))).toMatchObject({ kind: 'area', title: 'Поддержка' });
    expect(catalog.matchPath(ivan, '50-unknown/x')).toBeNull();
    expect(slug(catalog.matchRemote(ivan, 'git.example.com/development/scanner/fleet-ops'))).toBe('02-fleet-ops');
    expect(catalog.matchRemote(ivan, 'git.example.com/none/none')).toBeNull();
    const vault = catalog.list(ivan).find(r => r.title === 'Vault')!;
    expect(catalog.infos(ivan).get(vault.id)).toMatchObject({ readsFree: true });
    expect(catalog.list(bob)).toEqual([]);
    expect(catalog.matchPath(bob, '20-personal/01-finance/systems/01-ledger/x.py')).toBeNull();
  });

  it('a row changed in the DB is seen after load(); setColor writes and reloads', async () => {
    const catalog = new ProjectCatalog({ db: t.db, log });
    await catalog.load();
    const ledger = catalog.list(ivan).find(r => r.slug === '01-ledger')!;
    await t.pool.query(`UPDATE projects SET clone_paths = $1 WHERE id = $2`, [['20-personal/01-finance/repos/ledger'], ledger.id]);
    expect(catalog.matchPath(ivan, '20-personal/01-finance/repos/ledger/a.py')).not.toBe(ledger.id);
    await catalog.load();
    expect(catalog.matchPath(ivan, '20-personal/01-finance/repos/ledger/a.py')).toBe(ledger.id);
    expect(await catalog.setColor(ivan, ledger.id, 'rose')).toBe(true);
    expect(catalog.row(ledger.id)?.colorKey).toBe('rose');
    expect(await catalog.setColor(bob, ledger.id, 'infra')).toBe(false);
  });
});
