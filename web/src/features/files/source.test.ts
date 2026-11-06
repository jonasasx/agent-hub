// Unit tests of the source and the root of the «Файлы» window. Requirements (file-explorer): Окно «Файлы» и источники; Совместимость со старым агентом.
import { describe, expect, it } from 'vitest';
import { RUNNERS, runner, session } from '../../test/factories';
import { defaultMachine, resolveSource, runnerSupportsFiles, upFrom } from './source';

describe('source', () => {
  it('the protocol version decides until the hub says otherwise', () => {
    expect(runnerSupportsFiles({ id: 'a', protocolVersion: '1.13' })).toBe(false);
    expect(runnerSupportsFiles({ id: 'a', protocolVersion: '1.14' })).toBe(true);
    expect(runnerSupportsFiles({ id: 'a', protocolVersion: '2.0' })).toBe(true);
    expect(runnerSupportsFiles({ id: 'a', protocolVersion: null })).toBe(true);
    expect(runnerSupportsFiles({ id: 'a', protocolVersion: '1.14' }, { a: true })).toBe(false);
  });

  it('the session chip has the cwd as the root; «↑» goes one level up, never above home', () => {
    const s = session({ cwd: 'C:\\Users\\alice\\vault\\proj' });
    const base = { choice: { kind: 'session' } as const, sessionId: s.id, sessions: { [s.id]: s }, runners: RUNNERS, outdated: {} };
    const a = resolveSource({ ...base, rootUp: {} })!;
    expect(a.mode).toBe('session');
    expect(a.root).toBe('C:\\Users\\alice\\vault\\proj');
    expect(a.up).toBe('C:\\Users\\alice\\vault');
    const b = resolveSource({ ...base, rootUp: { [a.key]: 'C:\\Users\\alice' } })!;
    expect(b.root).toBe('C:\\Users\\alice');
    expect(b.up).toBeNull();
  });

  it('a machine chip has the home folder as the root and no «↑»', () => {
    const r = resolveSource({ choice: { kind: 'machine', runnerId: 'vm' }, sessionId: null, sessions: {}, runners: RUNNERS, rootUp: {}, outdated: {} })!;
    expect(r.mode).toBe('machine');
    expect(r.root).toBe('/home/ubuntu');
    expect(r.up).toBeNull();
  });

  it('without a session the first online machine is taken; none at all gives null', () => {
    const src = resolveSource({ choice: { kind: 'session' }, sessionId: null, sessions: {}, runners: RUNNERS, rootUp: {}, outdated: {} })!;
    expect(src.runnerId).toBe('x1');
    expect(defaultMachine([runner({ id: 'o', protocolVersion: '1.0' }), runner({ id: 'n', protocolVersion: '1.14' })], {})!.id).toBe('n');
    expect(resolveSource({ choice: { kind: 'session' }, sessionId: null, sessions: {}, runners: [], rootUp: {}, outdated: {} })).toBeNull();
  });

  it('upFrom is off outside the home folder', () => {
    expect(upFrom('/etc', '/home/a')).toBeNull();
    expect(upFrom('/home/a/b/c', '/home/a')).toBe('/home/a/b');
    expect(upFrom(null, '/home/a')).toBeNull();
  });

  it('an old agent is marked unsupported', () => {
    const r = resolveSource({ choice: { kind: 'machine', runnerId: 'x1' }, sessionId: null, sessions: {}, runners: [runner({ protocolVersion: '1.9' })], rootUp: {}, outdated: {} })!;
    expect(r.supported).toBe(false);
  });
});
