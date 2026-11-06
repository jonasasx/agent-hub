// Requirement: Безопасный доступ к файлам машины (secret paths); контракты fs.list / fs.read.
import { describe, expect, it } from 'vitest';
import {
  FS_ERROR_CODES,
  FS_ERROR_STATUS,
  FS_LIST_LIMIT,
  FS_MEDIA_MAX,
  FS_TEXT_MAX,
  FS_HUB_ERROR_CODES,
  fsEntrySchema,
  fsFileQuerySchema,
  fsListPayload,
  fsListQuerySchema,
  fsListResultSchema,
  fsMaxBytes,
  fsReadPayload,
  fsReadResultSchema,
  isRestrictedPath,
} from './index.js';

describe('fs limits', () => {
  it('has the agreed values', () => {
    expect(FS_LIST_LIMIT).toBe(1000);
    expect(FS_TEXT_MAX).toBe(2 * 1024 * 1024);
    expect(FS_MEDIA_MAX).toBe(20 * 1024 * 1024);
    expect(fsMaxBytes('markdown')).toBe(FS_TEXT_MAX);
    expect(fsMaxBytes('pdf')).toBe(FS_MEDIA_MAX);
    expect(fsMaxBytes('binary')).toBeNull();
  });
  it('maps every error code to an HTTP status', () => {
    for (const code of [...FS_ERROR_CODES, ...FS_HUB_ERROR_CODES]) expect(FS_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(FS_ERROR_STATUS.too_large).toBe(413);
    expect(FS_ERROR_STATUS.agent_timeout).toBe(504);
  });
});

describe('fs.list / fs.read schemas', () => {
  it('accepts valid requests', () => {
    expect(fsListPayload.safeParse({ path: '/home/a', root: '/home/a' }).success).toBe(true);
    expect(fsListPayload.safeParse({ path: 'C:\\Users\\a', root: 'C:\\Users\\a', showHidden: true }).success).toBe(true);
    expect(fsReadPayload.safeParse({ path: '/home/a/x.md', root: '/home/a' }).success).toBe(true);
  });
  it.each([[{ path: '', root: '/a' }], [{ path: '/a' }], [{ path: '/a', root: '/a', showHidden: 'yes' }], [{ path: 'x'.repeat(4097), root: '/a' }]])('rejects the invalid list request %j', body => {
    expect(fsListPayload.safeParse(body).success).toBe(false);
  });
  it('rejects a read without a root', () => {
    expect(fsReadPayload.safeParse({ path: '/a/b' }).success).toBe(false);
  });
  it('accepts a list result and rejects a bad entry or too many entries', () => {
    const entry = { name: 'src', kind: 'dir' as const };
    expect(fsListResultSchema.safeParse({ path: '/a', entries: [entry, { name: 'k', kind: 'symlink', blocked: 'outside_root' }], truncated: false, total: 2 }).success).toBe(true);
    expect(fsEntrySchema.safeParse({ name: 'a', kind: 'socket' }).success).toBe(false);
    expect(fsEntrySchema.safeParse({ name: 'a', kind: 'file', blocked: 'nope' }).success).toBe(false);
    const many = Array.from({ length: FS_LIST_LIMIT + 1 }, (_, i) => ({ name: `f${i}`, kind: 'file' as const }));
    expect(fsListResultSchema.safeParse({ path: '/a', entries: many, truncated: true, total: 5000 }).success).toBe(false);
  });
  it('accepts read results of every class and rejects an unknown class', () => {
    const base = { path: '/a/x', mime: 'text/plain', size: 3, mtimeMs: 1 };
    expect(fsReadResultSchema.safeParse({ ...base, kind: 'text', text: 'abc' }).success).toBe(true);
    expect(fsReadResultSchema.safeParse({ ...base, kind: 'image', mime: 'image/png', binary: true }).success).toBe(true);
    expect(fsReadResultSchema.safeParse({ ...base, kind: 'binary', mime: 'application/octet-stream' }).success).toBe(true);
    expect(fsReadResultSchema.safeParse({ ...base, kind: 'video' }).success).toBe(false);
    expect(fsReadResultSchema.safeParse({ ...base, kind: 'pdf', binary: false }).success).toBe(false);
  });
});

describe('HTTP queries', () => {
  const SID = '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d';
  it('parses fs/list and fs/file queries', () => {
    expect(fsListQuerySchema.safeParse({}).success).toBe(true);
    expect(fsListQuerySchema.safeParse({ path: '/a', sessionId: SID, hidden: '1' }).success).toBe(true);
    expect(fsListQuerySchema.safeParse({ hidden: 'true' }).success).toBe(false);
    expect(fsListQuerySchema.safeParse({ sessionId: 'x' }).success).toBe(false);
    expect(fsFileQuerySchema.safeParse({ path: '/a/b.png' }).success).toBe(true);
    expect(fsFileQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('isRestrictedPath', () => {
  it.each([
    '/home/a/.ssh',
    '/home/a/.ssh/id_ed25519',
    'C:\\Users\\a\\.SSH\\config',
    '/home/a/.env',
    '/home/a/proj/.env.local',
    '/home/a/proj/.ENV.production',
    '/home/a/id_ed25519',
    '/home/a/id_rsa.pub',
    '/home/a/id_ecdsa',
    '/home/a/.claude/.credentials.json',
    'C:\\Users\\a\\.claude\\.credentials.json',
    '/home/a/.codex/auth.json',
    '/home/a/.aws/credentials',
    '/home/a/.gnupg/pubring.kbx',
    '/home/a/.kube/config',
    '/home/a/.agent-hub/credentials.json',
    '/home/a/.npmrc',
    '/home/a/.netrc',
    '/home/a/.git-credentials',
    '/home/a/.pgpass',
    '/home/a/.claude.json',
    '/home/a/.config/gh/hosts.yml',
    '/home/a/.docker/config.json',
    '/srv/certs/server.pem',
    '/srv/certs/tls.key',
  ])('closes %s', p => {
    expect(isRestrictedPath(p)).toBe(true);
  });
  it.each([
    '/home/a/proj/src/env.ts',
    '/home/a/proj/ssh.md',
    '/home/a/proj/environment',
    '/home/a/.claude/settings.json',
    '/home/a/.config/git/config',
    '/home/a/.docker/daemon.json',
    '/home/a/proj/keyboard.ts',
    '/home/a/proj/npmrc.md',
    '/home/a/.claude.jsonl.md',
    '/home/a/proj/id_card.md',
    '/home/a/proj',
    '/',
  ])('leaves %s open', p => {
    expect(isRestrictedPath(p)).toBe(false);
  });
});
