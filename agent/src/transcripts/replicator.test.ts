// Task 3.3 (agent side): discovery, transcript list, one key for C--/c-- directories, priority and rate limit,
// rewrite, ack timeout; integration: catch-up after a disconnect without duplicates.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { fileKey, filesPages, Replicator } from './replicator.js';

const root = mkdtempSync(join(tmpdir(), 'agenthub-repl-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const log = createLogger({ level: 'error', write: () => undefined });

function setup(name: string, o: { maxBytesPerSec?: number; windows?: boolean; cronMarkersFile?: string; remote?: string } = {}) {
  const projects = join(root, name);
  mkdirSync(projects, { recursive: true });
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let now = 1_000_000;
  const r = new Replicator({
    projectsDir: projects,
    send: (type, payload) => (sent.push({ type, payload: payload as Record<string, unknown> }), true),
    log,
    maxBytesPerSec: o.maxBytesPerSec ?? 10 * 1024 * 1024,
    watch: false,
    windows: o.windows ?? true,
    now: () => now,
    gitInfo: () => Promise.resolve({ remote: o.remote ?? 'git@git.example.com:alice/agent-hub.git' }),
    ...(o.cronMarkersFile ? { cronMarkersFile: o.cronMarkersFile } : {}),
  });
  return { r, sent, projects, advance: (ms: number) => (now += ms) };
}

const line = (sid: string, n: number) => JSON.stringify({ type: 'user', sessionId: sid, cwd: 'C:\\Users\\alice\\vault', gitBranch: 'master', message: { content: `m${n}` } });
const chunks = (sent: Array<{ type: string; payload: Record<string, unknown> }>) => sent.filter(m => m.type === 'repl.chunk').map(m => m.payload);

describe('Replicator', () => {
  it('finds main and subagent transcripts, sends repl.files after welcome, then chunks and repl.meta', async () => {
    const { r, sent, projects } = setup('discover');
    const sid = randomUUID();
    mkdirSync(join(projects, 'c--Users-alice-vault', sid, 'subagents'), { recursive: true });
    writeFileSync(join(projects, 'c--Users-alice-vault', `${sid}.jsonl`), `${line(sid, 1)}\n${line(sid, 2)}\n`);
    writeFileSync(join(projects, 'c--Users-alice-vault', sid, 'subagents', 'agent-a1.jsonl'), `${line(sid, 9)}\n`);
    writeFileSync(join(projects, 'c--Users-alice-vault', 'notes.txt'), 'x');
    await r.walk();
    expect(sent).toEqual([]); // not connected
    r.onWelcome([]);
    expect(sent[0]).toMatchObject({ type: 'repl.files', payload: { final: true } });
    expect((sent[0]!.payload.files as Array<{ relPath: string }>).map(f => f.relPath).sort()).toEqual([`c--Users-alice-vault/${sid}.jsonl`, `c--Users-alice-vault/${sid}/subagents/agent-a1.jsonl`]);
    await r.tick();
    const c = chunks(sent);
    expect(c).toHaveLength(2);
    expect(c.find(x => x.kind === 'subagent')).toMatchObject({ sessionId: sid, agentId: 'agent-a1', lines: [line(sid, 9)] });
    await new Promise(res => setTimeout(res, 20));
    expect(sent.find(m => m.type === 'repl.meta')!.payload).toEqual({ sessionId: sid, cwd: 'C:\\Users\\alice\\vault', gitRemote: 'git@git.example.com:alice/agent-hub.git', gitBranch: 'master' });
  });

  it('subagents 4.1: agent-<id>.meta.json goes as repl.agent_meta after welcome, again only when it changes; over 16 KB not sent', async () => {
    const { r, sent, projects } = setup('agent-meta');
    const sid = randomUUID();
    const dir = join(projects, 'c--Users-alice-vault', sid, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      `${line(sid, 1)}
`,
    );
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_1' }));
    writeFileSync(join(dir, 'agent-a2.meta.json'), JSON.stringify({ pad: 'x'.repeat(17 * 1024) }));
    const metas = () => sent.filter(m => m.type === 'repl.agent_meta').map(m => m.payload);
    await r.walk();
    expect(metas()).toEqual([]); // not connected: waits for the welcome
    // a hub 1.2 would only log an unknown type: nothing goes, the file waits for an updated hub
    r.onWelcome([], '1.2');
    await new Promise(res => setTimeout(res, 50));
    await r.walk();
    expect(metas()).toEqual([]);
    r.onDisconnected();
    r.onWelcome([], '1.3');
    // the meta file is read asynchronously after the welcome: under a loaded full run 50 ms is not enough
    for (let i = 0; i < 100 && metas().length === 0; i++) await new Promise(res => setTimeout(res, 50));
    expect(metas()).toEqual([{ sessionId: sid, relPath: `c--Users-alice-vault/${sid}/subagents/agent-a1.meta.json`, agentId: 'a1', meta: { agentType: 'general-purpose', toolUseId: 'toolu_1' } }]);
    await r.walk();
    expect(metas()).toHaveLength(1); // unchanged
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_1', finished: true }));
    await r.walk();
    expect(metas()).toHaveLength(2);
    expect(metas()[1]!.meta).toMatchObject({ finished: true });
  });

  it('4.2: the remote goes to the hub without user:password@ (a GitLab token in remote.origin.url)', async () => {
    const { r, sent, projects } = setup('token', { remote: 'https://oauth2:glpat-SECRET@git.example.com/alice/pos.git' });
    const sid = randomUUID();
    mkdirSync(join(projects, '-home-ubuntu-vault'), { recursive: true });
    writeFileSync(
      join(projects, '-home-ubuntu-vault', `${sid}.jsonl`),
      `${line(sid, 1)}
`,
    );
    await r.walk();
    r.onWelcome([]);
    await r.tick();
    await new Promise(res => setTimeout(res, 20));
    expect(sent.find(m => m.type === 'repl.meta')!.payload.gitRemote).toBe('https://git.example.com/alice/pos.git');
    expect(JSON.stringify(sent)).not.toContain('SECRET');
  });

  it('3.7: a session whose id the cron hook wrote after the last walk gets cronMarker in its repl.meta', async () => {
    const markers = join(root, 'cron-sessions.txt');
    const { r, sent, projects } = setup('cron', { cronMarkersFile: markers });
    await r.walk(); // no marker file yet
    r.onWelcome([]);
    const sid = randomUUID();
    const other = randomUUID();
    writeFileSync(
      markers,
      `${sid.toUpperCase()}
`,
    ); // the hook ran at SessionStart (any case, CRLF)
    mkdirSync(join(projects, '-home-ubuntu-vault'), { recursive: true });
    writeFileSync(
      join(projects, '-home-ubuntu-vault', `${sid}.jsonl`),
      `${line(sid, 1)}
`,
    );
    writeFileSync(
      join(projects, '-home-ubuntu-vault', `${other}.jsonl`),
      `${line(other, 1)}
`,
    );
    await r.walk();
    await r.tick();
    await new Promise(res => setTimeout(res, 20));
    const metas = sent.filter(m => m.type === 'repl.meta').map(m => m.payload);
    expect(metas.find(m => m.sessionId === sid)).toMatchObject({ cronMarker: true });
    expect(metas.find(m => m.sessionId === other)).not.toHaveProperty('cronMarker');
  });

  it('12 000 transcripts go in pages of ≤5000, final on the last; no files → one empty final page', () => {
    const all = Array.from({ length: 12_000 }, (_, i) => ({ relPath: `C--x/${i}.jsonl`, size: 1, mtimeMs: 1 }));
    expect(filesPages(all).map(p => [p.files.length, p.final])).toEqual([
      [5000, false],
      [5000, false],
      [2000, true],
    ]);
    expect(filesPages([])).toEqual([{ files: [], final: true }]);
    expect(filesPages(all.slice(0, 5000)).map(p => p.final)).toEqual([true]);
  });

  it('C--… and c--… of one Windows file are one transcript; the hub cursor under another case applies; follow() finds the existing directory', async () => {
    const { r, sent, projects } = setup('case');
    const sid = randomUUID();
    mkdirSync(join(projects, 'c--Users-alice-vault'));
    writeFileSync(join(projects, 'c--Users-alice-vault', `${sid}.jsonl`), `${line(sid, 1)}\n${line(sid, 2)}\n`);
    await r.follow(sid, 'C:\\Users\\alice\\vault'); // enc(cwd) = C--Users-alice-vault
    await r.walk();
    const firstLen = Buffer.byteLength(`${line(sid, 1)}\n`);
    // The M2 cursor was stored with the C--… name.
    r.onWelcome([{ relPath: `C--Users-alice-vault/${sid}.jsonl`, generation: 0, ackedLine: 1, ackedByte: firstLen }]);
    expect((sent[0]!.payload.files as unknown[]).length).toBe(1);
    await r.tick();
    expect(chunks(sent)).toEqual([expect.objectContaining({ relPath: `c--Users-alice-vault/${sid}.jsonl`, fromLine: 1, lines: [line(sid, 2)] })]);
    expect(fileKey('C--A/x.jsonl', true)).toBe(fileKey('c--a/x.jsonl', true));
    expect(fileKey('C--A/x.jsonl', false)).not.toBe(fileKey('c--a/x.jsonl', false));
  });

  it('own sessions go first and ignore the limit; history waits for the byte budget', async () => {
    const { r, sent, projects, advance } = setup('limit', { maxBytesPerSec: 1000 });
    mkdirSync(join(projects, 'p'));
    const hist = [randomUUID(), randomUUID(), randomUUID()];
    for (const h of hist) writeFileSync(join(projects, 'p', `${h}.jsonl`), `${'x'.repeat(900)}\n`);
    const own = randomUUID();
    writeFileSync(join(projects, 'p', `${own}.jsonl`), `${'y'.repeat(5000)}\n`);
    await r.walk();
    await r.follow(own, 'p'); // directory 'p' (enc of 'p')
    r.onWelcome([]);
    await r.tick();
    const c1 = chunks(sent);
    expect(c1[0]!.sessionId).toBe(own); // first, though bigger than the budget
    // 1000 B/s: the first history file leaves 99 B, the second overdraws, the third waits.
    expect(c1.filter(c => c.sessionId !== own)).toHaveLength(2);
    for (const c of c1) r.onAck({ relPath: c.relPath as string, generation: 0, ackedLine: 1, ackedByte: c.endByte as number });
    await r.tick();
    expect(chunks(sent)).toHaveLength(3); // budget spent
    advance(1000);
    await r.tick();
    expect(chunks(sent)).toHaveLength(4);
  });

  it('a truncated file is sent again from 0 with the next generation; a chunk without ack is re-sent after the timeout', async () => {
    const { r, sent, projects, advance } = setup('rewrite');
    mkdirSync(join(projects, 'p'));
    const sid = randomUUID();
    const f = join(projects, 'p', `${sid}.jsonl`);
    writeFileSync(f, `${line(sid, 1)}\n${line(sid, 2)}\n`);
    await r.walk();
    r.onWelcome([]);
    await r.tick();
    const c = chunks(sent)[0]!;
    r.onAck({ relPath: c.relPath as string, generation: 0, ackedLine: 2, ackedByte: c.endByte as number });
    writeFileSync(f, `${line(sid, 7)}\n`);
    await r.walk();
    await r.tick();
    expect(chunks(sent)[1]).toMatchObject({ generation: 1, fromLine: 0, fromByte: 0, rewrite: true, lines: [line(sid, 7)] });
    advance(31_000);
    await r.tick();
    expect(chunks(sent)[2]).toMatchObject({ generation: 1, fromLine: 0, lines: [line(sid, 7)] });
    appendFileSync(f, ''); // keep the file
  });

  it('side files: retries without side.ack back off 60 s → 2 min → … ≤30 min; side.reject stops them until the file changes', async () => {
    const projects = join(root, 'side');
    const sid = randomUUID();
    mkdirSync(join(projects, 'p', sid, 'tool-results'), { recursive: true });
    const f = join(projects, 'p', sid, 'tool-results', 't.txt');
    writeFileSync(f, 'вывод');
    const sent: string[] = [];
    let now = 1_000_000;
    const r = new Replicator({ projectsDir: projects, send: type => (sent.push(type), true), sendBinary: () => true, log, maxBytesPerSec: 1e9, watch: false, now: () => now });
    r.onWelcome([]);
    const sides = () => sent.filter(t => t === 'side.file').length;
    await r.walk();
    expect(sides()).toBe(1);
    await r.walk();
    expect(sides()).toBe(1); // waiting
    now += 60_000;
    await r.walk();
    expect(sides()).toBe(2);
    now += 60_000;
    await r.walk();
    expect(sides()).toBe(2); // now 2 min
    now += 60_000;
    await r.walk();
    expect(sides()).toBe(3);
    const sha = createHash('sha256').update(readFileSync(f)).digest('hex');
    r.onSideReject({ sessionId: sid, relPath: 'tool-results/t.txt', sha256: sha });
    now += 3600_000;
    await r.walk();
    expect(sides()).toBe(3); // refused: not offered again
    writeFileSync(f, 'вывод 2'); // changed → offered again
    await r.walk();
    expect(sides()).toBe(4);
    r.onSideAck({ sessionId: sid, relPath: 'tool-results/t.txt', sha256: createHash('sha256').update(readFileSync(f)).digest('hex') });
    now += 3600_000;
    await r.walk();
    expect(sides()).toBe(4);
  });
});
