// change catalog-db-session-context, D3 (session-project-context): the catalogue text in the session instructions.
import { describe, expect, it } from 'vitest';
import type { ProjectCatalogEntry } from '@agent-hub/shared';
import { PROJECT_CATALOG_HEADER, PROJECT_CATALOG_TEXT_MAX, PROJECT_DESCRIPTION_MAX, renderProjectCatalog } from './projectContext.js';
import { HUB_SYSTEM_PROMPT_APPEND, PEERS_SYSTEM_PROMPT_APPEND, systemPromptAppend } from './sessions/manager.js';

const entry = (n: number, o: Partial<ProjectCatalogEntry> = {}): ProjectCatalogEntry => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `P${n}`,
  description: null,
  remote: null,
  path: null,
  current: false,
  ...o,
});

describe('renderProjectCatalog', () => {
  it('an empty or missing list adds nothing', () => {
    expect(renderProjectCatalog([])).toBe('');
    expect(renderProjectCatalog(undefined)).toBe('');
  });

  it('one line per project, the current one first, newlines replaced, the description cut', () => {
    const text = renderProjectCatalog([
      entry(1, { name: 'Ledger', description: 'учёт\nфинансов', remote: 'https://example.test/l.git', path: 'C:\\work\\ledger' }),
      entry(2, { name: 'Hub', current: true }),
      entry(3, { name: 'Long', description: 'x'.repeat(500) }),
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toBe(PROJECT_CATALOG_HEADER);
    expect(lines[1]).toBe('- Hub (current session project)');
    expect(lines[2]).toBe('- Ledger: учёт финансов; remote https://example.test/l.git; folder C:\\work\\ledger');
    expect(lines[3]).toBe(`- Long: ${'x'.repeat(PROJECT_DESCRIPTION_MAX - 1)}…`);
    expect(lines).toHaveLength(4);
  });

  it('stops adding lines at the text limit', () => {
    const list = Array.from({ length: 200 }, (_, i) => entry(i, { description: 'd'.repeat(PROJECT_DESCRIPTION_MAX) }));
    const text = renderProjectCatalog(list);
    expect(text.length).toBeLessThanOrEqual(PROJECT_CATALOG_TEXT_MAX);
    expect(text.split('\n').length).toBeLessThan(201);
    expect(text.split('\n')[1]).toMatch(/^- P0: /);
  });
});

describe('systemPromptAppend', () => {
  it('appends the catalogue after the hub and peers text; nothing for an empty catalogue', () => {
    expect(systemPromptAppend(false, false, '')).toBe(HUB_SYSTEM_PROMPT_APPEND);
    expect(systemPromptAppend(true, false, 'CATALOG')).toBe(`${HUB_SYSTEM_PROMPT_APPEND}\n\n${PEERS_SYSTEM_PROMPT_APPEND}\n\nCATALOG`);
  });
});
