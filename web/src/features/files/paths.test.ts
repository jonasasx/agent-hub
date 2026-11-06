// Unit tests of the path helpers. Requirements (file-explorer): «↑» не выше домашней папки; «@ В сообщение».
import { describe, expect, it } from 'vitest';
import { ancestorsOf, baseName, isInside, joinPath, mentionText, parentOf, relativeTo, resolveRelative, samePath, segmentsOf, sepOf, trimPath } from './paths';

describe('paths: POSIX', () => {
  it('parent, join, base name', () => {
    expect(parentOf('/home/ivan/agent-hub')).toBe('/home/ivan');
    expect(parentOf('/home')).toBe('/');
    expect(parentOf('/')).toBeNull();
    expect(joinPath('/home/ivan', 'a.md')).toBe('/home/ivan/a.md');
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(baseName('/home/ivan/agent-hub/')).toBe('agent-hub');
  });

  it('inside and relative paths', () => {
    expect(isInside('/home/ivan', '/home/ivan/x/y')).toBe(true);
    expect(isInside('/home/ivan', '/home/ivan')).toBe(true);
    expect(isInside('/home/ivan', '/home/ivan2/x')).toBe(false);
    expect(relativeTo('/home/ivan/agent-hub', '/home/ivan/agent-hub/src/main.ts')).toBe('src/main.ts');
    expect(relativeTo('/home/ivan/agent-hub', '/home/ivan/notes/todo.md')).toBeNull();
  });

  it('ancestors from the root down to the parent of a file', () => {
    expect(ancestorsOf('/a', '/a/b/c/f.ts')).toEqual(['/a', '/a/b', '/a/b/c']);
    expect(ancestorsOf('/a', '/a/f.ts')).toEqual(['/a']);
    expect(ancestorsOf('/a', '/x/f.ts')).toEqual([]);
  });
});

describe('paths: Windows', () => {
  it('detects the separator and compares without case', () => {
    expect(sepOf('C:\\Users\\ivan')).toBe('\\');
    expect(sepOf('/home/ivan')).toBe('/');
    expect(samePath('C:\\Users\\Ivan', 'c:\\users\\ivan\\')).toBe(true);
    expect(isInside('C:\\Users\\ivan', 'c:/users/ivan/x')).toBe(true);
  });

  it('parent stops at the drive root', () => {
    expect(parentOf('C:\\Users\\ivan')).toBe('C:\\Users');
    expect(parentOf('C:\\Users')).toBe('C:\\');
    expect(parentOf('C:\\')).toBeNull();
    expect(trimPath('C:\\')).toBe('C:\\');
    expect(joinPath('C:\\', 'x')).toBe('C:\\x');
    expect(segmentsOf('C:\\Users\\ivan')).toEqual(['Users', 'ivan']);
  });
});

describe('mentionText', () => {
  it('Scenario «@ В сообщение»: relative to the folder of the session', () => {
    expect(mentionText('/home/ivan/agent-hub', '/home/ivan/agent-hub/src/main.ts')).toBe('@src/main.ts');
  });

  it('Scenario «Файл вне папки сессии»: an absolute path', () => {
    expect(mentionText('/home/ivan/agent-hub', '/home/ivan/notes/todo.md')).toBe('@/home/ivan/notes/todo.md');
  });

  it('a session without a folder gets the absolute path', () => {
    expect(mentionText(null, '/home/ivan/a.md')).toBe('@/home/ivan/a.md');
  });
});

describe('resolveRelative', () => {
  it('folds . and .. and keeps the style of the machine', () => {
    expect(resolveRelative('/home/ivan/docs', 'img/a.png')).toBe('/home/ivan/docs/img/a.png');
    expect(resolveRelative('/home/ivan/docs', '../pics/a%20b.png')).toBe('/home/ivan/pics/a b.png');
    expect(resolveRelative('/home/ivan/docs', '/etc/x.png')).toBe('/etc/x.png');
    expect(resolveRelative('C:\\Users\\ivan\\docs', 'a.png')).toBe('C:\\Users\\ivan\\docs\\a.png');
    expect(resolveRelative('C:\\Users\\ivan\\docs', '..\\..\\a.png')).toBe('C:\\Users\\a.png');
  });

  it('cannot climb above the root', () => {
    expect(resolveRelative('/a', '../../../x.png')).toBe('/x.png');
  });
});
