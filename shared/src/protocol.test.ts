import { describe, expect, it } from 'vitest';
import {
  AGENT_MESSAGE_TYPES,
  AGENT_VERSION_RE,
  CloseCode,
  HUB_MESSAGE_TYPES,
  AGENT_UPDATE_PROTOCOL,
  LIMITS_PROBE_ERRORS,
  LIMITS_PROBE_OUTCOMES,
  LIMITS_PROTOCOL,
  MCP_ERROR_CODES,
  MCP_AUTH_CONTROLS_PROTOCOL,
  MCP_PROTOCOL,
  mcpAuthStartResultSchema,
  mcpProbeResultSchema,
  limitsProbeResultSchema,
  PROTOCOL_VERSION,
  FILES_PROTOCOL,
  DOWNLOAD_PROTOCOL,
  FS_CHUNK_MAX,
  AGENT_CAPABILITIES,
  HUB_CAPABILITIES,
  SUBSCRIPTIONS_PROTOCOL,
  TURN_FAILURE_KINDS,
  envelope,
  isCompatibleProtocol,
  parseAgentMessage,
  parseHubMessage,
  protocolAtLeast,
  protocolMajor,
} from './index.js';
import * as v13 from './snapshots/protocol-1.3.js';
import * as v14 from './snapshots/protocol-1.4.js';
import * as v15 from './snapshots/protocol-1.5.js';
import * as v16 from './snapshots/protocol-1.6.js';
import * as v17 from './snapshots/protocol-1.7.js';

const SID = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const UUID2 = '0b9d8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';
const SHA = 'a'.repeat(64);

const hello = {
  protocol: '1.0',
  agentVersion: '0.1.0',
  sdkVersion: '0.3.310',
  claudeCodeVersion: '2.1.296',
  hostname: 'HP-Elitebook',
  os: 'Windows 11 Pro',
  homeDir: 'C:\\Users\\alice',
  vaultRoot: 'C:\\Users\\alice\\vault',
  liveSessions: [{ sessionId: SID, state: 'waiting' }],
  files: [{ relPath: 'C--Users-alice-vault/x.jsonl', size: 10, mtimeMs: 1 }],
};

const validAgent: Array<[string, unknown, { re?: string }?]> = [
  ['hello', hello],
  ['session.state', { sessionId: SID, state: 'working', processAlive: true }],
  ['session.partial', { sessionId: SID, messageId: 'msg_1', blockIndex: 0, textDelta: 'При' }],
  ['session.result', { sessionId: SID, subtype: 'success', isError: false, durationMs: 1200, costUsd: 0.01 }],
  ['session.exited', { sessionId: SID, code: null, reason: 'crashed', errorText: 'boom' }],
  ['permission.request', { requestId: UUID2, sessionId: SID, toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'ls' }, suggestions: [] }],
  ['repl.chunk', { relPath: 'p/x.jsonl', kind: 'main', sessionId: SID, generation: 0, fromLine: 0, fromByte: 0, lines: ['{}'], endByte: 3 }],
  ['repl.meta', { sessionId: SID, cwd: '/home/ubuntu/vault', cronMarker: true }],
  [
    'repl.agent_meta',
    {
      sessionId: SID,
      relPath: 'c--x/' + SID + '/subagents/agent-a0ff7e8952c02d1bb.meta.json',
      agentId: 'a0ff7e8952c02d1bb',
      meta: { agentType: 'general-purpose', toolUseId: 'toolu_1', finished: true },
    },
  ],
  ['side.file', { sessionId: SID, relPath: 'tool-results/a.txt', sha256: SHA, size: 5 }],
  ['repl.files', { files: [{ relPath: 'c--Users-alice-vault/x.jsonl', size: 1, mtimeMs: 2 }], final: true }],
  ['agent.status', { claude: { login: 'rejected', version: '2.1.300' } }],
  ['agent.update.result', { version: '0.2.0', status: 'failed', error: 'sha_mismatch' }],
  [
    'limits.event',
    {
      sessionId: SID,
      snapshot: { windows: [{ type: 'five_hour', utilization: 92, resetsAt: '2026-10-27T15:10:00.000Z', status: 'allowed_warning', surpassedThreshold: 90 }], overage: null },
      quiet: false,
      observedAt: 1793120000000,
    },
  ],
  [
    'mcp.status',
    {
      sessionId: SID,
      snapshot: {
        servers: [{ name: 'vaultwarden', status: 'connected', transport: 'stdio', target: 'node C:/x/vw.js', scope: 'user', serverInfo: { name: 'vw', version: '1.0.0' }, toolCount: 12 }],
        observedAt: 1793120000000,
      },
    },
  ],
  ['mcp.auth.done', { sessionId: SID, server: 'notion', ok: true }],
  ['mcp.registry.ack', { revision: 1, applied: true }],
  ['mcp.registry.validate.result', { draftId: SID, revision: 1, ok: true, status: 'checked', tools: [], oauthRequired: false }, { re: 'validate-1' }],
  ['mcp.gateway.status', { serverId: SID, machineId: UUID2, status: 'stopped', observedAt: 1 }],
  [
    'mcp.oauth.token.update',
    {
      serverId: SID,
      machineId: UUID2,
      flowId: SID,
      accessToken: 'test-access-token',
      oauthClientState: '{"authorizationServerUrl":"https://auth.example.test","clientInformation":{"client_id":"public-client"}}',
    },
  ],
  ['mcp.oauth.status.update', { serverId: SID, machineId: UUID2, state: 'refresh-error', error: 'Refresh failed' }],
  ['mcp.import.preview.result', { importId: SID, servers: [], secretsCaptured: 0, warnings: [] }],
  [
    'mcp.import.preview.result',
    { importId: SID, servers: [], secretsCaptured: 1, warnings: [], secretValues: [{ serverName: 'sample', location: 'env', key: 'API_KEY', value: 'one-time-test-secret' }] },
  ],
  ['mcp.draft.request', { requestId: UUID2, sessionId: SID, op: 'list', payload: {} }],
  ['mcp.registry.session-update.ack', { sessionId: SID, revision: 2, activation: 'connected-live', applied: true }],
  ['peers.request', { op: 'send', sessionId: SID, to: SID, text: 'hi' }, { id: 'p1' }],
  ['provider.login.done', { provider: 'codex', loginId: 'l1', ok: false, error: 'expired' }],
  ['provider.credential.update', { subscriptionId: SID, credential: '{"tokens":{"account_id":"acc-1234"}}' }],
  ['cmd.ok', { result: { newSessionId: SID } }, { re: 'c1' }],
  ['cmd.error', { code: 'ENOENT', message: 'no file' }, { re: 'c1' }],
];

const validHub: Array<[string, unknown, { id?: string }?]> = [
  ['welcome', { runnerId: 'hp', protocol: '1.0', cursors: [{ relPath: 'a', generation: 0, ackedLine: 1, ackedByte: 2 }] }],
  ['repl.ack', { relPath: 'a', generation: 1, ackedLine: 10, ackedByte: 200 }],
  ['side.ack', { sessionId: SID, relPath: 'tool-results/a.txt', sha256: SHA }],
  ['side.reject', { sessionId: SID, relPath: 'tool-results/a.txt', sha256: SHA, reason: 'sha_mismatch' }],
  ['session.start', { sessionId: SID, cwd: '/x', permissionMode: 'bypassPermissions', model: 'opus', prompt: 'hi', promptUuid: UUID2 }, { id: 'c1' }],
  ['session.resume', { sessionId: SID, cwd: '/x', permissionMode: 'default', model: 'sonnet' }, { id: 'c2' }],
  ['session.send', { sessionId: SID, text: 'next', promptUuid: UUID2 }, { id: 'c3' }],
  ['session.send', { sessionId: SID, text: 'img', promptUuid: UUID2, attachments: [{ sha256: SHA, mime: 'image/png', size: 10, url: '/agent-api/blobs/tok_1' }] }, { id: 'c3b' }],
  ['fs.read_image', { path: 'C:\\Users\\a.png' }, { id: 'c12' }],
  ['attachments.fetch', { attachments: [{ sha256: 'a'.repeat(64), mime: 'image/png', size: 10, url: '/agent-api/blobs/tok_1' }] }, { id: 'c13' }],
  ['session.interrupt', { sessionId: SID }, { id: 'c4' }],
  ['session.set_mode', { sessionId: SID, mode: 'plan' }, { id: 'c5' }],
  ['session.set_model', { sessionId: SID, model: 'haiku' }, { id: 'c6' }],
  ['session.stop', { sessionId: SID, reason: 'sleep' }, { id: 'c7' }],
  ['permission.response', { requestId: UUID2, behavior: 'allow', scope: 'session' }],
  ['session.fork', { sourceSessionId: SID, cwd: '/x' }, { id: 'c8' }],
  ['file.restore', { sessionId: SID, cwd: '/x', url: '/agent-api/restore/abc_DEF-1', sha256: SHA }, { id: 'c9' }],
  ['fs.stat', { path: 'C:\\Users' }, { id: 'c10' }],
  ['fs.list-dirs', { path: 'C:\\Users', showHidden: false }, { id: 'c10b' }],
  ['fs.list', { path: '/home/a', root: '/home/a', showHidden: false }, { id: 'c10c' }],
  ['fs.read', { path: '/home/a/x.md', root: '/home/a' }, { id: 'c10d' }],
  ['fs.read_chunk', { path: '/home/a/x.mp4', root: '/home/a', offset: 0, length: 4194304 }, { id: 'c10e' }],
  ['handoff.generate', { transcript: 't', model: 'sonnet', systemPrompt: 's' }, { id: 'c11' }],
  ['agent.update', { version: '0.2.0', sha256: SHA, url: '/agent/agent-0.2.0.tgz' }],
  ['limits.probe', { subscription: { id: '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d', token: 'sk-ant-oat01-' + 'Ab9_-'.repeat(16) }, model: 'haiku' }, { id: 'c14' }],
  ['mcp.status.get', { sessionId: SID }, { id: 'c15' }],
  ['mcp.action', { sessionId: SID, server: 'playwright', action: 'disable' }, { id: 'c16' }],
  ['mcp.auth.start', { sessionId: SID, server: 'notion', redirectUri: 'https://hub.example.com/mcp/oauth/callback' }, { id: 'c17' }],
  ['mcp.auth.callback', { sessionId: SID, server: 'notion', callbackUrl: 'https://hub.example.com/mcp/oauth/callback?code=x&state=y' }, { id: 'c18' }],
  ['mcp.machine.probe', {}, { id: 'c19' }],
  ['mcp.auth.logout', { sessionId: SID, server: 'notion' }, { id: 'c20' }],
  ['mcp.registry.sync', { protocol: '1.13', revision: 1, generatedAt: 1, servers: [] }, { id: 'c24' }],
  [
    'mcp.registry.validate',
    {
      draftId: SID,
      revision: 1,
      machineId: UUID2,
      server: { id: SID, name: 'candidate', enabled: true, transport: 'stdio', mode: 'per-session', command: 'node', machineScope: { allMachines: true, machineIds: [] }, projectIds: [], revision: 1 },
    },
    { id: 'c25' },
  ],
  [
    'mcp.registry.session-update',
    {
      sessionId: SID,
      revision: 1,
      server: { id: SID, name: 'candidate', enabled: true, transport: 'stdio', mode: 'per-session', command: 'node', machineScope: { allMachines: true, machineIds: [] }, projectIds: [], revision: 1 },
      activation: 'connected-live',
    },
  ],
  ['mcp.gateway.start', { serverId: SID, revision: 1, bearerToken: 'x'.repeat(32) }, { id: 'c26' }],
  ['mcp.gateway.stop', { serverId: SID, reason: 'requested' }, { id: 'c27' }],
  ['mcp.secrets.deliver', { serverId: SID, machineId: UUID2, revision: 1, secrets: [{ name: 'API_KEY', value: 'test-only' }] }, { id: 'c28' }],
  [
    'mcp.oauth.start',
    {
      flowId: SID,
      serverId: SID,
      machineId: UUID2,
      redirectUri: 'https://agents.example.test/mcp/oauth/callback',
      serverUrl: 'https://mcp.example.test/rpc',
      transport: 'http',
    },
    { id: 'c29' },
  ],
  ['mcp.oauth.callback', { flowId: SID, callbackUrl: 'https://agents.example.test/mcp/oauth/callback?code=test&state=test' }, { id: 'c30' }],
  ['mcp.oauth.credentials', { serverId: SID, machineId: UUID2, accessToken: 'test-access-token' }, { id: 'c31' }],
  ['mcp.oauth.revoke', { serverId: SID, machineId: UUID2 }, { id: 'c33' }],
  ['mcp.import.preview', { machineId: UUID2, projectRoot: 'C:/project' }, { id: 'c32' }],
  ['mcp.draft.result', { requestId: UUID2, ok: true, result: { message: 'draft created' } }],
  ['peers.reply', { ok: true, result: { result: 'delivered' } }, { re: 'p1' }],
  ['provider.login.start', { provider: 'codex' }, { id: 'c21' }],
  ['provider.login.cancel', { provider: 'codex', loginId: 'l1' }, { id: 'c22' }],
  ['provider.logout', { provider: 'codex' }, { id: 'c23' }],
  ['provider.credentials.sync', { provider: 'codex', keep: ['6f1c7c2e-3b0a-4c55-9b7d-2f0d2a6f1b11'], forget: [] }, { id: 'c23b' }],
];

describe('protocol version', () => {
  it('accepts negotiated fs.list-dirs capability and command payloads additively', () => {
    const helloWithCapability = parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, protocol: '1.13', capabilities: ['fs.list-dirs'] })));
    expect(helloWithCapability.ok && helloWithCapability.message.payload).toMatchObject({ capabilities: ['fs.list-dirs'] });
    expect(parseHubMessage(JSON.stringify(envelope('welcome', { runnerId: 'hp', protocol: '1.13', cursors: [], capabilities: ['fs.list-dirs'] }))).ok).toBe(true);
    expect(parseHubMessage(JSON.stringify(envelope('fs.list-dirs', { path: '/tmp', showHidden: true }, { id: 'browse' }))).ok).toBe(true);
  });
  it('negotiates fs.browse in 1.14 and still accepts a 1.13 hello without it', () => {
    expect(FILES_PROTOCOL).toBe('1.14');
    expect(AGENT_CAPABILITIES).toContain('fs.browse');
    expect(HUB_CAPABILITIES).toContain('fs.browse');
    expect(parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, protocol: '1.14', capabilities: ['fs.browse'] }))).ok).toBe(true);
    expect(parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, protocol: '1.13', capabilities: ['fs.list-dirs'] }))).ok).toBe(true);
    expect(parseHubMessage(JSON.stringify(envelope('welcome', { runnerId: 'hp', protocol: '1.14', cursors: [], capabilities: ['fs.browse'] }))).ok).toBe(true);
    expect(isCompatibleProtocol('1.13')).toBe(true);
    expect(parseHubMessage(JSON.stringify(envelope('fs.read', { path: '/a', root: '' }, { id: 'bad' }))).ok).toBe(false);
  });
  it('negotiates fs.download in 1.16 with fs.read_chunk bounded by FS_CHUNK_MAX', () => {
    expect(DOWNLOAD_PROTOCOL).toBe('1.16');
    expect(AGENT_CAPABILITIES).toContain('fs.download');
    expect(HUB_CAPABILITIES).toContain('fs.download');
    const chunk = { path: '/a/b.mp4', root: '/a', offset: FS_CHUNK_MAX, length: FS_CHUNK_MAX };
    expect(parseHubMessage(JSON.stringify(envelope('fs.read_chunk', chunk, { id: 'c1' }))).ok).toBe(true);
    expect(parseHubMessage(JSON.stringify(envelope('fs.read_chunk', { ...chunk, length: 0 }, { id: 'c2' }))).ok).toBe(true);
    expect(parseHubMessage(JSON.stringify(envelope('fs.read_chunk', { ...chunk, length: FS_CHUNK_MAX + 1 }, { id: 'c3' }))).ok).toBe(false);
    expect(parseHubMessage(JSON.stringify(envelope('fs.read_chunk', { ...chunk, offset: -1 }, { id: 'c4' }))).ok).toBe(false);
  });
  it('is 1.15 with close codes 4401/4409/4426; subscriptions need 1.4, agent.update 1.5, limits 1.6, MCP 1.7, MCP sign-out 1.8, Codex subscriptions 1.11', () => {
    expect(PROTOCOL_VERSION).toBe('1.17');
    expect(isCompatibleProtocol('1.11')).toBe(true); // project launch adds only optional HTTP fields; agent commands remain 1.12-compatible
    expect(MCP_PROTOCOL).toBe('1.7');
    expect(MCP_AUTH_CONTROLS_PROTOCOL).toBe('1.8');
    expect(LIMITS_PROTOCOL).toBe('1.6');
    expect(SUBSCRIPTIONS_PROTOCOL).toBe('1.4');
    expect(AGENT_UPDATE_PROTOCOL).toBe('1.5');
    expect(v13.PROTOCOL_VERSION).toBe('1.3');
    expect(CloseCode).toEqual({ InvalidToken: 4401, Replaced: 4409, IncompatibleVersion: 4426 });
  });

  it.each([
    ['1.0', 1, true],
    ['1.7', 1, true],
    ['2.0', 2, false],
    ['1', null, false],
    ['v1.0', null, false],
    [undefined, null, false],
  ])('protocolMajor(%s) = %s, compatible = %s', (v, major, compatible) => {
    expect(protocolMajor(v)).toBe(major);
    expect(isCompatibleProtocol(v)).toBe(compatible);
  });
});

describe('protocolAtLeast', () => {
  it.each([
    ['1.4', '1.4', true],
    ['1.10', '1.4', true],
    ['1.3', '1.4', false],
    ['2.5', '1.4', false],
    [null, '1.4', false],
    ['x', '1.4', false],
  ])('%s ≥ %s is %s', (v, min, r) => expect(protocolAtLeast(v, min)).toBe(r));
});

describe('1.5 (multi-user): hello fields, agent.update', () => {
  it('hello of 1.5 carries claude, protectedDirs, arch', () => {
    const r = parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, protocol: '1.5', claude: { login: 'missing', version: null }, protectedDirs: 'denied', arch: 'arm64', root: true })));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'hello') expect(r.message.payload).toMatchObject({ claude: { login: 'missing', version: null }, protectedDirs: 'denied', arch: 'arm64', root: true });
  });
  it('hello of an older agent (no new fields) is accepted', () => {
    const r = parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, protocol: '1.3' })));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'hello') expect(r.message.payload.claude).toBeUndefined();
  });
  it('a bad login value is invalid', () => {
    expect(parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, claude: { login: 'maybe', version: null } })))).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('agent.update with a url outside /agent/ or a bad sha is invalid', () => {
    expect(parseHubMessage(JSON.stringify(envelope('agent.update', { version: '0.2.0', sha256: SHA, url: 'https://evil/agent-0.2.0.tgz' })))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseHubMessage(JSON.stringify(envelope('agent.update', { version: '0.2.0', sha256: 'x', url: '/agent/agent-0.2.0.tgz' })))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('agent.update version and url are semver: «..», «/», «\\» and a bare «1» are invalid; pre-release and build pass', () => {
    const upd = (version: string, url = `/agent/agent-${version}.tgz`) => parseHubMessage(JSON.stringify(envelope('agent.update', { version, sha256: SHA, url })));
    for (const v of ['..', '1.2.3/..', '1.2.3-..', '1.2.3+a..b', '..\\x', '1.2.3\\x', '1', '1.2', '1.2.3-', 'a.b.c']) expect(upd(v), v).toMatchObject({ ok: false, reason: 'invalid' });
    expect(upd('0.2.0', '/agent/agent-..tgz')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(upd('0.2.0', '/agent/agent-0.2.0-...tgz')).toMatchObject({ ok: false, reason: 'invalid' });
    for (const v of ['0.2.0', '1.2.3-rc.1', '1.2.3+build.5', '10.0.0-alpha-1']) expect(upd(v), v).toMatchObject({ ok: true });
    expect(AGENT_VERSION_RE.test('..')).toBe(false);
  });
});

describe('agent -> hub messages', () => {
  it('1.3: repl.agent_meta with a meta over 16 KB, or a bad agentId, is invalid', () => {
    const big = { sessionId: SID, relPath: 'x/agent-a1.meta.json', agentId: 'a1', meta: { description: 'x'.repeat(17_000) } };
    expect(parseAgentMessage(JSON.stringify(envelope('repl.agent_meta', big)))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseAgentMessage(JSON.stringify(envelope('repl.agent_meta', { ...big, meta: {}, agentId: '../x' })))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('covers every D3 agent message type', () => {
    expect(new Set(validAgent.map(([t]) => t))).toEqual(new Set(AGENT_MESSAGE_TYPES));
  });

  it.each(validAgent)('accepts valid %s', (type, payload, extra) => {
    const r = parseAgentMessage(JSON.stringify(envelope(type, payload, extra)));
    expect(r.ok).toBe(true);
  });

  it('ignores unknown fields (minor version compatibility)', () => {
    const r = parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, futureField: 1 })));
    expect(r.ok).toBe(true);
  });

  it('accepts a Buffer', () => {
    expect(parseAgentMessage(Buffer.from(JSON.stringify(envelope('hello', hello)))).ok).toBe(true);
  });

  it.each([
    ['invalid_json', '{not json'],
    ['not_envelope', '[1,2]'],
    ['not_envelope', JSON.stringify({ v: 1, ts: 1, payload: {} })],
    ['unknown_type', JSON.stringify(envelope('session.teleport', {}))],
    ['invalid', JSON.stringify({ ...envelope('hello', hello), v: 2 })],
    ['invalid', JSON.stringify({ type: 'hello', v: 1, payload: hello })],
    ['invalid', JSON.stringify(envelope('hello', { ...hello, hostname: '' }))],
    ['invalid', JSON.stringify(envelope('hello', { ...hello, protocol: 'one' }))],
    ['invalid', JSON.stringify(envelope('session.state', { sessionId: 'not-a-uuid', state: 'working', processAlive: true }))],
    ['invalid', JSON.stringify(envelope('session.state', { sessionId: SID, state: 'sleeping', processAlive: true }))],
    ['invalid', JSON.stringify(envelope('repl.chunk', { relPath: 'a', kind: 'main', sessionId: SID, generation: -1, fromLine: 0, fromByte: 0, lines: [], endByte: 0 }))],
    ['invalid', JSON.stringify(envelope('side.file', { sessionId: SID, relPath: 'a', sha256: 'XYZ', size: 1 }))],
    ['invalid', JSON.stringify(envelope('cmd.ok', {}))],
  ])('rejects %s: %s', (reason, raw) => {
    const r = parseAgentMessage(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
});

describe('hub -> agent messages', () => {
  it('covers every D3 hub message type', () => {
    expect(new Set(validHub.map(([t]) => t))).toEqual(new Set(HUB_MESSAGE_TYPES));
  });

  it.each(validHub)('accepts valid %s', (type, payload, extra) => {
    const r = parseHubMessage(JSON.stringify(envelope(type, payload, extra)));
    expect(r.ok).toBe(true);
  });

  it.each([
    ['command without id', envelope('session.interrupt', { sessionId: SID })],
    ['bad permission mode', envelope('session.set_mode', { sessionId: SID, mode: 'yolo' }, { id: 'x' })],
    ['restore url outside /agent-api/restore', envelope('file.restore', { sessionId: SID, cwd: '/x', url: 'https://evil/x', sha256: SHA }, { id: 'x' })],
    ['bad scope', envelope('permission.response', { requestId: UUID2, behavior: 'allow', scope: 'forever' })],
    ['welcome without cursors', envelope('welcome', { runnerId: 'hp', protocol: '1.0' })],
  ])('rejects %s', (_name, msg) => {
    const r = parseHubMessage(JSON.stringify(msg));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });
});

// Desktop-app and Remote Control sessions have UUID v5 ids (D3): every schema with a session id accepts them.
describe('UUID v5 session ids (desktop, Remote Control)', () => {
  const V5 = ['dd346743-9bbb-5c33-a0c4-38db15ed5df6', 'cc291a76-eb90-59b0-a1b9-9176313c9413'];
  const swap = (v: unknown, id: string): unknown => JSON.parse(JSON.stringify(v).split(SID).join(id));
  it.each(V5)('agent messages with %s', id => {
    for (const [type, payload, extra] of validAgent) {
      const r = parseAgentMessage(JSON.stringify(envelope(type, swap(payload, id), extra ?? {})));
      expect(r.ok, type).toBe(true);
    }
  });
  it.each(V5)('hub messages with %s', id => {
    for (const [type, payload, extra] of validHub) {
      const r = parseHubMessage(JSON.stringify(envelope(type, swap(payload, id), extra ?? {})));
      expect(r.ok, type).toBe(true);
    }
  });
  it('a bad attachment (unknown mime, >10) is refused', () => {
    const one = { sha256: SHA, mime: 'image/png', size: 1, url: '/agent-api/blobs/t' };
    expect(parseHubMessage(JSON.stringify(envelope('session.send', { sessionId: SID, text: 'x', promptUuid: UUID2, attachments: [{ ...one, mime: 'text/html' }] }, { id: 'a' }))).ok).toBe(false);
    expect(parseHubMessage(JSON.stringify(envelope('session.send', { sessionId: SID, text: 'x', promptUuid: UUID2, attachments: Array(11).fill(one) }, { id: 'a' }))).ok).toBe(false);
  });
});

// Requirement: Протокол хаб↔агент 1.4
describe('1.4: subscriptions', () => {
  const SUB_ID = '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d';
  const TOKEN = 'sk-ant-oat01-' + 'Ab9_-'.repeat(16);
  const sub = { id: SUB_ID, token: TOKEN };
  const start = { sessionId: SID, cwd: '/x', permissionMode: 'default', model: 'opus', prompt: 'hi', promptUuid: UUID2 };
  const resume = { sessionId: SID, cwd: '/x', permissionMode: 'default' };
  const handoff = { transcript: 't', model: 'sonnet', systemPrompt: 's' };
  const commands: Array<[string, Record<string, unknown>]> = [
    ['session.start', start],
    ['session.resume', resume],
    ['handoff.generate', handoff],
  ];
  const hub = (type: string, payload: unknown) => parseHubMessage(JSON.stringify(envelope(type, payload, { id: 'c1' })));
  const usage = { inputTokens: 2, outputTokens: 186, cacheReadTokens: 1000, cacheCreationTokens: 50 };
  const result = { sessionId: SID, subtype: 'success', isError: true, durationMs: 10, costUsd: 0, errorText: 'x' };
  const agent = (payload: unknown) => parseAgentMessage(JSON.stringify(envelope('session.result', payload)));

  it.each(commands)('%s parses with and without subscription, the token kept as is', (type, payload) => {
    const without = hub(type, payload);
    expect(without.ok).toBe(true);
    if (without.ok) expect(without.message.payload).not.toHaveProperty('subscription');
    const withSub = hub(type, { ...payload, subscription: sub });
    expect(withSub.ok).toBe(true);
    if (withSub.ok) expect((withSub.message.payload as { subscription?: unknown }).subscription).toEqual(sub);
  });

  it('accepts an optional project id on session start and resume', () => {
    expect(hub('session.start', { ...start, projectId: SID }).ok).toBe(true);
    expect(hub('session.resume', { ...resume, projectId: SID }).ok).toBe(true);
    expect(hub('session.start', { ...start, projectId: 'not-a-guid' }).ok).toBe(false);
  });

  it('1.15: an optional project catalogue on session start and resume, at most 200 entries', () => {
    const entry = { id: SID, name: 'Agent Hub', description: null, remote: 'git.example.com/alice/agent-hub', path: 'C:\\code\\agent-hub', current: true };
    expect(hub('session.start', { ...start, projectCatalog: [entry] }).ok).toBe(true);
    expect(hub('session.resume', { ...resume, projectCatalog: [] }).ok).toBe(true);
    expect(hub('session.start', { ...start, projectCatalog: [{ ...entry, current: undefined }] }).ok).toBe(false);
    expect(hub('session.start', { ...start, projectCatalog: Array.from({ length: 201 }, () => entry) }).ok).toBe(false);
  });

  it.each([
    ['a space inside', 'sk-ant-oat01-abc def-0123456789'],
    ['a trailing newline', TOKEN + '\n'],
    ['19 chars', 'x'.repeat(19)],
    ['empty', ''],
    ['over 4096 chars', 'x'.repeat(4097)],
  ])('a token with %s is refused', (_name, token) => {
    for (const [type, payload] of commands) {
      const r = hub(type, { ...payload, subscription: { id: SUB_ID, token } });
      expect(r.ok, type).toBe(false);
      if (!r.ok) expect(r.reason).toBe('invalid');
    }
  });

  it('a token of exactly 20 chars is accepted; a subscription id that is not a uuid is refused', () => {
    expect(hub('session.start', { ...start, subscription: { id: SUB_ID, token: 'x'.repeat(20) } }).ok).toBe(true);
    expect(hub('session.start', { ...start, subscription: { id: 'sub-1', token: TOKEN } }).ok).toBe(false);
  });

  it('session.result with usage and each failure kind parses', () => {
    expect(agent({ ...result, usage }).ok).toBe(true);
    for (const kind of TURN_FAILURE_KINDS) {
      const r = agent({ ...result, usage, failure: { kind } });
      expect(r.ok, kind).toBe(true);
    }
    const full = agent({ ...result, failure: { kind: 'subscription_limit', resetsAt: 1793079600000, limitType: 'five_hour', message: "You've hit your session limit" } });
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.message.payload).toMatchObject({ failure: { kind: 'subscription_limit', resetsAt: 1793079600000, limitType: 'five_hour' } });
  });

  it('an unknown limitType is accepted (a new SDK value must not break parsing)', () => {
    expect(agent({ ...result, failure: { kind: 'subscription_limit', limitType: 'seven_day_fable_2027' } }).ok).toBe(true);
  });

  it.each([
    ['an unknown failure kind', { failure: { kind: 'quota_exceeded' } }],
    ['a failure without kind', { failure: { resetsAt: 1 } }],
    ['a negative resetsAt', { failure: { kind: 'subscription_limit', resetsAt: -1 } }],
    ['a limitType over 64 chars', { failure: { kind: 'subscription_limit', limitType: 'x'.repeat(65) } }],
    ['a fractional token count', { usage: { ...usage, inputTokens: 1.5 } }],
    ['a negative token count', { usage: { ...usage, outputTokens: -1 } }],
    ['usage without a field', { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }],
  ])('session.result with %s is refused', (_name, extra) => {
    const r = agent({ ...result, ...extra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  describe('a peer of 1.3 (schema snapshot) takes 1.4 messages', () => {
    it('hub 1.3 parses session.result with usage and failure, dropping them', () => {
      const raw = JSON.stringify(envelope('session.result', { ...result, usage, failure: { kind: 'subscription_limit', resetsAt: 1, limitType: 'five_hour' } }));
      const r = v13.parseAgentMessage(raw);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.message.payload).toEqual(result);
      }
    });

    it.each(commands)('agent 1.3 parses %s with subscription, dropping it', (type, payload) => {
      const r = v13.parseHubMessage(JSON.stringify(envelope(type, { ...payload, subscription: sub }, { id: 'c1' })));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.message.payload).not.toHaveProperty('subscription');
    });

    it('every message type 1.3 knows still parses under 1.3 the way 1.5 builds it', () => {
      for (const [type, payload, extra] of validAgent) {
        if (!(v13.AGENT_MESSAGE_TYPES as string[]).includes(type)) continue;
        expect(v13.parseAgentMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
      }
      for (const [type, payload, extra] of validHub) {
        if (!(v13.HUB_MESSAGE_TYPES as string[]).includes(type)) continue;
        expect(v13.parseHubMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
      }
    });
  });
});

// Requirement: Протокол хаб↔агент 1.5 — agents of 1.4 (claude-subscriptions) keep working with a hub of 1.5.
describe('1.5 <-> 1.4 (schema snapshot of claude-subscriptions)', () => {
  it('the snapshot is 1.4 and knows neither agent.update nor agent.status', () => {
    expect(v14.PROTOCOL_VERSION).toBe('1.4');
    expect(v14.HUB_MESSAGE_TYPES).not.toContain('agent.update');
    expect(v14.AGENT_MESSAGE_TYPES).not.toContain('agent.status');
  });

  it('every message type 1.4 knows parses under 1.4 the way 1.5 builds it', () => {
    let n = 0;
    for (const [type, payload, extra] of validAgent) {
      if (!(v14.AGENT_MESSAGE_TYPES as string[]).includes(type)) continue;
      expect(v14.parseAgentMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
      n++;
    }
    for (const [type, payload, extra] of validHub) {
      if (!(v14.HUB_MESSAGE_TYPES as string[]).includes(type)) continue;
      expect(v14.parseHubMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(20);
  });

  it('a 1.4 hello (no claude, protectedDirs, arch) parses under 1.5; agent.update is offered from 1.5 only', () => {
    const r = parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, protocol: '1.4' })));
    expect(r.ok).toBe(true);
    expect(protocolAtLeast('1.4', AGENT_UPDATE_PROTOCOL)).toBe(false);
    expect(protocolAtLeast('1.4', SUBSCRIPTIONS_PROTOCOL)).toBe(true);
    expect(protocolAtLeast('1.5', AGENT_UPDATE_PROTOCOL)).toBe(true);
  });
});

// Requirement: Версионированный протокол лимитов (subscription-limits L3, task 2.1).
describe('1.6: limits.probe and limits.event', () => {
  const SUB_ID = '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d';
  const TOKEN = 'sk-ant-oat01-' + 'Ab9_-'.repeat(16);
  const win = { type: 'seven_day', utilization: 100, resetsAt: '2026-10-29T15:00:00Z', status: 'rejected' };
  const event = (snapshot: unknown, extra: Record<string, unknown> = {}) =>
    parseAgentMessage(JSON.stringify(envelope('limits.event', { sessionId: SID, snapshot, quiet: false, observedAt: 1, ...extra })));
  const snap = (windows: unknown[], overage: unknown = null) => ({ windows, overage });

  it('a window with nulls, an unknown key and a surpassedThreshold parses; unknown fields are dropped', () => {
    const r = event(
      snap([
        { type: 'seven_day_future', utilization: null, resetsAt: null, status: null, extra: 1 },
        { ...win, surpassedThreshold: 100 },
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'limits.event') {
      expect(r.message.payload.snapshot!.windows[0]).toEqual({ type: 'seven_day_future', utilization: null, resetsAt: null, status: null });
      expect(r.message.payload.snapshot!.windows[1]!.surpassedThreshold).toBe(100);
    }
  });

  it('an unknown window or overage status becomes unknown', () => {
    const r = event(snap([{ ...win, status: 'throttled_2027' }], { status: 'weird', inUse: false, enabled: null, disabledReason: 'out_of_credits' }));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'limits.event') {
      expect(r.message.payload.snapshot!.windows[0]!.status).toBe('unknown');
      expect(r.message.payload.snapshot!.overage).toEqual({ status: 'unknown', inUse: false, enabled: null, disabledReason: 'out_of_credits' });
    }
  });

  it('quiet: snapshot null', () => {
    expect(event(null, { quiet: true }).ok).toBe(true);
  });

  it.each([
    ['a percent over 100', snap([{ ...win, utilization: 100.5 }])],
    ['a negative percent', snap([{ ...win, utilization: -1 }])],
    ['a reset time that is not ISO', snap([{ ...win, resetsAt: '1793264400' }])],
    ['an empty type', snap([{ ...win, type: '' }])],
    ['17 windows', snap(Array(17).fill(win))],
  ])('limits.event with %s is invalid', (_n, s) => {
    expect(event(s)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('limits.probe needs a subscription with a token and a model; it is a command (id)', () => {
    const probe = (payload: unknown, extra: { id?: string } = { id: 'p1' }) => parseHubMessage(JSON.stringify(envelope('limits.probe', payload, extra)));
    expect(probe({ subscription: { id: SUB_ID, token: TOKEN }, model: 'haiku' }).ok).toBe(true);
    expect(probe({ subscription: { id: SUB_ID, token: TOKEN }, model: 'haiku' }, {})).toMatchObject({ ok: false, reason: 'invalid' });
    expect(probe({ model: 'haiku' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(probe({ subscription: { id: SUB_ID, token: 'short' }, model: 'haiku' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(probe({ subscription: { id: SUB_ID, token: TOKEN }, model: '' })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('cmd.ok of limits.probe: every outcome parses with the result schema; a bad outcome does not', () => {
    for (const outcome of LIMITS_PROBE_OUTCOMES) {
      expect(limitsProbeResultSchema.safeParse({ outcome, snapshot: null, resetsAt: null, limitType: null, message: null, durationMs: 1200 }).success, outcome).toBe(true);
    }
    expect(limitsProbeResultSchema.safeParse({ outcome: 'ok', snapshot: snap([win]), resetsAt: '2026-10-29T15:00:00.000Z', limitType: 'seven_day', message: null, durationMs: 0 }).success).toBe(true);
    expect(limitsProbeResultSchema.safeParse({ outcome: 'maybe', snapshot: null, resetsAt: null, limitType: null, message: null, durationMs: 1 }).success).toBe(false);
    expect(LIMITS_PROBE_ERRORS).toEqual(['probe_failed', 'probe_timeout', 'probe_busy']);
  });

  describe('a peer of 1.5 (schema snapshot) and 1.6', () => {
    it('the snapshot is 1.5 and knows neither limits.probe nor limits.event', () => {
      expect(v15.PROTOCOL_VERSION).toBe('1.5');
      expect(v15.HUB_MESSAGE_TYPES).not.toContain('limits.probe');
      expect(v15.AGENT_MESSAGE_TYPES).not.toContain('limits.event');
    });

    it('a hub of 1.5 ignores limits.event as an unknown type; an agent of 1.5 ignores limits.probe as one', () => {
      expect(v15.parseAgentMessage(JSON.stringify(envelope('limits.event', { sessionId: SID, snapshot: null, quiet: true, observedAt: 1 })))).toEqual({
        ok: false,
        reason: 'unknown_type',
        type: 'limits.event',
      });
      expect(v15.parseHubMessage(JSON.stringify(envelope('limits.probe', { subscription: { id: SUB_ID, token: TOKEN }, model: 'haiku' }, { id: 'p' })))).toMatchObject({
        ok: false,
        reason: 'unknown_type',
      });
    });

    it('every message type 1.5 knows parses under 1.5 the way 1.6 builds it', () => {
      let n = 0;
      for (const [type, payload, extra] of validAgent) {
        if (!(v15.AGENT_MESSAGE_TYPES as string[]).includes(type)) continue;
        expect(v15.parseAgentMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
        n++;
      }
      for (const [type, payload, extra] of validHub) {
        if (!(v15.HUB_MESSAGE_TYPES as string[]).includes(type)) continue;
        expect(v15.parseHubMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
        n++;
      }
      expect(n).toBeGreaterThan(30);
    });

    it('limits are offered from 1.6 only', () => {
      expect(protocolAtLeast('1.5', LIMITS_PROTOCOL)).toBe(false);
      expect(protocolAtLeast('1.6', LIMITS_PROTOCOL)).toBe(true);
    });
  });
});

// Requirement: Статус MCP сессии; Совместимость управления MCP с агентом (mcp-management M2, task 1.1).
describe('1.7: MCP snapshots and commands', () => {
  const row = { name: 'vaultwarden', status: 'connected', transport: 'stdio', toolCount: 3 };
  const status = (servers: unknown[], extra: Record<string, unknown> = {}) =>
    parseAgentMessage(JSON.stringify(envelope('mcp.status', { sessionId: SID, snapshot: { servers, observedAt: 1, ...extra } })));

  it('an unknown status becomes unknown, an unknown transport other; the other servers stay as they are', () => {
    const r = status([
      { ...row, status: 'throttled-2027', transport: 'websocket' },
      { ...row, name: 'notion', status: 'needs-auth', transport: 'http', target: 'https://mcp.notion.com/mcp' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'mcp.status') {
      expect(r.message.payload.snapshot.servers[0]).toMatchObject({ status: 'unknown', transport: 'other' });
      expect(r.message.payload.snapshot.servers[1]).toMatchObject({ status: 'needs-auth', transport: 'http' });
    }
  });

  it('unknown fields are dropped (env, headers, config never pass through)', () => {
    const r = status([{ ...row, env: { API_TOKEN: 'secret' }, headers: { Authorization: 'Bearer x' }, config: { command: 'x' } }]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'mcp.status') expect(r.message.payload.snapshot.servers[0]).toEqual(row);
  });

  it.each([
    ['101 servers', Array.from({ length: 101 }, (_, i) => ({ ...row, name: `s${i}` }))],
    ['an empty name', [{ ...row, name: '' }]],
    ['an error over 1000 characters', [{ ...row, status: 'failed', error: 'x'.repeat(1001) }]],
    ['a target over 500 characters', [{ ...row, target: 'x'.repeat(501) }]],
    ['a negative tool count', [{ ...row, toolCount: -1 }]],
  ])('mcp.status with %s is invalid', (_n, servers) => {
    expect(status(servers)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('100 servers is the limit', () => {
    expect(status(Array.from({ length: 100 }, (_, i) => ({ ...row, name: `s${i}` }))).ok).toBe(true);
  });

  it('commands need an id; mcp.action knows reconnect/enable/disable only; mcp.auth.start needs a URL', () => {
    const hub = (type: string, payload: unknown, extra: { id?: string } = { id: 'm1' }) => parseHubMessage(JSON.stringify(envelope(type, payload, extra)));
    expect(hub('mcp.status.get', { sessionId: SID }, {})).toMatchObject({ ok: false, reason: 'invalid' });
    expect(hub('mcp.action', { sessionId: SID, server: 'x', action: 'restart' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(hub('mcp.action', { sessionId: SID, server: '', action: 'reconnect' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(hub('mcp.auth.start', { sessionId: SID, server: 'n', redirectUri: 'not a url' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(hub('mcp.machine.probe', {}).ok).toBe(true);
  });

  it('results of mcp.auth.start and mcp.machine.probe; error codes', () => {
    expect(mcpAuthStartResultSchema.safeParse({ authUrl: 'https://p/authorize', redirect: 'hub', state: 's' }).success).toBe(true);
    expect(mcpAuthStartResultSchema.safeParse({ authUrl: 'https://p/authorize', redirect: 'localhost', state: 's', callbackPort: 53412 }).success).toBe(true);
    expect(mcpAuthStartResultSchema.safeParse({ authUrl: 'https://p/authorize', redirect: 'custom', state: 's' }).success).toBe(false);
    // the page a browser opens: https only, http for a local provider
    for (const authUrl of ['javascript:alert(1)', 'http://evil.example/authorize', 'data:text/html,x', 'file:///etc/passwd', 'not a url'])
      expect(mcpAuthStartResultSchema.safeParse({ authUrl, redirect: 'hub', state: 's' }).success).toBe(false);
    for (const authUrl of ['http://localhost:8080/authorize', 'http://127.0.0.1:9/a']) expect(mcpAuthStartResultSchema.safeParse({ authUrl, redirect: 'hub', state: 's' }).success).toBe(true);
    expect(mcpProbeResultSchema.safeParse({ snapshot: { servers: [row], observedAt: 1 }, durationMs: 1500 }).success).toBe(true);
    expect(MCP_ERROR_CODES).toEqual([
      'not_running',
      'mcp_unknown_server',
      'mcp_auth_unsupported',
      'mcp_auth_state_mismatch',
      'mcp_auth_failed',
      'mcp_action_failed',
      'mcp_probe_busy',
      'mcp_probe_timeout',
      'not_implemented',
    ]);
  });

  describe('a peer of 1.6 (schema snapshot) and 1.7', () => {
    const MCP_AGENT = ['mcp.status', 'mcp.auth.done'];
    const MCP_HUB = ['mcp.status.get', 'mcp.action', 'mcp.auth.start', 'mcp.auth.callback', 'mcp.machine.probe'];

    it('the snapshot is 1.6 and knows no MCP message', () => {
      expect(v16.PROTOCOL_VERSION).toBe('1.6');
      for (const t of MCP_AGENT) expect(v16.AGENT_MESSAGE_TYPES).not.toContain(t);
      for (const t of MCP_HUB) expect(v16.HUB_MESSAGE_TYPES).not.toContain(t);
    });

    it('a peer of 1.6 ignores every MCP message as an unknown type', () => {
      for (const [type, payload, extra] of validAgent.filter(([t]) => MCP_AGENT.includes(t))) {
        expect(v16.parseAgentMessage(JSON.stringify(envelope(type, payload, extra)))).toEqual({ ok: false, reason: 'unknown_type', type });
      }
      for (const [type, payload, extra] of validHub.filter(([t]) => MCP_HUB.includes(t))) {
        expect(v16.parseHubMessage(JSON.stringify(envelope(type, payload, extra)))).toEqual({ ok: false, reason: 'unknown_type', type });
      }
    });

    it('every message type 1.6 knows parses under 1.6 the way 1.7 builds it', () => {
      let n = 0;
      for (const [type, payload, extra] of validAgent) {
        if (!(v16.AGENT_MESSAGE_TYPES as string[]).includes(type)) continue;
        expect(v16.parseAgentMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
        n++;
      }
      for (const [type, payload, extra] of validHub) {
        if (!(v16.HUB_MESSAGE_TYPES as string[]).includes(type)) continue;
        expect(v16.parseHubMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
        n++;
      }
      expect(n).toBeGreaterThan(35);
    });

    it('MCP is offered from 1.7 only', () => {
      expect(protocolAtLeast('1.6', MCP_PROTOCOL)).toBe(false);
      expect(protocolAtLeast('1.7', MCP_PROTOCOL)).toBe(true);
    });
  });
});

describe('1.8: the OAuth mark and mcp.auth.logout (mcp-auth-controls A4)', () => {
  const row = { name: 'notion', status: 'connected', transport: 'http', target: 'https://mcp.notion.com/mcp', toolCount: 3 };
  const status = (servers: unknown[]) => JSON.stringify(envelope('mcp.status', { sessionId: SID, snapshot: { servers, observedAt: 1 } }));

  it('a snapshot with and without `oauth` passes; a non-boolean does not', () => {
    for (const r of [row, { ...row, oauth: true }, { ...row, oauth: false }]) expect(parseAgentMessage(status([r])).ok).toBe(true);
    expect(parseAgentMessage(status([{ ...row, oauth: 'yes' }]))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('mcp.auth.logout is a hub command with an id and a server', () => {
    expect(HUB_MESSAGE_TYPES).toContain('mcp.auth.logout');
    const hub = (payload: unknown, extra: { id?: string } = { id: 'm1' }) => parseHubMessage(JSON.stringify(envelope('mcp.auth.logout', payload, extra)));
    expect(hub({ sessionId: SID, server: 'notion' }).ok).toBe(true);
    expect(hub({ sessionId: SID, server: 'notion' }, {})).toMatchObject({ ok: false, reason: 'invalid' });
    expect(hub({ sessionId: SID, server: '' })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('a peer of 1.7 accepts a 1.8 snapshot (the field is dropped) and ignores mcp.auth.logout as unknown', () => {
    expect(v17.PROTOCOL_VERSION).toBe('1.7');
    const r = v17.parseAgentMessage(status([{ ...row, oauth: true }]));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'mcp.status') expect(r.message.payload.snapshot.servers[0]).toEqual(row);
    expect(v17.parseHubMessage(JSON.stringify(envelope('mcp.auth.logout', { sessionId: SID, server: 'notion' }, { id: 'm1' })))).toEqual({
      ok: false,
      reason: 'unknown_type',
      type: 'mcp.auth.logout',
    });
  });

  it('every message type 1.7 knows parses under 1.7 the way 1.8 builds it', () => {
    let n = 0;
    for (const [type, payload, extra] of validAgent) {
      if (!(v17.AGENT_MESSAGE_TYPES as string[]).includes(type)) continue;
      expect(v17.parseAgentMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
      n++;
    }
    for (const [type, payload, extra] of validHub) {
      if (!(v17.HUB_MESSAGE_TYPES as string[]).includes(type)) continue;
      expect(v17.parseHubMessage(JSON.stringify(envelope(type, payload, extra))).ok, type).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(40);
  });

  it('sign-out is offered from 1.8 only', () => {
    expect(protocolAtLeast('1.7', MCP_AUTH_CONTROLS_PROTOCOL)).toBe(false);
    expect(protocolAtLeast('1.8', MCP_AUTH_CONTROLS_PROTOCOL)).toBe(true);
  });
});

describe('providers (agent-providers, protocol 1.10)', () => {
  it('provider in session commands is optional and only claude|codex', () => {
    const base = { sessionId: SID, cwd: '/x', permissionMode: 'default', model: 'm', prompt: 'p', promptUuid: UUID2 };
    expect(parseHubMessage(JSON.stringify(envelope('session.start', { ...base, provider: 'codex' }, { id: 'a' }))).ok).toBe(true);
    expect(parseHubMessage(JSON.stringify(envelope('session.start', base, { id: 'b' }))).ok).toBe(true);
    expect(parseHubMessage(JSON.stringify(envelope('session.start', { ...base, provider: 'gemini' }, { id: 'c' }))).ok).toBe(false);
  });
  it('hello carries the providers with sign-in and models, never more than the schema', () => {
    const r = parseAgentMessage(
      JSON.stringify(
        envelope('hello', { ...hello, providers: [{ id: 'codex', version: '0.166.0', login: 'ok', account: { email: 'a@b.c', plan: 'pro' }, models: [{ value: 'gpt', displayName: 'GPT' }] }] }),
      ),
    );
    expect(r.ok).toBe(true);
    expect(parseAgentMessage(JSON.stringify(envelope('hello', { ...hello, providers: [{ id: 'claude', version: null, login: 'ok' }] }))).ok).toBe(false);
  });
});
