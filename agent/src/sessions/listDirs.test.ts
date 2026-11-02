import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listDirectories } from './listDirs.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('listDirectories', () => {
  it('lists only immediate directories, hides dot directories by default, and returns canonical paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-picker-'));
    await mkdir(join(root, 'visible'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'file.txt'), 'secret file content');
    const ordinary = await listDirectories(root, false);
    const canonical = await realpath(root);
    expect(ordinary.directories).toEqual([{ name: 'visible', path: join(canonical, 'visible') }]);
    expect((await listDirectories(root, true)).directories).toHaveLength(2);
    expect(ordinary.path).toBe(canonical);
    expect(ordinary.parent).toBeTruthy();
  });
  it('uses home for an empty path and rejects missing files and non-directories with stable codes', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-picker-'));
    const file = join(root, 'file');
    await writeFile(file, 'x');
    expect((await listDirectories('', false, root)).path).toBe(await realpath(root));
    await expect(listDirectories(join(root, 'missing'), false)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listDirectories(file, false)).rejects.toMatchObject({ code: 'not_directory' });
  });
  it('enforces the 500 directory limit', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-picker-'));
    await Promise.all(Array.from({ length: 501 }, (_, i) => mkdir(join(root!, `d${i}`))));
    await expect(listDirectories(root, false)).rejects.toMatchObject({ code: 'too_many_entries' });
  });
  it('rejects remote, device, relative, and NUL paths before filesystem resolution', async () => {
    for (const invalid of ['\\\\attacker\\share', '\\\\?\\C:\\Users', '\\\\.\\pipe\\x', 'relative\\folder', 'C:\\bad\0path']) {
      await expect(listDirectories(invalid, false)).rejects.toMatchObject({ code: 'invalid_path' });
    }
  });
});
