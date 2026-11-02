// The shell wrapper of a Codex command is dropped from the mirror transcript: the reader sees the script only.
import { describe, expect, it } from 'vitest';
import { toolOf, unwrapShell } from './mirror.js';

const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe('unwrapShell', () => {
  it('PowerShell -Command with a double-quoted script', () => {
    expect(unwrapShell(`"${PS}" -Command "git status --short; Get-Content 'a b.md'"`)).toBe("git status --short; Get-Content 'a b.md'");
  });
  it('escaped quotes inside the script are restored', () => {
    expect(unwrapShell(`"${PS}" -Command "rg -n \\"export f\\" web"`)).toBe('rg -n "export f" web');
  });
  it('single-quoted script, NoProfile and unquoted exe', () => {
    expect(unwrapShell(`${PS} -NoProfile -Command 'npm run typecheck'`)).toBe('npm run typecheck');
    expect(unwrapShell(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command "npm test"`)).toBe('npm test');
  });
  it('bash -lc and cmd /c', () => {
    expect(unwrapShell(`/bin/bash -lc 'ls -la'`)).toBe('ls -la');
    expect(unwrapShell('cmd.exe /c dir')).toBe('dir');
  });
  it('a command that only contains a shell later in the line keeps its start visible', () => {
    for (const c of ['rm -rf x; /usr/bin/pwsh -Command "ls"', 'echo a && C:\\x\\pwsh.exe -Command "b"', "rm -rf x | /bin/bash -lc 'ls'", 'rm x; cmd.exe /c dir']) expect(unwrapShell(c)).toBe(c);
  });
  it('anything else is returned as it is', () => {
    for (const c of ['git status', 'npm ci --engine-strict=false', `"${PS}" -File run.ps1`, '', `"${PS}" -Command "unterminated`]) expect(unwrapShell(c)).toBe(c);
  });
});

describe('toolOf commandExecution', () => {
  it('Bash input holds the script, not the shell wrapper', () => {
    const t = toolOf({ type: 'commandExecution', id: 'x', command: `"${PS}" -Command "npm test"`, cwd: 'C:\\w', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' });
    expect(t?.input).toEqual({ command: 'npm test', cwd: 'C:\\w' });
  });
});
