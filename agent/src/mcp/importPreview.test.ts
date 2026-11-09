import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpImportPreviewResultPayload } from '@agent-hub/shared';
import { McpImportPreviewer } from './importPreview.js';

describe('McpImportPreviewer', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });
  it('collects user, local and .mcp.json entries with one-time secrets and leaves sources unchanged', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-import-'));
    const project = join(root, 'project');
    await mkdir(project);
    const userPath = join(root, '.claude.json'),
      projectPath = join(project, '.mcp.json');
    const userText = JSON.stringify({
      mcpServers: { global: { command: 'node', args: ['global.js'], env: { API_TOKEN: 'user-secret' } } },
      projects: { [project]: { mcpServers: { local: { command: 'node', args: ['local.js'] } } } },
    });
    const projectText = JSON.stringify({
      mcpServers: {
        project: { command: 'node', args: ['project.js'], env: { TOKEN: 'project-secret' } },
        remote: { type: 'http', url: 'https://example.test/mcp?api_key=url-secret', headers: { Authorization: 'header-secret' } },
      },
    });
    await writeFile(userPath, userText);
    await writeFile(projectPath, projectText);
    const userBefore = await stat(userPath),
      projectBefore = await stat(projectPath);
    const preview = await new McpImportPreviewer(root).preview({ machineId: '00000000-0000-4000-8000-000000000001', projectRoot: project });
    expect(preview.servers.map(s => s.name)).toEqual(['global', 'local', 'project', 'remote']);
    expect(preview.servers.map(s => s.source)).toEqual(['user', 'local', 'project', 'project']);
    expect(preview.secretsCaptured).toBe(4);
    expect(preview.secretValues.map(s => s.location)).toEqual(['env', 'env', 'url', 'header']);
    expect(JSON.stringify(preview.servers)).not.toContain('project-secret');
    expect(JSON.stringify(preview.servers)).not.toContain('url-secret');
    expect(await readFile(userPath, 'utf8')).toBe(userText);
    expect(await readFile(projectPath, 'utf8')).toBe(projectText);
    const userAfter = await stat(userPath),
      projectAfter = await stat(projectPath);
    expect(userAfter.mtimeMs).toBe(userBefore.mtimeMs);
    expect(projectAfter.mtimeMs).toBe(projectBefore.mtimeMs);
    expect(preview.secretValues.every(value => value.entryId === undefined)).toBe(true);
  });

  it('keeps an empty sensitive value as a literal, so the preview result passes the hub schema', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-import-'));
    await writeFile(
      join(root, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          banana: { command: 'node', args: ['banana.js'], env: { GEMINI_API_KEY: '' } },
          remote: { type: 'http', url: 'https://example.test/mcp?token=', headers: { Authorization: '' } },
        },
      }),
    );
    const preview = await new McpImportPreviewer(root, { CODEX_HOME: join(root, 'codex') }, false).preview({ machineId: '00000000-0000-4000-8000-000000000001', projectRoot: root, projectRoots: [] });
    expect(preview.secretValues).toEqual([]);
    expect(preview.servers.find(s => s.name === 'banana')?.env).toEqual({ GEMINI_API_KEY: { kind: 'literal', value: '' } });
    expect(mcpImportPreviewResultPayload.safeParse(preview).success).toBe(true);
  });

  it('collects import v2 sources: every Claude project, Codex config.toml and enabled plugins', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-import-v2-'));
    const bound = join(root, 'bound');
    const other = join(root, 'other');
    const codexHome = join(root, 'codex');
    const pluginPath = join(root, '.claude', 'plugins', 'cache', 'corp', 'corp-apps', '1.1.1');
    const offPluginPath = join(root, '.claude', 'plugins', 'cache', 'corp', 'off', '1.0.0');
    await mkdir(bound);
    await mkdir(codexHome);
    await mkdir(pluginPath, { recursive: true });
    await mkdir(offPluginPath, { recursive: true });
    const userText = JSON.stringify({
      mcpServers: { shared: { command: 'node', args: ['shared.js'] }, clash: { command: 'node', args: ['claude.js'] } },
      projects: {
        [bound.replaceAll('\\', '/') + '/']: { mcpServers: { boundLocal: { command: 'node', args: ['bound.js'] } } },
        [other]: { mcpServers: { otherLocal: { type: 'sse', url: 'https://other.test/sse' } } },
      },
    });
    await writeFile(join(root, '.claude.json'), userText);
    await writeFile(join(bound, '.mcp.json'), JSON.stringify({ mcpServers: { team: { command: 'npx', args: ['team'] } } }));
    const codexText = [
      '[mcp_servers.shared]',
      'command = "node"',
      'args = ["shared.js"]',
      '[mcp_servers.clash]',
      'command = "node"',
      'args = ["codex.js"]',
      '[mcp_servers.off]',
      'command = "node"',
      'enabled = false',
      '[mcp_servers.docs]',
      'url = "https://docs.test/mcp"',
      'bearer_token_env_var = "DOCS_TOKEN"',
      'http_headers = { "X-Team" = "core" }',
      'env_http_headers = { "X-Api-Key" = "DOCS_KEY" }',
      '[mcp_servers.local]',
      'command = "python"',
      'args = ["server.py"]',
      'env = { API_TOKEN = "codex-secret", MODE = "dev" }',
    ].join('\n');
    await writeFile(join(codexHome, 'config.toml'), codexText);
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'corp-apps@corp': true, 'off@corp': false } }));
    await writeFile(
      join(root, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'corp-apps@corp': [{ scope: 'user', installPath: pluginPath, version: '1.1.1' }],
          'off@corp': [{ scope: 'user', installPath: offPluginPath, version: '1.0.0' }],
        },
      }),
    );
    const pluginServers = {
      apps: { type: 'http', url: 'https://apps.corp.example/api/mcp', oauth: { clientId: 'apps-portal-mcp' } },
      tool: { command: '${CLAUDE_PLUGIN_ROOT}/bin/tool', args: ['--root', '${CLAUDE_PLUGIN_ROOT}'] },
    };
    await writeFile(join(pluginPath, '.mcp.json'), JSON.stringify({ mcpServers: pluginServers }));
    await writeFile(join(offPluginPath, '.mcp.json'), JSON.stringify({ mcpServers: { hidden: { command: 'node' } } }));
    const env = { CODEX_HOME: codexHome, DOCS_TOKEN: 'bearer-secret', DOCS_KEY: 'key-secret' };
    const projectId = '00000000-0000-4000-8000-0000000000aa';
    const machineId = '00000000-0000-4000-8000-000000000001';
    const preview = await new McpImportPreviewer(root, env, true).preview({ machineId, projectRoot: bound, projectRoots: [{ projectId, path: bound }] });
    const byName = new Map(preview.servers.map(server => [server.name, server]));
    expect(preview.servers.map(server => `${server.source}:${server.name}`)).toEqual([
      'user:shared',
      'user:clash',
      'local:boundLocal',
      'local:otherLocal',
      'project:team',
      'codex:docs',
      'codex:local',
      'plugin:plugin_corp-apps_apps',
      'plugin:plugin_corp-apps_tool',
    ]);
    expect(byName.get('boundLocal')).toMatchObject({ projectId, origin: bound.replaceAll('\\', '/') + '/' });
    expect(byName.get('boundLocal')?.warnings).toBeUndefined();
    expect(byName.get('otherLocal')).toMatchObject({ transport: 'sse', mode: 'remote', origin: other, warnings: ['unbound-path'] });
    expect(byName.get('otherLocal')?.projectId).toBeUndefined();
    expect(byName.get('team')).toMatchObject({ projectId, origin: bound });
    expect(byName.get('docs')).toMatchObject({ transport: 'http', url: 'https://docs.test/mcp', headers: { 'X-Team': { kind: 'literal', value: 'core' } } });
    expect(byName.get('docs')?.headers?.Authorization).toMatchObject({ kind: 'secret' });
    expect(byName.get('docs')?.headers?.['X-Api-Key']).toMatchObject({ kind: 'secret' });
    expect(byName.get('local')?.env).toMatchObject({ API_TOKEN: { kind: 'secret' }, MODE: { kind: 'literal', value: 'dev' } });
    expect(byName.get('plugin_corp-apps_apps')).toMatchObject({ oauthClientId: 'apps-portal-mcp', origin: 'corp-apps@corp', mode: 'remote' });
    expect(byName.get('plugin_corp-apps_tool')).toMatchObject({ command: `${pluginPath}/bin/tool`, args: ['--root', pluginPath] });
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Codex MCP server off'), expect.stringContaining('Codex MCP server clash')]));
    expect(preview.secretValues.map(value => [value.serverName, value.location, value.key, value.value])).toEqual([
      ['docs', 'header', 'X-Api-Key', 'key-secret'],
      ['docs', 'header', 'Authorization', 'Bearer bearer-secret'],
      ['local', 'env', 'API_TOKEN', 'codex-secret'],
    ]);
    expect(preview.secretValues.map(value => value.entryId)).toEqual([byName.get('docs')?.id, byName.get('docs')?.id, byName.get('local')?.id]);
    expect(JSON.stringify(preview.servers)).not.toMatch(/bearer-secret|key-secret|codex-secret/);
    expect(mcpImportPreviewResultPayload.safeParse(preview).success).toBe(true);
    expect(await readFile(join(root, '.claude.json'), 'utf8')).toBe(userText);
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(codexText);
  });

  it('falls back to ~/.codex when CODEX_HOME is unset and reports unreadable config.toml', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-import-codex-'));
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex', 'config.toml'), '[mcp_servers.broken\ncommand = ');
    const preview = await new McpImportPreviewer(root, {}, false).preview({
      machineId: '00000000-0000-4000-8000-000000000001',
      projectRoot: root,
      projectRoots: [],
    });
    expect(preview.servers).toEqual([]);
    expect(preview.warnings).toEqual([expect.stringContaining('config.toml')]);
  });
});
