// file.restore (design D3 «Восстановление», D8): the hub's one-time link gives the transcript assembled from raw
// S3; it is checked against sha256 and written atomically into the session's project directory (an existing one
// with another case, else enc(cwd)). Requirement: Восстановление .jsonl из S3 перед resume.
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import { CmdError, assertLocalPath } from '../sessions/manager.js';

/** wss://host/ws/agent → https://host (ws:// → http:// for a loopback test hub). */
export function httpBase(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  return u.toString().replace(/\/$/, '');
}

export async function restoreFile(
  p: PayloadOf<HubMessage, 'file.restore'>,
  o: { hubUrl: string; token: string; projectsDir: string; projectDirFor: (cwd: string) => Promise<string>; fetchImpl?: typeof fetch },
): Promise<{ path: string; bytes: number }> {
  assertLocalPath(p.cwd);
  const res = await (o.fetchImpl ?? fetch)(`${httpBase(o.hubUrl)}${p.url}`, { headers: { authorization: `Bearer ${o.token}` } });
  if (!res.ok) throw new CmdError('restore_failed', `hub answered ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== p.sha256) throw new CmdError('restore_failed', 'sha256 mismatch');
  const dir = join(o.projectsDir, await o.projectDirFor(p.cwd));
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${p.sessionId}.jsonl`);
  const tmp = `${target}.restore-${process.pid}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, target);
  return { path: target, bytes: body.length };
}
