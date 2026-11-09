// Requirement (file-explorer): Ссылки на файлы — which link targets are files of the machine.
import { describe, expect, it } from 'vitest';
import { fileLinkKind, fileLinkResolver, fileLinkTarget } from './links';

describe('fileLinkTarget', () => {
  const win = 'C:\\Users\\ivan\\vault';
  const unix = '/home/ubuntu/agent-hub';

  it('takes absolute Windows paths with either slash', () => {
    expect(fileLinkTarget('C:\\Users\\ivan\\vault\\AGENTS.md', win, false)).toBe('C:\\Users\\ivan\\vault\\AGENTS.md');
    expect(fileLinkTarget('C:/Users/ivan/x.md', win, false)).toBe('C:\\Users\\ivan\\x.md');
  });

  it('resolves relative paths from the base, folding . and ..', () => {
    expect(fileLinkTarget('openspec/specs/x/spec.md', unix, true)).toBe('/home/ubuntu/agent-hub/openspec/specs/x/spec.md');
    expect(fileLinkTarget('./a/../b.md', unix, true)).toBe('/home/ubuntu/agent-hub/b.md');
    expect(fileLinkTarget('20-personal/AGENTS.md', win, false)).toBe('C:\\Users\\ivan\\vault\\20-personal\\AGENTS.md');
  });

  it('drops the tail of a line number and decodes percent-escapes', () => {
    expect(fileLinkTarget('src/main.ts:42', unix, true)).toBe('/home/ubuntu/agent-hub/src/main.ts');
    expect(fileLinkTarget('src/main.ts:42:7', unix, true)).toBe('/home/ubuntu/agent-hub/src/main.ts');
    expect(fileLinkTarget('INDEX.md:3', unix, true)).toBe('/home/ubuntu/agent-hub/INDEX.md');
    expect(fileLinkTarget('docs/%D0%B1%D1%80%D0%B8%D1%84.md#L10', unix, true)).toBe('/home/ubuntu/agent-hub/docs/бриф.md');
    expect(fileLinkTarget('C:\\x\\a.ts#L3-L9', win, false)).toBe('C:\\x\\a.ts');
  });

  it('takes file URLs of this machine', () => {
    expect(fileLinkTarget('file:///C:/Users/ivan/a.md', win, false)).toBe('C:\\Users\\ivan\\a.md');
    expect(fileLinkTarget('file:///home/u/a.md', unix, true)).toBe('/home/u/a.md');
    expect(fileLinkTarget('file://localhost/home/u/a.md', unix, true)).toBe('/home/u/a.md');
    expect(fileLinkTarget('file://server/share/a.md', unix, true)).toBeNull();
  });

  it('leaves web addresses, anchors and network paths alone', () => {
    for (const href of [
      'https://example.com/a.md',
      'http://x',
      'mailto:a@b.c',
      'tel:123',
      'localhost:3000',
      'javascript:alert(1)',
      '#top',
      '?q=1',
      '//cdn/x.js',
      '\\\\server\\share\\a',
      '',
      undefined,
    ])
      expect(fileLinkTarget(href, unix, true)).toBeNull();
  });

  it('a leading slash is a file only on a machine with Unix paths', () => {
    expect(fileLinkTarget('/home/u/a.md', unix, true)).toBe('/home/u/a.md');
    expect(fileLinkTarget('/api/sessions', win, false)).toBeNull();
  });

  it('a relative path without a base is not a file', () => {
    expect(fileLinkTarget('a.md', null, false)).toBeNull();
  });
});

describe('fileLinkResolver', () => {
  it('gives the session root only to a file inside its folder', () => {
    const r = fileLinkResolver({ runnerId: 'x1', base: 'C:\\vault\\repo', cwd: 'C:\\vault\\repo', sessionId: 's1' });
    expect(r('docs/a.md')).toEqual({ runnerId: 'x1', path: 'C:\\vault\\repo\\docs\\a.md', kind: 'file', sessionId: 's1' });
    expect(r('C:\\Users\\ivan\\.claude\\CLAUDE.md')).toEqual({ runnerId: 'x1', path: 'C:\\Users\\ivan\\.claude\\CLAUDE.md', kind: 'file' });
    expect(r('https://example.com')).toBeNull();
  });

  it('detects Unix paths by the folder of the session', () => {
    const r = fileLinkResolver({ runnerId: 'vm', base: '/home/u/repo', cwd: '/home/u/repo', sessionId: 's2' });
    expect(r('/etc/hosts')).toEqual({ runnerId: 'vm', path: '/etc/hosts', kind: 'unknown' });
  });
});

describe('fileLinkKind', () => {
  it('a trailing slash is a folder', () => {
    expect(fileLinkKind('openspec/specs/')).toBe('dir');
    expect(fileLinkKind('C:\\Users\\ivan\\vault\\')).toBe('dir');
    expect(fileLinkKind('file:///home/u/repo/')).toBe('dir');
  });

  it('a line tail or an extension is a file', () => {
    expect(fileLinkKind('AGENTS.md')).toBe('file');
    expect(fileLinkKind('src/Makefile:12')).toBe('file');
    expect(fileLinkKind('C:\\x\\build#L3')).toBe('file');
    expect(fileLinkKind('C:\\x\\a.ts#L3-L9')).toBe('file');
  });

  it('a name without an extension asks the machine', () => {
    expect(fileLinkKind('C:\\Users\\ivan\\vault')).toBe('unknown');
    expect(fileLinkKind('/home/u/.claude')).toBe('unknown');
    expect(fileLinkKind('Makefile')).toBe('unknown');
    expect(fileLinkKind('C:\\x\\name.')).toBe('unknown');
  });
});
