// Tasks 3.1-3.6 (change `tool-windows-file-explorer`): fs/list and fs/file of the hub against scripted agents and a real database.
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FS_ERROR_STATUS, FS_ERROR_CODES, PROTOCOL_VERSION } from '@agent-hub/shared';
import { agentSend, autoReply, connectFakeAgent, NO_AUTO_REPLY, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { KeyedGate, type FsRouteOptions } from './files.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const SECRET_PATH = '/home/test/proj/very-secret-folder/notes.md';
const SECRET_TEXT = 'content-that-must-not-reach-the-log';

interface Setup {
  t: TestHub;
  cookie: string;
  agent: FakeAgent;
  oldAgent: FakeAgent;
  sessionId: string;
  oldSessionId: string;
  foreignSessionId: string;
  logs: string[];
  commands: Array<{ type: string; payload: Record<string, unknown> }>;
  /** the next answer of fs.* is this (once); otherwise the default one */
  script: { next: ((type: string, payload: Record<string, unknown>) => unknown) | null };
  get(url: string, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

async function setup(files: Partial<FsRouteOptions> = {}): Promise<Setup> {
  const logs: string[] = [];
  const commands: Setup['commands'] = [];
  const script: Setup['script'] = { next: null };
  const t = await startTestHub({ logStream: { write: line => logs.push(line) }, files });
  const vmToken = await t.addRunner('vm', 'VM');
  const hpToken = await t.addRunner('hp', 'HP');
  await t.addRunner('idle', 'Idle');
  const cookie = await t.login();
  const agent = connectFakeAgent(t.wsBase, vmToken, { protocol: PROTOCOL_VERSION, capabilities: ['fs.list-dirs', 'fs.browse'], homeDir: '/home/test' });
  autoReply(agent, (type, payload, id) => {
    if (!type.startsWith('fs.')) return {};
    commands.push({ type, payload });
    if (script.next) {
      const fn = script.next;
      script.next = null;
      return fn(type, payload);
    }
    if (type === 'fs.list') return { path: payload.path, entries: [{ name: 'a.md', kind: 'file', size: 3, mtimeMs: 1 }], truncated: false, total: 1 };
    void id;
    return { path: payload.path, kind: 'text', mime: 'text/plain', size: SECRET_TEXT.length, mtimeMs: 1, text: SECRET_TEXT };
  });
  await agent.next('welcome');
  // an agent of 1.13: no fs.browse
  const oldAgent = connectFakeAgent(t.wsBase, hpToken, { protocol: '1.13', capabilities: ['fs.list-dirs'], homeDir: '/home/old' });
  autoReply(oldAgent, () => ({}));
  await oldAgent.next('welcome');
  await waitFor(() => t.hub.agents.isOnline('vm') && t.hub.agents.isOnline('hp'));
  const q = async (sql: string, args: unknown[]) => (await t.tdb.pool.query(sql, args)).rows[0].id as string;
  const user = (await t.tdb.pool.query(`SELECT user_id FROM runners WHERE id='vm'`)).rows[0].user_id as string;
  const sessionId = await q(`INSERT INTO sessions(user_id,runner_id,claude_session_id,source,status,cwd) VALUES ($1,'vm',gen_random_uuid(),'hub','closed','/home/test/proj') RETURNING id`, [user]);
  const oldSessionId = await q(`INSERT INTO sessions(user_id,runner_id,claude_session_id,source,status,cwd) VALUES ($1,'hp',gen_random_uuid(),'hub','closed','/home/old/p') RETURNING id`, [user]);
  const other = await q(`INSERT INTO users(email) VALUES ('other@example.test') RETURNING id`, []);
  await t.tdb.pool.query(`INSERT INTO runners(id,user_id,name,home_dir) VALUES ('other-machine',$1,'Other','/home/other')`, [other]);
  const foreignSessionId = await q(
    `INSERT INTO sessions(user_id,runner_id,claude_session_id,source,status,cwd) VALUES ($1,'other-machine',gen_random_uuid(),'hub','closed','/home/other/p') RETURNING id`,
    [other],
  );
  return {
    t,
    cookie,
    agent,
    oldAgent,
    sessionId,
    oldSessionId,
    foreignSessionId,
    logs,
    commands,
    script,
    get: (url, headers = {}) => t.hub.app.inject({ method: 'GET', url, cookies: { ah_session: cookie }, headers: { 'sec-fetch-site': 'same-origin', origin: PUBLIC_URL, ...headers } }),
    async close() {
      agent.ws.close();
      oldAgent.ws.close();
      await t.close();
    },
  };
}

const enc = encodeURIComponent;

describe('fs/list and fs/file (integration)', () => {
  let s: Setup;
  beforeAll(async () => {
    s = await setup();
  });
  afterAll(async () => {
    await s.close();
  });
  const fsCommands = () => s.commands.filter(c => c.type.startsWith('fs.'));

  it('lists with the machine home as the root, and ignores a root sent by the browser', async () => {
    const before = fsCommands().length;
    const r = await s.get(`/api/runners/vm/fs/list?path=${enc('/home/test/docs')}&root=${enc('/')}&hidden=1`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ path: '/home/test/docs', truncated: false, total: 1, entries: [{ name: 'a.md', kind: 'file' }] });
    const sent = fsCommands()[before]!;
    expect(sent).toMatchObject({ type: 'fs.list', payload: { path: '/home/test/docs', root: '/home/test', showHidden: true } });
  });

  it('defaults the path to the root and takes the cwd of the session as the root', async () => {
    const before = fsCommands().length;
    expect((await s.get('/api/runners/vm/fs/list')).statusCode).toBe(200);
    expect(fsCommands()[before]).toMatchObject({ payload: { path: '/home/test', root: '/home/test', showHidden: false } });
    expect((await s.get(`/api/runners/vm/fs/list?sessionId=${s.sessionId}`)).statusCode).toBe(200);
    expect(fsCommands()[before + 1]).toMatchObject({ payload: { path: '/home/test/proj', root: '/home/test/proj' } });
    // a path outside the session cwd still goes to the agent with the cwd as the root: the agent refuses it
    expect((await s.get(`/api/runners/vm/fs/list?sessionId=${s.sessionId}&path=${enc('/etc')}`)).statusCode).toBe(200);
    expect(fsCommands()[before + 2]).toMatchObject({ payload: { path: '/etc', root: '/home/test/proj' } });
  });

  it('serves text with the security headers', async () => {
    const r = await s.get(`/api/runners/vm/fs/file?path=${enc('/home/test/a.txt')}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(SECRET_TEXT);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers['content-disposition']).toBe('inline');
    expect(r.headers['x-file-kind']).toBe('text');
    expect(r.headers['x-file-size']).toBe(String(SECRET_TEXT.length));
  });

  /** The agent answers cmd.ok {binary: true} and sends the bytes in the next frame. */
  const binaryAnswer = (result: Record<string, unknown>, data: Buffer) => {
    s.script.next = () => {
      setTimeout(() => s.agent.ws.send(data), 5);
      return { ...result, binary: true };
    };
  };

  it('serves an image and a pdf as bytes with the type and kind headers', async () => {
    binaryAnswer({ path: '/home/test/p.png', kind: 'image', mime: 'image/png', size: PNG.length, mtimeMs: 1 }, PNG);
    const img = await s.get(`/api/runners/vm/fs/file?path=${enc('/home/test/p.png')}`);
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-file-kind']).toBe('image');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    const pdf = Buffer.from('%PDF-1.7 body');
    binaryAnswer({ path: '/home/test/d.pdf', kind: 'pdf', mime: 'application/pdf', size: pdf.length, mtimeMs: 1 }, pdf);
    const r = await s.get(`/api/runners/vm/fs/file?path=${enc('/home/test/d.pdf')}`);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['x-file-kind']).toBe('pdf');
    expect(r.headers['x-file-size']).toBe(String(pdf.length));
    expect(r.rawPayload.equals(pdf)).toBe(true);
  });

  it('never lets the agent choose an active content type for an image answer', async () => {
    binaryAnswer({ path: '/home/test/x.png', kind: 'image', mime: 'text/html', size: 4, mtimeMs: 1 }, Buffer.from('<b/>'));
    const r = await s.get(`/api/runners/vm/fs/file?path=${enc('/home/test/x.png')}`);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'io_error' });
  });

  it('answers 415 for a binary file without data', async () => {
    s.script.next = () => ({ path: '/home/test/b.bin', kind: 'binary', mime: 'application/octet-stream', size: 99, mtimeMs: 1 });
    const r = await s.get(`/api/runners/vm/fs/file?path=${enc('/home/test/b.bin')}`);
    expect(r.statusCode).toBe(415);
    expect(r.json()).toEqual({ error: 'unsupported', kind: 'binary', size: 99, mime: 'application/octet-stream' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('maps every error of the agent to the status of the contract', async () => {
    for (const code of FS_ERROR_CODES) {
      s.script.next = () => {
        throw { code, message: code };
      };
      const r = await s.get(`/api/runners/vm/fs/list?path=${enc('/home/test/x')}`);
      expect(r.statusCode, code).toBe(FS_ERROR_STATUS[code]);
      expect(r.json().error, code).toBe(code);
    }
    s.script.next = () => {
      throw { code: 'weird', message: '/home/test/leaky/path' };
    };
    const odd = await s.get(`/api/runners/vm/fs/file?path=${enc('/home/test/x')}`);
    expect(odd.statusCode).toBe(502);
    expect(odd.body).not.toContain('leaky');
  });

  it('answers a malformed agent answer with 502', async () => {
    s.script.next = () => ({ nonsense: true });
    expect((await s.get(`/api/runners/vm/fs/list?path=${enc('/home/test/x')}`)).statusCode).toBe(502);
  });

  it('refuses unsafe and foreign-platform paths before the agent is asked', async () => {
    const before = fsCommands().length;
    for (const bad of ['relative/path', '/home/test/../../etc/passwd', '//host/share', '\\\\host\\share', 'C:\\Users\\alice', '/home/test/a\u0000b']) {
      for (const route of ['list', 'file']) {
        const r = await s.get(`/api/runners/vm/fs/${route}?path=${enc(bad)}`);
        expect(r.statusCode, `${route} ${JSON.stringify(bad)}`).toBe(400);
        expect(r.json().error).toBe('invalid_path');
      }
    }
    expect((await s.get('/api/runners/vm/fs/file')).statusCode).toBe(400); // a file needs a path
    expect((await s.get('/api/runners/vm/fs/list?sessionId=not-a-uuid')).statusCode).toBe(400);
    expect((await s.get('/api/runners/vm/fs/list?hidden=maybe')).statusCode).toBe(400);
    expect(fsCommands()).toHaveLength(before);
  });

  it('answers 404 for a foreign or unknown machine and a foreign session, and sends nothing to the agent', async () => {
    const before = fsCommands().length;
    expect((await s.get(`/api/runners/other-machine/fs/list?path=${enc('/home/other')}`)).statusCode).toBe(404);
    expect((await s.get('/api/runners/no-such/fs/list')).statusCode).toBe(404);
    const foreign = await s.get(`/api/runners/vm/fs/list?sessionId=${s.foreignSessionId}`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe('runner_not_found');
    // a session of the user on another machine is not a root for this one
    expect((await s.get(`/api/runners/vm/fs/file?sessionId=${s.oldSessionId}&path=${enc('/home/old/p/a.md')}`)).statusCode).toBe(404);
    expect((await s.get(`/api/runners/vm/fs/file?sessionId=00000000-0000-4000-8000-000000000000&path=${enc('/home/test/a.md')}`)).statusCode).toBe(404);
    expect(fsCommands()).toHaveLength(before);
  });

  it('answers 409 runner_offline for a machine without a connection', async () => {
    const r = await s.get('/api/runners/idle/fs/list');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('runner_offline');
  });

  it('answers 409 root_unknown for an online machine whose home folder the hub does not know', async () => {
    await s.t.tdb.pool.query(`UPDATE runners SET home_dir = NULL WHERE id = 'vm'`);
    try {
      const r = await s.get('/api/runners/vm/fs/list');
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('root_unknown');
    } finally {
      await s.t.tdb.pool.query(`UPDATE runners SET home_dir = '/home/test' WHERE id = 'vm'`);
    }
  });

  it('answers 409 capability_unavailable for an agent of 1.13 and sends it no fs.* command', async () => {
    const list = await s.get('/api/runners/hp/fs/list');
    expect(list.statusCode).toBe(409);
    expect(list.json().error).toBe('capability_unavailable');
    const file = await s.get(`/api/runners/hp/fs/file?sessionId=${s.oldSessionId}&path=${enc('/home/old/p/a.md')}`);
    expect(file.statusCode).toBe(409);
    expect(file.json().error).toBe('capability_unavailable');
    expect(s.oldAgent.messages.filter(m => m.type.startsWith('fs.'))).toHaveLength(0);
  });

  it('refuses a cross-site request and a foreign Origin; allows same-origin; needs a login', async () => {
    for (const route of ['list', 'file']) {
      const url = `/api/runners/vm/fs/${route}?path=${enc('/home/test/a.md')}`;
      for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://attacker.invalid' }] as Array<Record<string, string>>) {
        const r = await s.get(url, headers);
        expect(r.statusCode, route).toBe(403);
        expect(r.json().error).toBe('forbidden_origin');
      }
      expect((await s.get(url, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
      expect((await s.t.hub.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('does not write paths or contents to the log', async () => {
    s.script.next = (type, payload) => (type === 'fs.read' ? { path: payload.path, kind: 'text', mime: 'text/plain', size: SECRET_TEXT.length, mtimeMs: 1, text: SECRET_TEXT } : {});
    expect((await s.get(`/api/runners/vm/fs/file?path=${enc(SECRET_PATH)}`)).statusCode).toBe(200);
    s.script.next = () => {
      throw { code: 'not_found', message: 'x' };
    };
    expect((await s.get(`/api/runners/vm/fs/list?path=${enc(SECRET_PATH)}`)).statusCode).toBe(404);
    const log = s.logs.join('\n');
    expect(log).toContain('/fs/file');
    expect(log).not.toContain('very-secret-folder');
    expect(log).not.toContain(enc('/home/test/proj/very'));
    expect(log).not.toContain(SECRET_TEXT);
  });
});

describe('fs limits (integration)', () => {
  it('limits a user to the configured requests per minute with 429', async () => {
    const s = await setup({ ratePerMinute: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) codes.push((await s.get('/api/runners/vm/fs/list')).statusCode);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
      expect((await s.get('/api/runners/vm/fs/list')).json().error).toBe('too_many_requests');
    } finally {
      await s.close();
    }
  });

  it('keeps at most N commands in flight per machine, queues some and refuses the rest with 429', async () => {
    const s = await setup({ concurrency: 1, queue: 1, listTimeoutMs: 20_000 });
    try {
      const held: string[] = [];
      let hold = true;
      // replace the default behaviour: hold the first answers until released
      s.agent.ws.removeAllListeners('message');
      s.agent.ws.on('message', d => {
        const m = JSON.parse(d.toString()) as { type: string; id?: string; payload: Record<string, unknown> };
        if (m.type !== 'fs.list' || !m.id) return;
        s.commands.push({ type: m.type, payload: m.payload });
        if (hold) held.push(m.id);
        else agentSend(s.agent, 'cmd.ok', { result: { path: m.payload.path, entries: [], truncated: false, total: 0 } }, { re: m.id });
      });
      const first = s.get('/api/runners/vm/fs/list');
      await waitFor(() => held.length === 1);
      const second = s.get('/api/runners/vm/fs/list'); // waits in the queue
      await new Promise(r => setTimeout(r, 150));
      expect(held).toHaveLength(1); // the second one has not been sent
      const third = await s.get('/api/runners/vm/fs/list'); // queue is full
      expect(third.statusCode).toBe(429);
      hold = false;
      agentSend(s.agent, 'cmd.ok', { result: { path: '/home/test', entries: [], truncated: false, total: 0 } }, { re: held[0]! });
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      expect(s.commands.filter(c => c.type === 'fs.list')).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it('answers 504 agent_timeout when the agent is silent', async () => {
    const s = await setup({ listTimeoutMs: 150, readTimeoutMs: 150 });
    try {
      s.script.next = () => NO_AUTO_REPLY;
      const list = await s.get('/api/runners/vm/fs/list');
      expect(list.statusCode).toBe(504);
      expect(list.json().error).toBe('agent_timeout');
      s.script.next = () => NO_AUTO_REPLY;
      const file = await s.get(`/api/runners/vm/fs/file?path=${enc('/home/test/a.md')}`);
      expect(file.statusCode).toBe(504);
    } finally {
      await s.close();
    }
  });

  it('answers 409 runner_offline when the agent disconnects during the command', async () => {
    const s = await setup();
    try {
      s.script.next = () => {
        s.agent.ws.terminate();
        return NO_AUTO_REPLY;
      };
      const r = await s.get('/api/runners/vm/fs/list');
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('runner_offline');
    } finally {
      await s.close();
    }
  });
});

describe('KeyedGate', () => {
  it('hands the slot to the next waiter and forgets idle keys', async () => {
    const gate = new KeyedGate(2, 1);
    const a = (await gate.acquire('k'))!;
    const b = (await gate.acquire('k'))!;
    let third = false;
    const c = gate.acquire('k').then(release => {
      third = true;
      return release;
    });
    await new Promise(r => setTimeout(r, 10));
    expect(third).toBe(false);
    expect(await gate.acquire('k')).toBeNull();
    expect(await gate.acquire('other')).toBeTypeOf('function');
    a();
    a(); // a second release changes nothing
    const release = (await c)!;
    expect(third).toBe(true);
    b();
    release();
    expect(await gate.acquire('k')).toBeTypeOf('function');
  });
});
