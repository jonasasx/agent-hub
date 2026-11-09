import { describe, expect, it } from 'vitest';
import { normalizeProjectFolder, projectDir, relativeFolder } from './folders.js';

describe('project folders (session-folder D2)', () => {
  it('normalizes separators and edges; empty is no folder', () => {
    expect(normalizeProjectFolder('work\\infra\\repos\\dns\\')).toBe('work/infra/repos/dns');
    expect(normalizeProjectFolder(' a//b/ ')).toBe('a/b');
    expect(normalizeProjectFolder('')).toBeNull();
    expect(normalizeProjectFolder(null)).toBeNull();
  });

  it.each(['/etc', 'C:\\Windows', 'c:x', '\\\\host\\share', '../secret', 'a/./b', 'a/../../b', 'a|b', 'x'.repeat(1001)])('rejects %s', v => {
    expect(() => normalizeProjectFolder(v)).toThrow();
  });

  it('joins the default folder and the project folder with the machine separator', () => {
    expect(projectDir('C:\\Users\\f\\vault', 'work/repos/dns', true)).toBe('C:\\Users\\f\\vault\\work\\repos\\dns');
    expect(projectDir('C:\\Users\\f\\', 'a', true)).toBe('C:\\Users\\f\\a');
    expect(projectDir('/home/f/vault', 'work/repos/dns', false)).toBe('/home/f/vault/work/repos/dns');
    expect(projectDir('/home/f/', 'a', false)).toBe('/home/f/a');
    expect(projectDir('/home/f', null, false)).toBe('/home/f');
  });

  it('turns a path inside the root into a project folder, outside — null', () => {
    expect(relativeFolder('C:\\Users\\f\\vault', 'c:\\users\\f\\Vault\\repos\\dns', true)).toBe('repos/dns');
    expect(relativeFolder('C:\\Users\\f\\vault\\', 'C:\\Users\\f\\vault', true)).toBe('');
    expect(relativeFolder('/home/f/vault', '/home/f/vault', false)).toBe('');
    expect(relativeFolder('/home/f/vault', '/home/f/vaultx/a', false)).toBeNull();
    expect(relativeFolder('/home/f/vault', '/home/F/vault/a', false)).toBeNull();
  });
});
