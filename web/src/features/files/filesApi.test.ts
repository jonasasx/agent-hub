// Unit tests of the client of the file routes. Requirements (file-explorer): Просмотрщик; Машина не в сети и ошибки; Совместимость со старым агентом.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsError, fsFileUrl, fsList, fsListUrl, fsOpenFile, isUnsupported, limitFor } from './filesApi';
import { dir, stubFs } from './testkit';

afterEach(() => vi.unstubAllGlobals());

describe('filesApi', () => {
  it('builds URLs without a root: path, session and hidden only', () => {
    expect(fsListUrl('x 1', {})).toBe('/api/runners/x%201/fs/list');
    expect(fsListUrl('x1', { path: '/a b', sessionId: 's', hidden: true })).toBe('/api/runners/x1/fs/list?path=%2Fa+b&sessionId=s&hidden=1');
    expect(fsFileUrl('x1', '/a.md', 's')).not.toContain('root');
  });

  it('lists a folder', async () => {
    stubFs({ list: { '/p': dir('/p', ['a.md']) }, files: {} });
    const r = await fsList('x1', { path: '/p' });
    expect(r.entries[0]!.name).toBe('a.md');
  });

  it('capability_unavailable says to update the agent', async () => {
    stubFs({ list: { '/p': { error: 'capability_unavailable', status: 409 } }, files: {} });
    const err = await fsList('x1', { path: '/p' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsError);
    expect((err as FsError).code).toBe('capability_unavailable');
    expect((err as FsError).text()).toBe('Обновите агента');
  });

  it('a network failure and a bad answer are client codes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(fsList('x1')).rejects.toMatchObject({ code: 'network' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ nope: 1 })));
    await expect(fsList('x1')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('a 504 without a body is a timeout of the machine', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gateway', { status: 504 })));
    await expect(fsList('x1')).rejects.toMatchObject({ code: 'agent_timeout' });
  });

  it('the file answer carries the class and the size; 415 is the binary class', async () => {
    stubFs({
      list: {},
      files: { '/a.md': { kind: 'markdown', body: '# hi' }, '/b.bin': { status: 415, json: { error: 'unsupported', kind: 'binary', size: 5, mime: 'application/zip' } } },
    });
    const f = await fsOpenFile('x1', '/a.md');
    expect(isUnsupported(f)).toBe(false);
    if (!isUnsupported(f)) {
      expect(f.kind).toBe('markdown');
      expect(await f.response.text()).toBe('# hi');
    }
    const b = await fsOpenFile('x1', '/b.bin');
    expect(b).toEqual({ unsupported: true, size: 5, mime: 'application/zip' });
  });

  it('too_large is an error of the hub; limits by class', async () => {
    stubFs({ list: {}, files: { '/big.txt': { status: 413, json: { error: 'too_large' } } } });
    await expect(fsOpenFile('x1', '/big.txt')).rejects.toMatchObject({ code: 'too_large' });
    expect(limitFor('text')).toBe(2 * 1024 * 1024);
    expect(limitFor('pdf')).toBe(20 * 1024 * 1024);
    expect(limitFor('binary')).toBeNull();
  });

  it('a caller abort is reported as aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort'))))),
    );
    const ctl = new AbortController();
    const p = fsList('x1', {}, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });
});
