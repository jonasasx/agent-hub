import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCommand } from './command.js';

describe('resolveCommand', () => {
  let bin: string;
  let other: string;
  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), 'mcp-cmd-bin-'));
    other = await mkdtemp(join(tmpdir(), 'mcp-cmd-other-'));
    // npm on Windows puts an sh shim, a .cmd and a .ps1 side by side
    await writeFile(join(bin, 'codegraph'), '#!/bin/sh\n');
    await writeFile(join(bin, 'codegraph.cmd'), '@echo off\r\n');
    await writeFile(join(bin, 'codegraph.ps1'), '');
    await writeFile(join(other, 'tool'), '#!/bin/sh\n');
  });
  afterEach(async () => {
    await rm(bin, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });

  it('Windows: a bare name gets a PATHEXT extension and skips the extensionless sh shim; Path is matched in any case', () => {
    const env = { Path: `${other};${bin}`, PATHEXT: '.com;.exe;.bat;.cmd' };
    expect(resolveCommand('codegraph', env, 'win32')).toBe(join(bin, 'codegraph.cmd'));
    expect(resolveCommand('codegraph.cmd', env, 'win32')).toBe(join(bin, 'codegraph.cmd'));
    expect(resolveCommand('tool', env, 'win32')).toBeNull();
  });

  it('a command with a directory is checked as is, without a PATH lookup', () => {
    const env = { PATH: bin, PATHEXT: '.cmd' };
    expect(resolveCommand(join(bin, 'codegraph.cmd'), env, 'win32')).toBe(join(bin, 'codegraph.cmd'));
    expect(resolveCommand(join(other, 'missing.cmd'), env, 'win32')).toBeNull();
    expect(resolveCommand(join(other, 'tool'), { PATH: '' }, 'linux')).toBe(join(other, 'tool'));
  });

  // the POSIX PATH separator is a colon, which a Windows temp path (C:\…) contains
  it.skipIf(process.platform === 'win32')('POSIX: a bare name is looked up in PATH without extensions; unknown → null', () => {
    const env = { PATH: `${bin}:${other}` };
    expect(resolveCommand('codegraph', env, 'linux')).toBe(join(bin, 'codegraph'));
    expect(resolveCommand('tool', env, 'linux')).toBe(join(other, 'tool'));
    expect(resolveCommand('npx-missing', env, 'linux')).toBeNull();
  });
});
