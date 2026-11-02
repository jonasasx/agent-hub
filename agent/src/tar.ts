// Extracts the agent build (.tgz from the hub) without a tar binary: regular files and directories only, paths that
// leave the target are refused. A single top-level folder (npm pack's `package/`) is stripped.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

interface Entry {
  name: string;
  type: 'file' | 'dir';
  data: Buffer;
}

function str(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

export function readTar(tar: Buffer): Entry[] {
  const out: Entry[] = [];
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every(x => x === 0)) break;
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad tar header');
    const flag = String.fromCharCode(h[156]!);
    const prefix = str(h, 345, 155);
    let name = str(h, 0, 100);
    if (prefix && str(h, 257, 6).startsWith('ustar')) name = `${prefix}/${name}`;
    const data = tar.subarray(off + 512, off + 512 + size);
    if (data.length < size) throw new Error('truncated tar');
    off += 512 + Math.ceil(size / 512) * 512;
    if (flag === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (flag === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1]! : null;
      continue;
    }
    if (flag === 'g') continue;
    const full = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    if (flag === '0' || flag === '\0' || flag === '7') out.push({ name: full, type: 'file', data: Buffer.from(data) });
    else if (flag === '5') out.push({ name: full, type: 'dir', data: Buffer.alloc(0) });
    else throw new Error(`unsupported tar entry type ${JSON.stringify(flag)} (${full})`);
  }
  return out;
}

/** Writes the archive into `dest`; returns the relative paths of the files. */
export function extractTgz(tgz: Buffer, dest: string): string[] {
  const entries = readTar(gunzipSync(tgz))
    .map(e => ({
      ...e,
      name: e.name
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/\/+$/, ''),
    }))
    .filter(e => e.name !== '' && e.name !== '.');
  const tops = new Set(entries.map(e => e.name.split('/')[0]));
  const strip = tops.size === 1 && entries.some(e => e.name.includes('/')) && !entries.some(e => e.type === 'file' && !e.name.includes('/'));
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const files: string[] = [];
  for (const e of entries) {
    const rel = strip ? e.name.split('/').slice(1).join('/') : e.name;
    if (!rel) continue;
    if (rel.split('/').some(p => p === '..') || /^([A-Za-z]:|\/)/.test(rel)) throw new Error(`unsafe path in archive: ${e.name}`);
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`unsafe path in archive: ${e.name}`);
    if (e.type === 'dir') mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data);
      files.push(rel);
    }
  }
  return files;
}
