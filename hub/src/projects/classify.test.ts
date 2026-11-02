// Tasks 4.4–4.5: path normalisation on X1/HP and the VM, tool calls → signals, and the decisions of every scenario of
// spec project-grouping. Requirements: Сигналы путей; Классификация по путям.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_MAPPING, FIXTURE_VAULT } from '../test/harness.js';
import { buildCatalog, PathMatcher, translateLegacy, VAULT_BUILTIN } from './catalog.js';
import { classify, evidenceText, type ItemInfo, type Touch } from './classify.js';
import { shellPaths, signalPath, toolPaths, toVaultRelative } from './signals.js';

const HP = { windows: true, homeDir: 'C:\\Users\\alice', vaultRoot: 'C:\\Users\\alice\\vault' };
const VM = { windows: false, homeDir: '/home/ubuntu', vaultRoot: '/home/ubuntu/vault' };
const UNKNOWN = { windows: true, homeDir: null, vaultRoot: null };

describe('paths (D9 p. 2)', () => {
  it('X1/HP and the VM give the same vault path; case, separators, ~, relative, Git Bash drives', () => {
    expect(toVaultRelative('C:\\Users\\alice\\vault\\20-personal\\01-finance\\systems\\01-ledger\\x.py', null, HP)).toBe('20-personal/01-finance/systems/01-ledger/x.py');
    expect(toVaultRelative('/home/ubuntu/vault/20-personal/01-finance/systems/01-ledger/x.py', null, VM)).toBe('20-personal/01-finance/systems/01-ledger/x.py');
    expect(toVaultRelative('c:/users/alice/Vault/10-work/x', null, HP)).toBe('10-work/x');
    expect(toVaultRelative('/c/Users/alice/vault/10-work/x', null, HP)).toBe('10-work/x');
    expect(toVaultRelative('~/vault/00-meta/a.md', null, VM)).toBe('00-meta/a.md');
    expect(toVaultRelative('src/app.ts', 'C:\\Users\\alice\\vault\\20-personal\\05-pos\\repos\\agent-hub\\hub', HP)).toBe('20-personal/05-pos/repos/agent-hub/hub/src/app.ts');
    expect(toVaultRelative('../01-ledger/a', '/home/ubuntu/vault/20-personal/01-finance/systems/x', VM)).toBe('20-personal/01-finance/systems/01-ledger/a');
    expect(toVaultRelative('C:\\Users\\alice\\vault', null, HP)).toBe('');
    expect(toVaultRelative('C:\\tmp\\x.txt', null, HP)).toBeNull();
    expect(toVaultRelative('C:\\Users\\alice\\orca\\workspaces\\scanner-fleet\\fat-agent\\x.go', null, HP)).toBeNull();
  });

  it('a runner without vault_root: the vault found by its shape', () => {
    expect(toVaultRelative('C:\\Users\\old\\vault\\04-systems\\16-scanner-fleet\\CLAUDE.md', null, UNKNOWN)).toBe('04-systems/16-scanner-fleet/CLAUDE.md');
    expect(toVaultRelative('D:\\work\\vault-backup\\x', null, UNKNOWN)).toBeNull();
  });

  it('no signal: the root, .tmp/, .playwright-mcp/, .venv/, 01-inbox/, 99-archive/', () => {
    for (const p of ['', '.tmp/x', '.playwright-mcp/a.png', '.venv/lib', '01-inbox/a.md', '99-archive/old.md']) expect(signalPath(p)).toBeNull();
    expect(signalPath(null)).toBeNull();
    expect(signalPath('10-work/x/')).toBe('10-work/x');
  });

  it('tool calls: edit tools, read tools (no path — no signal), shell paths once per command', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\v\\a.md' } },
          { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: 'C:\\v\\n.ipynb' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } },
          { type: 'tool_use', name: 'Glob', input: { pattern: '*.md', path: 'C:\\v\\dir' } },
          {
            type: 'tool_use',
            name: 'Bash',
            input: {
              command: 'cd /c/Users/alice/vault && ls 10-work/04-support/ s/x/y/ origin/master && cat "/c/Users/alice/vault/INDEX.md" /c/Users/alice/vault/INDEX.md 2>/dev/null',
            },
          },
          { type: 'text', text: 'C:\\v\\not-a-tool.md' },
        ],
      },
    };
    expect(toolPaths(line, true)).toEqual([
      { op: 'edit', path: 'C:\\v\\a.md' },
      { op: 'edit', path: 'C:\\v\\n.ipynb' },
      { op: 'read', path: 'C:\\v\\dir' },
      { op: 'read', path: '/c/Users/alice/vault' },
      { op: 'read', path: '/c/Users/alice/vault/10-work/04-support/' }, // after `cd /c/…/vault &&`
      { op: 'read', path: '/c/Users/alice/vault/INDEX.md' },
      { op: 'read', path: '/dev/null' },
    ]);
    expect(toolPaths({ type: 'user', message: { content: [] } }, true)).toEqual([]);
    expect(shellPaths('python3 40-automation/scripts/gen_index.py --x', false)).toEqual(['40-automation/scripts/gen_index.py']);
    // prod X1: the transcript's cwd is a subdirectory, the command starts with `cd` to the vault root
    const winCwd = 'C:\\Users\\alice\\vault\\06-artifacts\\01-exports\\05-briefs';
    const [p87] = shellPaths('cd /c/Users/alice/vault && python 07-automation/01-scripts/hooks/pre_commit.py; echo "EXIT CODE: $?"', true).filter(x => x.includes('pre_commit'));
    expect(toVaultRelative(p87!, winCwd, HP)).toBe('07-automation/01-scripts/hooks/pre_commit.py');
    // without cd: from the transcript's cwd, as before
    const [p82] = shellPaths('python 07-automation/01-scripts/hooks/pre_commit.py', true);
    expect(toVaultRelative(p82!, winCwd, HP)).toBe('06-artifacts/01-exports/05-briefs/07-automation/01-scripts/hooks/pre_commit.py');
    // a relative cd: from cwd + that directory; the cd target itself is a path too
    expect(shellPaths('cd "20-personal/05-pos" && ls 20-personal/05-pos/systems 10-work/x', false)).toEqual(['20-personal/05-pos', '20-personal/05-pos/systems', '20-personal/05-pos/10-work/x']);
  });
});

describe('decisions (D9 p. 6, spec project-grouping)', () => {
  const c = buildCatalog(readFileSync(join(FIXTURE_VAULT, 'INDEX.md'), 'utf8'), readFileSync(join(FIXTURE_VAULT, '40-automation', 'repos.txt'), 'utf8'), readFileSync(FIXTURE_MAPPING, 'utf8'));
  const m = new PathMatcher(c.items);
  const items = new Map<string, ItemInfo>(
    c.items.map(i => [
      i.path,
      { id: i.path, kind: i.kind, areaPath: i.areaPath, path: i.path, title: i.kind === 'area' ? i.title : i.title, ...(i.path === VAULT_BUILTIN ? { readsFree: true } : {}) },
    ]),
  );
  const touch = (op: Touch['op'], rel: string): Touch => ({ op, projectId: m.match(translateLegacy(rel, c.legacy))?.path ?? null });
  const title = (id: string | null) => (id ? items.get(id)!.title : null);
  const decide = (ts: Touch[], cur: string | null = null) => {
    const d = classify(ts, items, cur);
    return { project: title(d.projectId), secondary: title(d.secondaryId), text: d.evidence?.text ?? null };
  };
  const AH = '20-personal/05-pos/systems/05-agent-hub';
  const LEDGER = '20-personal/01-finance/systems/01-ledger';

  it('Сессия в корне vault правит файлы проекта: 2 правки → 05-agent-hub «2 правки в 05-agent-hub»', () => {
    expect(decide([touch('edit', `${AH}/CLAUDE.md`), touch('edit', `${AH}/README.md`)])).toEqual({ project: '05-agent-hub', secondary: null, text: '2 правки в 05-agent-hub' });
  });

  it('Только чтение общих файлов: «Без проекта»', () => {
    expect(decide([touch('read', 'CLAUDE.md'), touch('read', 'INDEX.md'), touch('read', '00-meta/02-memory/MEMORY.md')])).toEqual({ project: null, secondary: null, text: null });
  });

  it('Одно чтение карточки проекта: 04-site-c «1 чтение в 04-site-c»', () => {
    expect(decide([touch('read', '10-work/01-scanner/projects/04-site-c/CLAUDE.md')])).toEqual({ project: '04-site-c', secondary: null, text: '1 чтение в 04-site-c' });
  });

  it('Запуск в каталоге проекта: 04-copilot «каталог запуска в 04-copilot»', () => {
    expect(decide([touch('cwd', '10-work/06-tools/systems/04-copilot')])).toEqual({ project: '04-copilot', secondary: null, text: 'каталог запуска в 04-copilot' });
  });

  it('Запуск в каталоге области: «Поддержка» «каталог запуска в Поддержка»', () => {
    const d = decide([touch('cwd', '10-work/04-support'), touch('read', '10-work/04-support/systems/02-mm-sd-bot/README.md'), touch('read', '10-work/04-support/projects/04-itsm-to-jira/CLAUDE.md')]);
    expect(d.project).toBe('Поддержка');
    expect(d.text).toBe('каталог запуска в Поддержка');
  });

  it('Явный перевес без большинства: «Vault» 81 vs 31, 19, 16 (and the area weight) → «Vault»', () => {
    const ts: Touch[] = [
      ...Array.from({ length: 27 }, () => touch('edit', '00-meta/02-memory/x.md')), // 81
      ...Array.from({ length: 10 }, () => touch('edit', '20-personal/05-pos/projects/01-personal-os/x.md')), // 30
      touch('read', '20-personal/05-pos/projects/01-personal-os/y.md'), // 31
      ...Array.from({ length: 6 }, () => touch('edit', '10-work/06-tools/systems/02-mcp-marketplace/x')),
      touch('read', '10-work/06-tools/systems/02-mcp-marketplace/y'), // 19
      ...Array.from({ length: 5 }, () => touch('edit', '10-work/06-tools/systems/01-ai-skills/x')),
      touch('read', '10-work/06-tools/systems/01-ai-skills/y'), // 16
      ...Array.from({ length: 33 }, () => touch('edit', '10-work/06-tools/notes.md')), // area 99: no rival
    ];
    expect(decide(ts).project).toBe('Vault');
  });

  it('Правка памяти в чужой сессии: 1 правка в 00-meta + 4 в 01-ledger → 01-ledger, «Vault» меткой', () => {
    const d = decide([touch('edit', '00-meta/02-memory/x.md'), ...Array.from({ length: 4 }, (_, i) => touch('edit', `${LEDGER}/f${i}.py`))]);
    expect(d).toEqual({ project: '01-ledger', secondary: 'Vault', text: '4 правки в 01-ledger' });
  });

  it('спорно: сигналы в двух проектах без перевеса — «Без проекта»', () => {
    expect(decide([touch('edit', `${AH}/a`), touch('edit', `${LEDGER}/b`)]).project).toBeNull();
  });

  it('гистерезис: проект меняется, только когда новый лидер вдвое тяжелее; путь старой структуры засчитан', () => {
    const base = [touch('edit', `${LEDGER}/a`), touch('edit', `${LEDGER}/b`)]; // 6
    const more = [...base, touch('edit', `${AH}/a`), touch('edit', `${AH}/b`), touch('edit', `${AH}/c`)]; // AH 9 < 12
    expect(decide(more, LEDGER).project).toBe('01-ledger');
    const twice = [...more, touch('edit', `${AH}/d`)]; // AH 12 ≥ 12
    expect(decide(twice, LEDGER).project).toBe('05-agent-hub');
    expect(decide([touch('edit', '04-systems/16-scanner-fleet/CLAUDE.md')]).project).toBe('02-scanner-fleet');
  });

  it('гистерезис держит проект, пока у него есть вес: без лидера — остаётся; без сигналов — «Без проекта»', () => {
    const ah = (n: number) => Array.from({ length: n }, (_, i) => touch('edit', `${AH}/f${i}`));
    const ledger = (n: number) => Array.from({ length: n }, (_, i) => touch('edit', `${LEDGER}/f${i}`));
    // 6 vs 6: no leader from scratch, the decided one stays
    expect(decide([...ah(2), ...ledger(2)]).project).toBeNull();
    expect(decide([...ah(2), ...ledger(2)], AH).project).toBe('05-agent-hub');
    // the decided project has no weight any more: not kept
    expect(decide([], AH).project).toBeNull();
    expect(decide([touch('read', 'CLAUDE.md')], AH).project).toBeNull();
  });

  it('cron: чтения не весят (задача по расписанию читает входы где угодно); правки, каталог запуска и remote — да', () => {
    const items2 = items;
    const cron = (ts: Touch[], cur: string | null = null) => {
      const d = classify(ts, items2, cur, { cron: true });
      return d.projectId ? items2.get(d.projectId)!.title : null;
    };
    const metrics = '10-work/05-infra/systems/05-metrics';
    expect(cron([touch('read', `${metrics}/postmortem_todo_cache.json`)])).toBeNull();
    expect(cron([touch('read', `${metrics}/x.json`)], metrics)).toBeNull(); // a decision of the old rules is dropped
    expect(cron([touch('read', `${metrics}/x.json`), touch('edit', `${metrics}/x.json`)])).toBe('05-metrics');
    expect(cron([touch('cwd', '10-work/06-tools/systems/04-copilot')])).toBe('04-copilot');
    expect(decide([touch('read', `${metrics}/x.json`)]).project).toBe('05-metrics'); // not cron: the single read decides
  });

  it('основание: «2 правки и 5 чтений», «git remote g/r», склонения', () => {
    expect(evidenceText({ edits: 2, reads: 5, cwd: 0, remote: null }, 'X')).toBe('2 правки и 5 чтений в X');
    expect(evidenceText({ edits: 1, reads: 21, cwd: 1, remote: null }, 'X')).toBe('1 правка и 21 чтение в X, каталог запуска в X');
    expect(evidenceText({ edits: 0, reads: 0, cwd: 0, remote: 'git.example.com/development/scanner/scanner-fleet' }, 'X')).toBe('git remote development/scanner/scanner-fleet');
  });
});
