import { describe, expect, it } from 'vitest';
import { stripRemoteUserinfo, badPathMessage, isAbsoluteLocalPath, isLocalPosixPath, isLocalWindowsPath, pathFitsPlatform, platformOfHome } from './paths.js';
import { createSessionRequestSchema, statQuerySchema } from './api.js';

describe('local path check (no UNC/device paths: NTLM leak)', () => {
  it.each(['C:\\Users\\alice\\vault', 'c:/work', 'D:\\', 'C:\\a b\\c.d'])('accepts Windows %s', p => {
    expect(isLocalWindowsPath(p)).toBe(true);
    expect(isAbsoluteLocalPath(p)).toBe(true);
  });
  it.each(['/home/ubuntu/vault', '/'])('accepts POSIX %s', p => {
    expect(isLocalPosixPath(p)).toBe(true);
  });
  it.each([
    '\\\\host\\share',
    '//host/share',
    '\\\\?\\UNC\\host\\share',
    '\\\\?\\C:\\x',
    '\\\\.\\pipe\\x',
    '\\??\\C:\\x',
    '/\\host\\share',
    'vault',
    '.\\vault',
    'C:relative',
    'C:\\dir\\CON',
    'C:\\dir\\nul.txt',
    'C:\\a|b',
    '',
  ])('rejects %s', p => {
    expect(isAbsoluteLocalPath(p)).toBe(false);
    expect(pathFitsPlatform(p, 'windows')).toBe(false);
    expect(pathFitsPlatform(p, 'linux')).toBe(false);
  });
  it('the body schemas check only the form (the kind of path is a 422 from the hub)', () => {
    expect(statQuerySchema.safeParse({ path: '\\\\evil\\share' }).success).toBe(true);
    expect(statQuerySchema.safeParse({ path: '' }).success).toBe(false);
    expect(createSessionRequestSchema.safeParse({ runnerId: 'hp', cwd: 'C:\\w', model: 'haiku', prompt: 'x' }).success).toBe(true);
    expect(createSessionRequestSchema.safeParse({ runnerId: 'hp', model: 'haiku', prompt: 'x' }).success).toBe(false);
  });
});

describe('path vs runner platform (M2.1)', () => {
  it('stripRemoteUserinfo: up to the last @ before the first / (a password with @), scp form kept', () => {
    expect(stripRemoteUserinfo('https://oauth2:glpat-x@git.example.com/alice/pos.git')).toBe('https://git.example.com/alice/pos.git');
    expect(stripRemoteUserinfo('https://u:p@ss@host/g/r')).toBe('https://host/g/r');
    expect(stripRemoteUserinfo('https://host/g/a@b')).toBe('https://host/g/a@b');
    expect(stripRemoteUserinfo('git@host:g/r.git')).toBe('git@host:g/r.git');
    expect(stripRemoteUserinfo(null)).toBeNull();
  });

  it('platform from home_dir', () => {
    expect(platformOfHome('C:\\Users\\alice')).toBe('windows');
    expect(platformOfHome('/home/ubuntu')).toBe('linux');
    expect(platformOfHome(null)).toBeNull();
    expect(platformOfHome('weird')).toBeNull();
  });
  it('pathFitsPlatform and badPathMessage', () => {
    expect(pathFitsPlatform('C:\\Users\\alice\\vault', 'linux')).toBe(false);
    expect(pathFitsPlatform('/home/ubuntu', 'windows')).toBe(false);
    expect(pathFitsPlatform('/home/ubuntu', 'linux')).toBe(true);
    expect(pathFitsPlatform('C:\\w', 'windows')).toBe(true);
    expect(pathFitsPlatform('C:\\w', null)).toBe(true);
    expect(pathFitsPlatform('\\\\h\\s', null)).toBe(false);
    expect(badPathMessage('linux')).toEqual({ key: 'hub.files.badPathLinux' });
    expect(badPathMessage('windows')).toEqual({ key: 'hub.files.badPathWindows' });
  });
});
