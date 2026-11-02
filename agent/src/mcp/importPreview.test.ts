import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  });
});
