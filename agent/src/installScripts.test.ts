// macOS ships bash 3.2, which reads a multibyte character right after `$name` as part of the variable name:
// under `set -u` "Скачиваем $file…" fails with "file?: unbound variable". Install scripts must write `${name}` there.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../../deploy/agent/', import.meta.url));

describe('install scripts are safe for bash 3.2', () => {
  for (const name of readdirSync(DIR).filter(f => f.endsWith('.sh'))) {
    it(`${name} has no bare $var followed by a non-ASCII character`, () => {
      const bad = readFileSync(DIR + name, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\t -~]/.test(line))
        .map(({ line, n }) => `${n}: ${line.trim()}`);
      expect(bad).toEqual([]);
    });
  }
});
