// Task 4.3: the catalogue on copies of the vault's INDEX.md, repos.txt and mapping.csv (2026-10-26), exact counts;
// the DB sync keeps an element's id when it moves to projects/99-archive and removes vanished ones.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/db.js';
import { FIXTURE_MAPPING, FIXTURE_VAULT } from '../test/harness.js';
import { buildCatalog, normalizeRemote, PathMatcher, stripUserinfo, translateLegacy } from './catalog.js';
import { ProjectCatalog } from './catalogService.js';

const read = (p: string) => readFileSync(p, 'utf8');
const index = read(join(FIXTURE_VAULT, 'INDEX.md'));
const repos = read(join(FIXTURE_VAULT, '40-automation', 'repos.txt'));
const mapping = read(FIXTURE_MAPPING);
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('catalogue (fixtures of the vault)', () => {
  const c = buildCatalog(index, repos, mapping);
  const of = (kind: string) => c.items.filter(i => i.kind === kind);
  const m = new PathMatcher(c.items);

  it('13 areas, 38 systems, 45 projects (1 archived), 49 clones: 20 bound, 29 own; «Vault» and «Знания»', () => {
    expect(of('area')).toHaveLength(13);
    expect(of('system')).toHaveLength(38);
    expect(of('project')).toHaveLength(45);
    expect(c.items.filter(i => i.archived).map(i => i.path)).toEqual(['10-work/05-infra/projects/99-archive/04-twenty-crm']);
    const bound = c.items.flatMap(i => (i.kind === 'builtin' ? [] : i.clonePaths));
    expect(bound).toHaveLength(20);
    expect(of('repo')).toHaveLength(29);
    expect(of('builtin').map(i => i.title)).toEqual(['Vault', 'Знания']);
  });

  it('clones: mm-sms-bridge → 03-mm-sms-bridge, agent-hub → 05-agent-hub, k8s-manifests — own element of 05-infra', () => {
    expect(m.match('10-work/04-support/repos/mm-sms-bridge/src/x.ts')?.slug).toBe('03-mm-sms-bridge');
    expect(m.match('20-personal/05-pos/repos/agent-hub/hub/src/app.ts')?.slug).toBe('05-agent-hub');
    const k8s = m.match('10-work/05-infra/repos/k8s-manifests/x.yaml')!;
    expect(k8s).toMatchObject({ kind: 'repo', slug: 'k8s-manifests', areaPath: '10-work/05-infra', colorKey: 'infra' });
    const fleet = c.items.find(i => i.slug === '02-scanner-fleet')!;
    expect(fleet.gitRemotes).toContain('git.example.com/development/scanner/scanner-fleet');
  });

  it('paths: the longest prefix; areas, «Vault» files, «Знания»; case-insensitive', () => {
    expect(m.match('20-personal/01-finance/systems/01-ledger/x.py')?.slug).toBe('01-ledger');
    expect(m.match('10-work/04-support/notes.md')).toMatchObject({ kind: 'area', title: 'Поддержка' });
    expect(m.match('00-meta/02-memory/MEMORY.md')?.title).toBe('Vault');
    expect(m.match('CLAUDE.md')?.title).toBe('Vault');
    expect(m.match('30-knowledge/03-playbooks/x.md')?.title).toBe('Знания');
    expect(m.match('20-PERSONAL/01-FINANCE/systems/01-ledger')?.slug).toBe('01-ledger');
    expect(m.match('50-unknown/x')).toBeNull();
  });

  it('old structure: 04-systems/16-scanner-fleet/x → 02-scanner-fleet; 05-data/01-raw/x — no translation; current paths unchanged', () => {
    expect(m.match(translateLegacy('04-systems/16-scanner-fleet/x', c.legacy))?.slug).toBe('02-scanner-fleet');
    expect(translateLegacy('05-data/01-raw/x', c.legacy)).toBe('05-data/01-raw/x');
    expect(translateLegacy('20-personal/01-finance/x', c.legacy)).toBe('20-personal/01-finance/x');
  });

  it('review M4a: a password with @, the clone name as a whole word, a token in an own clone, INDEX paths outside the area', () => {
    expect(stripUserinfo('https://u:p@ss@git.example.com/a/b.git')).toBe('https://git.example.com/a/b.git');
    expect(normalizeRemote('https://u:p@ss@git.example.com/a/b.git')).toBe('git.example.com/a/b');
    const index = [
      '## Поддержка (`10-work/04-support`)',
      '**Проекты**',
      '- [`02-servicedesk`](10-work/04-support/projects/02-servicedesk/) — клон `repos/sd2` · [карточка](x)',
      '- [`06-evil`](10-work/04-support/../../20-personal/x/) — уход из области · [карточка](x)',
      '- [`07-other`](20-personal/01-finance/systems/07-other/) — чужая область · [карточка](x)',
    ].join('\n');
    const repos = '10-work/04-support/repos/sd https://oauth2:glpat-SECRET@git.example.com/x/sd.git\n10-work/04-support/repos/sd2 https://git.example.com/x/sd2.git\n';
    const cat = buildCatalog(index, repos, '');
    expect(cat.items.filter(i => i.kind === 'project').map(i => i.slug)).toEqual(['02-servicedesk']);
    expect(cat.items.find(i => i.slug === '02-servicedesk')!.clonePaths).toEqual(['10-work/04-support/repos/sd2']);
    const sd = cat.items.find(i => i.kind === 'repo' && i.slug === 'sd')!;
    expect(sd.summary).toBe('https://git.example.com/x/sd.git');
    expect(JSON.stringify(cat.items)).not.toContain('SECRET');
  });

  it('remote normalisation and credentials', () => {
    expect(normalizeRemote('git@git.example.com:development/scanner/scanner-fleet.git')).toBe('git.example.com/development/scanner/scanner-fleet');
    expect(normalizeRemote('https://oauth2:glpat-xyz@git.example.com/alice/pos.git')).toBe('git.example.com/alice/pos');
    expect(normalizeRemote('ssh://git@gitlab.com:22/Jonasasx/Agent-Hub.git/')).toBe('gitlab.com/jonasasx/agent-hub');
    expect(stripUserinfo('https://oauth2:glpat-xyz@git.example.com/alice/pos.git')).toBe('https://git.example.com/alice/pos.git');
    expect(stripUserinfo('git@git.example.com:a/b.git')).toBe('git@git.example.com:a/b.git');
  });
});

describe('catalogue sync (Postgres)', () => {
  let t: TestDb;
  let dir: string;
  beforeAll(async () => {
    t = await createTestDb();
    await t.pool.query(`INSERT INTO users (email, role) VALUES ('jonasasx@gmail.com', 'admin')`);
    dir = mkdtempSync(join(tmpdir(), 'agenthub-vault-'));
    cpSync(FIXTURE_VAULT, dir, { recursive: true });
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a project moved to projects/99-archive keeps its id and sessions; a vanished one leaves its sessions «Без проекта»', async () => {
    const catalog = new ProjectCatalog({ db: t.db, log, vaultDir: dir, legacyFile: null, vaultRemotes: [] });
    await catalog.start(0);
    const ids = async (path: string) => (await t.pool.query(`SELECT id, archived FROM projects WHERE path = $1`, [path])).rows[0];
    const before = await ids('10-work/01-scanner/projects/04-site-c');
    expect(before).toMatchObject({ archived: false });
    const uid = (await t.pool.query(`SELECT id FROM users`)).rows[0].id;
    await t.pool.query(`INSERT INTO runners (id, user_id, name) VALUES ('hp', $1, 'HP')`, [uid]);
    const sid = (
      await t.pool.query(
        `INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, project_id, project_source) VALUES ($1, 'hp', gen_random_uuid(), 'terminal', 'closed', $2, 'manual') RETURNING id`,
        [uid, before.id],
      )
    ).rows[0].id;
    // 04-site-c goes to the archive; 05-solidworks-pdm disappears
    let text = read(join(dir, 'INDEX.md'));
    const siteC = text.split('\n').find(l => l.startsWith('- [`04-site-c`]'))!;
    const pdm = text.split('\n').find(l => l.startsWith('- [`05-solidworks-pdm`]'))!;
    text = text.replace(`${siteC}\n`, '').replace(`${pdm}\n`, '');
    text = text.replace(
      '## Платформа (`10-work/02-platform`)',
      `**Архив проектов**\n\n${siteC.replace('(10-work/01-scanner/projects/04-site-c/)', '(10-work/01-scanner/projects/99-archive/04-site-c/)')}\n\n## Платформа (\`10-work/02-platform\`)`,
    );
    writeFileSync(join(dir, 'INDEX.md'), text);
    const pdmId = (await ids('10-work/01-scanner/projects/05-solidworks-pdm')).id;
    const sid2 = (
      await t.pool.query(
        `INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, project_id, project_source) VALUES ($1, 'hp', gen_random_uuid(), 'terminal', 'closed', $2, 'manual') RETURNING id`,
        [uid, pdmId],
      )
    ).rows[0].id;
    expect(await catalog.reload()).toBe(true);
    const after = await ids('10-work/01-scanner/projects/99-archive/04-site-c');
    expect(after).toEqual({ id: before.id, archived: true });
    expect((await t.pool.query(`SELECT project_id FROM sessions WHERE id = $1`, [sid])).rows[0].project_id).toBe(before.id);
    expect((await t.pool.query(`SELECT project_id, project_source, project_evidence FROM sessions WHERE id = $1`, [sid2])).rows[0]).toMatchObject({
      project_id: null,
      project_source: 'manual',
      project_evidence: { text: 'проект удалён из справочника' },
    });
    // unchanged files: no reload work
    expect(await catalog.reload()).toBe(false);
    catalog.stop();
  });
});

// Change multi-user, task 3.4 (design M6): Requirement «Справочник проектов vault только у администратора».
describe('catalogue of the vault only for administrators (Postgres)', () => {
  let t: TestDb;
  let ivan: string;
  let bob: string;
  beforeAll(async () => {
    t = await createTestDb();
    ivan = (await t.pool.query(`INSERT INTO users (email, role) VALUES ('jonasasx@gmail.com', 'admin') RETURNING id`)).rows[0].id;
    bob = (await t.pool.query(`INSERT INTO users (email) VALUES ('bob@example.com') RETURNING id`)).rows[0].id;
  });
  afterAll(async () => t.drop());
  const count = async (userId: string) => Number((await t.pool.query(`SELECT count(*) AS n FROM projects WHERE user_id = $1`, [userId])).rows[0].n);

  it('Дерево проектов у Кати: after sync(), after her runner connects (ensureUser) and in readOnly — no vault projects, no built-ins', async () => {
    const catalog = new ProjectCatalog({ db: t.db, log, vaultDir: FIXTURE_VAULT, legacyFile: null, vaultRemotes: [] });
    await catalog.start(0);
    expect(await count(ivan)).toBeGreaterThan(100);
    expect(catalog.list(ivan).some(p => p.kind === 'builtin')).toBe(true);
    expect(await count(bob)).toBe(0);
    expect(catalog.list(bob)).toEqual([]);
    await catalog.ensureUser(bob);
    expect(await count(bob)).toBe(0);
    expect(catalog.list(bob)).toEqual([]);
    expect(catalog.matchPath(bob, '20-personal/05-pos/systems/05-agent-hub/x.md')).toBeNull();
    expect(catalog.matchPath(ivan, '20-personal/05-pos/systems/05-agent-hub/x.md')).not.toBeNull();
    catalog.stop();

    // the CLI's read-only catalogue (projects:reclassify --dry-run): path ids only for the administrator
    const ro = new ProjectCatalog({ db: t.db, log, vaultDir: FIXTURE_VAULT, legacyFile: null, vaultRemotes: [], readOnly: true });
    await t.pool.query(`DELETE FROM projects`);
    await ro.start(0);
    expect(ro.list(ivan).length).toBeGreaterThan(100);
    expect(ro.list(bob)).toEqual([]);
    ro.stop();
  });
});
