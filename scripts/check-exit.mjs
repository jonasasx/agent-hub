// Guard for the test gate: a failing test in any vitest project must make `vitest run` exit non-zero.
// For each project a throwaway failing test is written next to its tests, the project is run alone,
// and the probe is removed. Usage: npm run test:exit-code
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const projects = ['shared', 'hub', 'agent', 'web'];
const probeName = `exit-probe-${process.pid}.test.ts`;
let bad = 0;

for (const project of projects) {
  const rel = `${project}/src/${probeName}`;
  const file = `${root}${rel}`;
  writeFileSync(file, "import { expect, it } from 'vitest';\nit('exit probe fails on purpose', () => expect(1).toBe(2));\n");
  try {
    const r = spawnSync('npx', ['vitest', 'run', '--project', project, rel], { cwd: root, encoding: 'utf8', shell: true });
    const out = `${r.stdout}${r.stderr}`;
    // Non-zero alone is not enough: a startup error also exits 1. The probe itself must have run and failed.
    const ran = /Tests\s+1 failed/.test(out);
    const ok = ran && r.status !== 0 && r.status !== null;
    console.log(`${project}: failing probe -> exit ${r.status}, ${ran ? 'probe failed as expected' : 'probe did not run'} ${ok ? 'ok' : 'WRONG'}`);
    if (!ok) {
      bad++;
      console.log(out.split('\n').slice(-30).join('\n'));
    }
  } finally {
    rmSync(file, { force: true });
  }
}

process.exit(bad === 0 ? 0 : 1);
