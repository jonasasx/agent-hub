import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PayloadOf } from '@agent-hub/shared';

type ImportRequest = PayloadOf<import('@agent-hub/shared').HubMessage, 'mcp.import.preview'>;
type ImportServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  mode: 'machine-shared' | 'remote';
  command?: string;
  args?: string[];
  url?: string;
  urlSecretId?: string;
  env?: Record<string, { kind: 'literal'; value: string } | { kind: 'secret'; secretId: string }>;
  headers?: Record<string, { kind: 'literal'; value: string } | { kind: 'secret'; secretId: string }>;
  secrets: Array<{ secretId: string; name: string; state: 'set' }>;
  machineScope: { allMachines: false; machineIds: string[] };
  projectIds: string[];
  revision: 0;
  source: 'user' | 'local' | 'project';
};
export interface ImportPreview {
  importId: string;
  servers: ImportServer[];
  secretsCaptured: number;
  warnings: string[];
  /** Sensitive payload: one-time transfer to the authenticated hub for immediate encryption. Never log. */
  secretValues: Array<{ serverName: string; location: 'env' | 'header' | 'url'; key: string; value: string }>;
}
const SENSITIVE = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;

/** Reads only when explicitly requested by the hub; this class never writes to a source config. */
export class McpImportPreviewer {
  constructor(private readonly home = homedir()) {}

  async preview(request: ImportRequest, importId = randomUUID()): Promise<ImportPreview> {
    const warnings: string[] = [],
      candidates = new Map<string, { raw: unknown; source: 'user' | 'local' | 'project' }>();
    const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read MCP configuration at ${path}`);
        return null;
      }
    };
    const root = await readJson(join(this.home, '.claude.json'));
    const projectKey = request.projectRoot;
    this.add(candidates, root?.mcpServers, 'user', warnings);
    const projects = root?.projects && typeof root.projects === 'object' ? (root.projects as Record<string, unknown>) : {};
    const projectEntry = projects[projectKey] && typeof projects[projectKey] === 'object' ? (projects[projectKey] as Record<string, unknown>) : undefined;
    this.add(candidates, projectEntry?.mcpServers, 'local', warnings);
    const project = await readJson(join(projectKey, '.mcp.json'));
    this.add(candidates, project?.mcpServers, 'project', warnings);

    const servers: ImportServer[] = [],
      secretValues: ImportPreview['secretValues'] = [];
    for (const [name, item] of candidates) {
      const built = this.convert(name, item.raw, request.machineId, item.source, warnings);
      if (!built) continue;
      servers.push(built.server);
      secretValues.push(...built.secretValues);
    }
    return { importId, servers, secretsCaptured: secretValues.length, warnings: warnings.slice(0, 100), secretValues };
  }

  private add(target: Map<string, { raw: unknown; source: 'user' | 'local' | 'project' }>, value: unknown, source: 'user' | 'local' | 'project', warnings: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [name, raw] of Object.entries(value)) {
      if (target.has(name)) warnings.push(`Duplicate MCP server ${name}; ${source} configuration takes precedence`);
      target.set(name, { raw, source });
    }
  }

  private convert(name: string, raw: unknown, machineId: string, source: ImportServer['source'], warnings: string[]): { server: ImportServer; secretValues: ImportPreview['secretValues'] } | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`Skipped unsupported MCP entry ${name}`);
      return null;
    }
    const cfg = raw as Record<string, unknown>;
    const secretValues: ImportPreview['secretValues'] = [];
    const refs: ImportServer['secrets'] = [];
    const secretsFor = (location: 'env' | 'header' | 'url', key: string, value: string): string => {
      const secretId = randomUUID();
      secretValues.push({ serverName: name, location, key, value });
      return secretId;
    };
    const transport = cfg.type === 'http' ? 'http' : cfg.type === 'sse' ? 'sse' : 'stdio';
    let url = typeof cfg.url === 'string' ? cfg.url : undefined,
      urlSecretId: string | undefined;
    if (transport === 'stdio' && (typeof cfg.command !== 'string' || !cfg.command)) {
      warnings.push(`Skipped MCP entry ${name}: missing stdio command`);
      return null;
    }
    if (transport !== 'stdio' && !url) {
      warnings.push(`Skipped MCP entry ${name}: missing URL`);
      return null;
    }
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.username) {
          const ref = secretsFor('url', 'username', decodeURIComponent(parsed.username));
          urlSecretId ??= ref;
          parsed.username = '__AGENT_HUB_SECRET__';
        }
        if (parsed.password) {
          const ref = secretsFor('url', 'password', decodeURIComponent(parsed.password));
          urlSecretId ??= ref;
          parsed.password = '__AGENT_HUB_SECRET__';
        }
        for (const [key, value] of parsed.searchParams)
          if (SENSITIVE.test(key)) {
            const ref = secretsFor('url', key, value);
            urlSecretId ??= ref;
            parsed.searchParams.set(key, '__AGENT_HUB_SECRET__');
          }
        url = parsed.toString();
      } catch {
        warnings.push(`Skipped MCP entry ${name}: invalid URL`);
        return null;
      }
    }
    const env = this.mapValues(name, 'env', cfg.env, refs, secretValues, secretsFor);
    const rawHeaders = cfg.headers ?? cfg.http_headers;
    const headers = this.mapValues(name, 'header', rawHeaders, refs, secretValues, secretsFor);
    return {
      server: {
        id: randomUUID(),
        name,
        enabled: true,
        transport,
        mode: transport === 'stdio' ? 'machine-shared' : 'remote',
        ...(typeof cfg.command === 'string' ? { command: cfg.command } : {}),
        ...(Array.isArray(cfg.args) && cfg.args.every(x => typeof x === 'string') ? { args: cfg.args as string[] } : {}),
        ...(url ? { url } : {}),
        ...(urlSecretId ? { urlSecretId } : {}),
        ...(env ? { env } : {}),
        ...(headers ? { headers } : {}),
        secrets: [],
        machineScope: { allMachines: false, machineIds: [machineId] },
        projectIds: [],
        revision: 0,
        source,
      },
      secretValues,
    };
  }

  private mapValues(
    name: string,
    location: 'env' | 'header',
    value: unknown,
    refs: ImportServer['secrets'],
    secretValues: ImportPreview['secretValues'],
    makeSecret: (location: 'env' | 'header' | 'url', key: string, value: string) => string,
  ): ImportServer['env'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result: NonNullable<ImportServer['env']> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw !== 'string') continue;
      if (SENSITIVE.test(key)) {
        const id = makeSecret(location, key, raw);
        result[key] = { kind: 'secret', secretId: id };
      } else result[key] = { kind: 'literal', value: raw };
    }
    return result;
  }
}
