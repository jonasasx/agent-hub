// Requirement: Секреты в снимке MCP (mcp-management design M5, task 2.1).
import { describe, expect, it } from 'vitest';
import { MASK, redactCommand, redactServer, redactText, redactUrl, transportOf } from './mcpRedact.js';

describe('redactCommand', () => {
  it('scenario «Токен в аргументах»: the value after a secret flag is masked, --port stays', () => {
    expect(redactCommand('npx', ['-y', '@x/mcp', '--api-key', 'sk-live-abcdefghijklmnopqrstuvwx', '--port', '8080'])).toBe(`npx -y @x/mcp --api-key ${MASK} --port 8080`);
  });

  it.each([
    ['--token', 'abc'],
    ['--client-secret', 'x'],
    ['-password', 'hunter2'],
    ['--auth', 'u:p'],
    ['--bearer', 'xyz'],
    ['--credentials-file', 'C:\\creds.json'],
    ['--passwd', 'q'],
  ])('%s <value> → •••', (flag, value) => {
    expect(redactCommand('srv', [flag, value])).toBe(`srv ${flag} ${MASK}`);
  });

  it('NAME=value with a secret name, also as --flag=value', () => {
    expect(redactCommand('env', ['API_TOKEN=supersecret', 'PORT=1', '--api-key=k1', '--mode=fast'])).toBe(`env API_TOKEN=${MASK} PORT=1 --api-key=${MASK} --mode=fast`);
  });

  it('a long token alone is masked; paths, names and short values stay', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(redactCommand('srv', [hex])).toBe(`srv ${MASK}`);
    expect(redactCommand('srv', ['ghp_AbCdEf0123456789AbCdEf0123'])).toBe(`srv ${MASK}`);
    expect(redactCommand('node', ['C:\\Users\\x\\very-long-folder-name-without-secrets'])).toBe('node C:\\Users\\x\\very-long-folder-name-without-secrets');
    expect(redactCommand('node', ['/home/u/very-long-folder-name-without-secrets1/index.js'])).toBe('node /home/u/very-long-folder-name-without-secrets1/index.js');
    expect(redactCommand('npx', ['@modelcontextprotocol/server-filesystem', 'mcp-server-for-the-whole-team'])).toBe('npx @modelcontextprotocol/server-filesystem mcp-server-for-the-whole-team');
    expect(redactCommand('srv', ['--port', '8080'])).toBe('srv --port 8080');
  });

  // B2 of the review: a URL, a Bearer and a header inside an argument
  it('a URL argument loses its query, fragment and userinfo', () => {
    expect(redactCommand('npx', ['mcp-remote', 'https://mcp.example.com/sse?api_key=abc123'])).toBe('npx mcp-remote https://mcp.example.com/sse');
    expect(redactCommand('npx', ['mcp-remote', 'https://user:pw@mcp.example.com/mcp#tok'])).toBe('npx mcp-remote https://mcp.example.com/mcp');
    expect(redactCommand('srv', ['--url=https://h.example/x?token=abc'])).not.toContain('abc');
  });

  // fix-cycle 2: a DSN of any scheme loses userinfo, query and fragment
  it('a DSN of any scheme (postgresql, mongodb, redis, amqp) loses userinfo, query and fragment', () => {
    expect(redactCommand('npx', ['@modelcontextprotocol/server-postgres', 'postgresql://user:pass@db/x'])).toBe('npx @modelcontextprotocol/server-postgres postgresql://db/x');
    expect(redactCommand('srv', ['--dsn=mongodb://u:p@h/db'])).toBe('srv --dsn=mongodb://h/db');
    expect(redactCommand('srv', ['redis://:pw@h:6379'])).toBe('srv redis://h:6379');
    expect(redactCommand('srv', ['amqp://guest:secret@rabbit:5672/vh?heartbeat=30#x'])).toBe('srv amqp://rabbit:5672/vh');
    expect(redactCommand('srv', ['mongodb+srv://u:p@cluster.example.net/db?authSource=admin'])).toBe('srv mongodb+srv://cluster.example.net/db');
    // an unparsable multi-host DSN is masked whole
    expect(redactCommand('srv', ['mongodb://u:p@h1:27017,h2:27017/db'])).not.toContain('u:p');
  });

  it('plain paths, packages and scoped names are not URLs', () => {
    const args = ['-y', '@modelcontextprotocol/server-postgres', 'C:\\Users\\x\\db.sqlite', '/var/lib/x.db', 'pkg@1.2.3', 'file:///tmp/a.db', 'host:5432', 'mcp-server-for-the-whole-team'];
    expect(redactCommand('npx', args)).toBe(`npx ${args.join(' ')}`);
  });

  it('the value of --header / -H is ••• whole, in every form', () => {
    const secret = 'sk-live-0123456789abcdefghij';
    const cases: Array<[string[], string]> = [
      [['--header', `Authorization: Bearer ${secret}`], `--header ${MASK}`],
      [[`--header=Authorization:Bearer ${secret}`], `--header=${MASK}`],
      [['-H', `Authorization: Bearer ${secret}`], `-H ${MASK}`],
      [[`-H=X-Api-Key:${secret}`], `-H=${MASK}`],
      [[`-HAuthorization:Bearer ${secret}`], `-H${MASK}`],
    ];
    for (const [args, want] of cases) {
      const out = redactCommand('npx', ['mcp-remote', 'https://mcp.example.com/sse', ...args]);
      expect(out).toBe(`npx mcp-remote https://mcp.example.com/sse ${want}`);
      expect(out).not.toContain('sk-live');
    }
  });

  it('Bearer/Basic and a secret header outside a header flag', () => {
    expect(redactCommand('srv', ['Authorization: Bearer abc'])).toBe(`srv Authorization: ${MASK}`);
    expect(redactCommand('srv', ['--auth', 'x'])).toBe(`srv --auth ${MASK}`);
    expect(redactCommand('srv', ['use Bearer abc.def'])).toBe(`srv use Bearer ${MASK}`);
    expect(redactCommand('srv', ['Basic dXNlcjpwYXNz'])).toBe(`srv Basic ${MASK}`);
    expect(redactCommand('srv', ['-Hello'])).toBe('srv -Hello');
  });

  it('is cut to 500 characters', () => {
    expect(redactCommand('x', Array(200).fill('abcd')).length).toBe(500);
  });
});

describe('redactUrl', () => {
  it('scenario «URL с ключом в query»: no userinfo, query or fragment', () => {
    expect(redactUrl('https://u:p@mcp.example.com/mcp?key=abc123')).toBe('https://mcp.example.com/mcp');
    expect(redactUrl('http://localhost:3000/sse#frag')).toBe('http://localhost:3000/sse');
    expect(redactUrl('not a url')).toBeUndefined();
  });
});

describe('redactText', () => {
  it('URLs without query, Bearer, NAME=value, long tokens', () => {
    const t = redactText('GET https://u:p@api.x.com/v1?token=abc failed; Authorization: Bearer eyJabc.def.ghi; API_KEY=sk123 port=8080 id a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(t).toBe(`GET https://api.x.com/v1 failed; Authorization: Bearer ${MASK}; API_KEY=${MASK} port=8080 id ${MASK}`);
  });

  it('keeps paths and plain errors', () => {
    expect(redactText('connect ECONNREFUSED 127.0.0.1:8080')).toBe('connect ECONNREFUSED 127.0.0.1:8080');
    expect(redactText('connect to postgresql://u:secret@db:5432/x?sslmode=require failed')).toBe('connect to postgresql://db:5432/x failed');
    expect(redactText('spawn C:\\Users\\x\\very-long-folder-name-without-secrets1\\a.exe ENOENT')).toBe('spawn C:\\Users\\x\\very-long-folder-name-without-secrets1\\a.exe ENOENT');
  });

  it('is cut to 1000 characters', () => {
    expect(redactText('x '.repeat(2000)).length).toBe(1000);
  });
});

describe('redactServer', () => {
  it('stdio: env never read, the command masked; scope = source ?? scope; tools counted', () => {
    const row = redactServer({
      name: 'x',
      status: 'connected',
      config: { type: 'stdio', command: 'npx', args: ['-y', '@x/mcp', '--api-key', 'sk-live-abcdefghijklmnopqrstuvwx', '--port', '8080'], env: { API_TOKEN: 'tok-SECRET-123' } } as never,
      scope: 'user',
      source: 'plugin',
      serverInfo: { name: 'x', version: '1.2.3' },
      tools: [{ name: 'a' }, { name: 'b' }],
    });
    expect(row).toEqual({
      name: 'x',
      status: 'connected',
      transport: 'stdio',
      target: `npx -y @x/mcp --api-key ${MASK} --port 8080`,
      scope: 'plugin',
      serverInfo: { name: 'x', version: '1.2.3' },
      toolCount: 2,
    });
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  it('http: headers never read, URL without query; a failed error is redacted', () => {
    const row = redactServer({
      name: 'h',
      status: 'failed',
      error: 'HTTP 401 from https://mcp.example.com/mcp?key=abc123',
      config: { type: 'http', url: 'https://u:p@mcp.example.com/mcp?key=abc123', headers: { Authorization: 'Bearer SECRET' } } as never,
      scope: 'project',
    });
    expect(row).toEqual({ name: 'h', status: 'failed', error: 'HTTP 401 from https://mcp.example.com/mcp', transport: 'http', target: 'https://mcp.example.com/mcp', scope: 'project', toolCount: 0 });
    expect(JSON.stringify(row)).not.toMatch(/SECRET|abc123|u:p/);
  });

  it('claudeai-proxy has no target; sdk and an unknown type', () => {
    expect(redactServer({ name: 'c', status: 'connected', config: { type: 'claudeai-proxy', url: 'https://claude.ai/org/123/srv/456', id: 'x' } as never })).toEqual({
      name: 'c',
      status: 'connected',
      transport: 'claudeai-proxy',
      toolCount: 0,
    });
    expect(transportOf({ type: 'sdk' })).toBe('sdk');
    expect(transportOf({ type: 'ws' })).toBe('other');
    expect(transportOf({ command: 'node' })).toBe('stdio');
    expect(transportOf(undefined)).toBe('other');
  });
});
