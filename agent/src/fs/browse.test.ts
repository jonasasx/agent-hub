// Tasks 2.1-2.3: path safety, fs.list and fs.read of the read-only file explorer.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FS_LIST_LIMIT, FS_TEXT_MAX } from '@agent-hub/shared';
import { assertBrowsablePath, classifyFile, FsError, isInsideRoot, listFolder, readFileForView, resolveInside } from './browse.js';

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    return error instanceof FsError ? error.code : `other:${(error as Error).message}`;
  }
  return 'ok';
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 2)]);

let base: string;
let root: string;
let outside: string;
let linksWork = true;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'agent-fsbrowse-')));
  root = join(base, 'proj');
  outside = join(base, 'proj2');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'other project');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'env.ts'), 'export const a = 1;');
  await writeFile(join(root, 'ssh.md'), '# ssh notes');
  await writeFile(join(root, 'readme.txt'), 'hello');
  await writeFile(join(root, '.env'), 'TOKEN=abc');
  await writeFile(join(root, '.env.local'), 'TOKEN=abc');
  await writeFile(join(root, 'id_ed25519'), 'KEY');
  await writeFile(join(root, 'cert.pem'), 'PEM');
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'config'), 'Host *');
  await writeFile(join(root, '.hidden'), 'h');
  await writeFile(join(root, 'pic.png'), PNG);
  await writeFile(join(root, 'doc.pdf'), PDF);
  await writeFile(join(root, 'vec.svg'), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0xff, 0xfe]));
  await writeFile(join(root, 'zero.txt'), Buffer.from('abc\u0000def'));
  await writeFile(join(root, 'fakepng.png'), 'this is text, not a png');
  await writeFile(join(root, 'Привет.md'), '# Привет');
  try {
    await symlink(outside, join(root, 'linkdir'), 'junction');
    await symlink(join(outside, 'secret.txt'), join(root, 'linkfile'), 'file');
    await symlink(join(root, 'readme.txt'), join(root, 'linkinside'), 'file');
    await symlink(join(root, 'id_ed25519'), join(root, 'linksecret'), 'file');
    await symlink(join(root, 'nowhere'), join(root, 'linkbroken'), 'file');
  } catch {
    linksWork = false; // Windows without the symlink privilege
  }
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('isInsideRoot', () => {
  it('cuts by whole segments, not by prefix', () => {
    expect(isInsideRoot('/a/proj', '/a/proj', false)).toBe(true);
    expect(isInsideRoot('/a/proj', '/a/proj/x/y', false)).toBe(true);
    expect(isInsideRoot('/a/proj', '/a/proj2', false)).toBe(false);
    expect(isInsideRoot('/a/proj', '/a/proj2/x', false)).toBe(false);
    expect(isInsideRoot('/a/proj', '/a', false)).toBe(false);
    expect(isInsideRoot('/a/proj', '/a/proj/../x', false)).toBe(false);
  });
  it('ignores case on Windows only', () => {
    expect(isInsideRoot('C:\\Users\\Ivan\\Proj', 'c:\\users\\ivan\\proj\\file.txt', true)).toBe(true);
    expect(isInsideRoot('C:\\Users\\Ivan\\Proj', 'C:\\Users\\Ivan\\Proj2', true)).toBe(false);
    expect(isInsideRoot('C:\\Users\\Ivan\\Proj', 'D:\\Users\\Ivan\\Proj\\x', true)).toBe(false);
    expect(isInsideRoot('/a/Proj', '/a/proj/x', false)).toBe(false);
  });
});

describe('assertBrowsablePath', () => {
  const win = { win32: true };
  const posix = { win32: false };
  it('refuses relative, ".." , UNC, device and NUL paths', () => {
    for (const bad of ['', 'relative/path', '/a/../b', '//host/share', '/a\u0000b', '/a\\b']) expect(() => assertBrowsablePath(bad, posix)).toThrow(FsError);
    for (const bad of ['C:\\a\\..\\b', '\\\\host\\share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'rel\\path', 'C:\\a\u0000b', '/posix/path', 'C:\\dir\\NUL']) {
      expect(() => assertBrowsablePath(bad, win)).toThrow(FsError);
    }
    expect(() => assertBrowsablePath('/a/b', posix)).not.toThrow();
    expect(() => assertBrowsablePath('C:\\a\\b', win)).not.toThrow();
  });
});

describe('resolveInside', () => {
  it('accepts the root and files inside; the code of a missing path is not_found', async () => {
    expect((await resolveInside(root, root)).real).toBe(root);
    expect((await resolveInside(join(root, 'readme.txt'), root)).real).toBe(join(root, 'readme.txt'));
    expect(await code(resolveInside(join(root, 'absent.txt'), root))).toBe('not_found');
  });
  it('refuses ".." even when it would end inside, and a sibling that shares the prefix', async () => {
    expect(await code(resolveInside(`${root}/src/../readme.txt`, root))).toBe('invalid_path');
    expect(await code(resolveInside(`${root}/../.ssh/id_ed25519`, root))).toBe('invalid_path');
    expect(await code(resolveInside(outside, root))).toBe('outside_root');
    expect(await code(resolveInside(join(outside, 'secret.txt'), root))).toBe('outside_root');
    expect(await code(resolveInside(base, root))).toBe('outside_root');
  });
  it('refuses relative paths and NUL', async () => {
    expect(await code(resolveInside('src/env.ts', root))).toBe('invalid_path');
    expect(await code(resolveInside(`${root}\u0000/x`, root))).toBe('invalid_path');
    expect(await code(resolveInside(root, 'relative'))).toBe('invalid_path');
  });
  it('closes secret paths regardless of the root, and keeps src/env.ts and ssh.md open', async () => {
    for (const name of ['.env', '.env.local', 'id_ed25519', 'cert.pem', '.ssh', join('.ssh', 'config')]) {
      expect(await code(resolveInside(join(root, name), root)), name).toBe('restricted');
    }
    expect(await code(resolveInside(join(root, 'src', 'env.ts'), root))).toBe('ok');
    expect(await code(resolveInside(join(root, 'ssh.md'), root))).toBe('ok');
  });
  it('answers restricted before it looks at the disk (a secret that does not exist looks the same)', async () => {
    expect(await code(resolveInside(join(root, '.ssh', 'absent'), root))).toBe('restricted');
    expect(await code(resolveInside(join(root, '.aws', 'credentials'), root))).toBe('restricted');
  });
  it.skipIf(process.platform === 'win32')('a FIFO is not_file and does not block open()', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(await code(readFileForView(join(root, 'pipe'), root))).toBe('not_file');
  });
  it('compares the root case-insensitively on Windows only', async () => {
    if (process.platform !== 'win32') return;
    const swapped = root.replace(/proj$/, 'PROJ');
    expect((await resolveInside(join(swapped, 'readme.txt'), swapped)).real.toLowerCase()).toBe(join(root, 'readme.txt').toLowerCase());
  });
  it('refuses a symlink that leaves the root and one that leads to a secret', async () => {
    if (!linksWork) return;
    expect(await code(resolveInside(join(root, 'linkdir'), root))).toBe('outside_root');
    expect(await code(resolveInside(join(root, 'linkdir', 'secret.txt'), root))).toBe('outside_root');
    expect(await code(resolveInside(join(root, 'linkfile'), root))).toBe('outside_root');
    expect(await code(resolveInside(join(root, 'linksecret'), root))).toBe('restricted');
    expect(await code(resolveInside(join(root, 'linkinside'), root))).toBe('ok');
  });
});

describe('listFolder', () => {
  it('lists one level: folders first, then files, case-insensitive; hidden and secret files hidden by default', async () => {
    const r = await listFolder(root, root, false);
    expect(r.path).toBe(root);
    const names = r.entries.map(e => e.name);
    expect(names[0]).toBe('src');
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('.env');
    const files = names.filter(n => !['src', 'linkdir'].includes(n));
    const folded = files.map(n => n.toLowerCase());
    expect(folded).toEqual([...folded].sort());
    expect(r.entries.find(e => e.name === 'readme.txt')).toMatchObject({ kind: 'file', size: 5 });
    expect(r.truncated).toBe(false);
  });
  it('shows hidden entries on request and marks secrets restricted, without size', async () => {
    const r = await listFolder(root, root, true);
    expect(r.entries.find(e => e.name === '.hidden')).toMatchObject({ kind: 'file', size: 1 });
    for (const n of ['.env', '.env.local', 'id_ed25519', 'cert.pem', '.ssh']) {
      const e = r.entries.find(x => x.name === n);
      expect(e, n).toMatchObject({ blocked: 'restricted' });
      expect(e?.size).toBeUndefined();
    }
  });
  it('blocks a symlink out of the root and to a secret, leaves an inner and a broken one open', async () => {
    if (!linksWork) return;
    const r = await listFolder(root, root, false);
    expect(r.entries.find(e => e.name === 'linkdir')).toMatchObject({ blocked: 'outside_root' });
    expect(r.entries.find(e => e.name === 'linkfile')).toMatchObject({ kind: 'symlink', blocked: 'outside_root' });
    expect(r.entries.find(e => e.name === 'linksecret')).toMatchObject({ kind: 'symlink', blocked: 'restricted' });
    expect(r.entries.find(e => e.name === 'linkinside')).toEqual({ name: 'linkinside', kind: 'symlink' });
    expect(r.entries.find(e => e.name === 'linkbroken')).toEqual({ name: 'linkbroken', kind: 'symlink' });
  });
  it('cuts a folder of 5000 entries at the limit with truncated and total', async () => {
    const big = join(root, 'big');
    await mkdir(big);
    await Promise.all(Array.from({ length: 5000 }, (_, i) => writeFile(join(big, `f${String(i).padStart(4, '0')}.txt`), 'x')));
    const r = await listFolder(big, root, false);
    expect(r.entries).toHaveLength(FS_LIST_LIMIT);
    expect(r.total).toBe(5000);
    expect(r.truncated).toBe(true);
    expect(r.entries[0]!.name).toBe('f0000.txt');
    expect(r.entries[FS_LIST_LIMIT - 1]!.name).toBe(`f${String(FS_LIST_LIMIT - 1).padStart(4, '0')}.txt`);
  });
  it('answers not_found, not_directory, outside_root, restricted', async () => {
    expect(await code(listFolder(join(root, 'absent'), root, false))).toBe('not_found');
    expect(await code(listFolder(join(root, 'readme.txt'), root, false))).toBe('not_directory');
    expect(await code(listFolder(outside, root, false))).toBe('outside_root');
    expect(await code(listFolder(join(root, '.ssh'), root, true))).toBe('restricted');
  });
});

describe('classifyFile', () => {
  it('knows images, pdf and svg by extension and signature', () => {
    expect(classifyFile('a.png', PNG)).toEqual({ kind: 'image', mime: 'image/png' });
    expect(classifyFile('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]))).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(classifyFile('a.gif', Buffer.from('GIF89a....'))).toEqual({ kind: 'image', mime: 'image/gif' });
    expect(classifyFile('a.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toEqual({ kind: 'image', mime: 'image/webp' });
    expect(classifyFile('a.pdf', PDF)).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(classifyFile('a.svg', Buffer.from('<svg xmlns="x"/>'))).toEqual({ kind: 'image', mime: 'image/svg+xml' });
  });
  it('does not trust the extension: a text with .png is text, a binary with .txt is binary', () => {
    expect(classifyFile('a.png', Buffer.from('plain')).kind).toBe('text');
    expect(classifyFile('a.pdf', Buffer.from([0, 1, 2])).kind).toBe('binary');
    expect(classifyFile('a.txt', Buffer.from([0xff, 0xfe, 0x00])).kind).toBe('binary');
    expect(classifyFile('a.svg', Buffer.from('<html><script>1</script></html>')).kind).toBe('text');
  });
  it('tolerates a UTF-8 character cut at the end of the head', () => {
    const cut = Buffer.from('привет', 'utf8').subarray(0, 5);
    expect(classifyFile('a.txt', cut).kind).toBe('text');
  });
  it('class markdown by .md and .markdown', () => {
    expect(classifyFile('a.MD', Buffer.from('# x')).kind).toBe('markdown');
    expect(classifyFile('a.markdown', Buffer.from('# x')).kind).toBe('markdown');
  });
});

describe('readFileForView', () => {
  it('returns text and markdown in the answer', async () => {
    const t = await readFileForView(join(root, 'readme.txt'), root);
    expect(t.result).toMatchObject({ kind: 'text', mime: 'text/plain', size: 5, text: 'hello' });
    expect(t.data).toBeUndefined();
    const m = await readFileForView(join(root, 'Привет.md'), root);
    expect(m.result).toMatchObject({ kind: 'markdown', text: '# Привет' });
  });
  it('returns image and pdf as bytes with binary: true and no text', async () => {
    const i = await readFileForView(join(root, 'pic.png'), root);
    expect(i.result).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length, binary: true });
    expect(i.result.text).toBeUndefined();
    expect(i.data?.equals(PNG)).toBe(true);
    const p = await readFileForView(join(root, 'doc.pdf'), root);
    expect(p.result).toMatchObject({ kind: 'pdf', binary: true });
    expect(p.data?.equals(PDF)).toBe(true);
    expect((await readFileForView(join(root, 'vec.svg'), root)).result).toMatchObject({ kind: 'image', mime: 'image/svg+xml', binary: true });
  });
  it('gives metadata only for a binary file and for a text with NUL or broken UTF-8 later in the file', async () => {
    const b = await readFileForView(join(root, 'blob.bin'), root);
    expect(b.result).toMatchObject({ kind: 'binary', size: 6 });
    expect(b.data).toBeUndefined();
    expect(b.result.binary).toBeUndefined();
    expect((await readFileForView(join(root, 'zero.txt'), root)).result.kind).toBe('binary');
    const late = join(root, 'late.txt');
    await writeFile(late, Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0xff, 0xfe])]));
    expect((await readFileForView(late, root)).result.kind).toBe('binary');
  });
  it('treats a fake png as text', async () => {
    expect((await readFileForView(join(root, 'fakepng.png'), root)).result).toMatchObject({ kind: 'text', text: 'this is text, not a png' });
  });
  it('refuses a text over 2 MiB and a media over 20 MiB before reading', async () => {
    const big = join(root, 'big.txt');
    await writeFile(big, Buffer.alloc(FS_TEXT_MAX + 1, 0x61));
    expect(await code(readFileForView(big, root))).toBe('too_large');
    await writeFile(join(root, 'ok.txt'), Buffer.alloc(FS_TEXT_MAX, 0x61));
    expect((await readFileForView(join(root, 'ok.txt'), root)).result.size).toBe(FS_TEXT_MAX);
    const hugePdf = join(root, 'huge.pdf');
    await writeFile(hugePdf, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(20 * 1024 * 1024)]));
    expect(await code(readFileForView(hugePdf, root))).toBe('too_large');
  });
  it('reads at most the limit even when the file grows after the check (read cap)', async () => {
    const grow = join(root, 'grow.txt');
    await writeFile(grow, Buffer.alloc(FS_TEXT_MAX - 10, 0x61));
    const first = readFileForView(grow, root);
    await appendFile(grow, Buffer.alloc(100, 0x62));
    const r = await code(first);
    expect(['ok', 'too_large']).toContain(r);
  });
  it('answers not_file for a folder, not_found, restricted, outside_root', async () => {
    expect(await code(readFileForView(join(root, 'src'), root))).toBe('not_file');
    expect(await code(readFileForView(join(root, 'absent.txt'), root))).toBe('not_found');
    expect(await code(readFileForView(join(root, '.env'), root))).toBe('restricted');
    expect(await code(readFileForView(join(outside, 'secret.txt'), root))).toBe('outside_root');
    if (linksWork) expect(await code(readFileForView(join(root, 'linkfile'), root))).toBe('outside_root');
  });
  it('the error message carries no path', async () => {
    try {
      await readFileForView(join(root, 'absent.txt'), root);
    } catch (error) {
      expect((error as Error).message).not.toContain('absent');
    }
  });
});
