import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { McpImportSource, McpImportWarning, PayloadOf } from '@agent-hub/shared';

type ImportRequest = PayloadOf<import('@agent-hub/shared').HubMessage, 'mcp.import.preview'>;
type ConfigValue = { kind: 'literal'; value: string } | { kind: 'secret'; secretId: string };
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
  env?: Record<string, ConfigValue>;
  headers?: Record<string, ConfigValue>;
  oauthClientId?: string;
  secrets: Array<{ secretId: string; name: string; state: 'set' }>;
  machineScope: { allMachines: false; machineIds: string[] };
  projectIds: string[];
  revision: 0;
  source: McpImportSource;
  origin?: string;
  projectId?: string;
  warnings?: McpImportWarning[];
};
type SecretValue = { serverName: string; entryId?: string; location: 'env' | 'header' | 'url'; key: string; value: string };
export interface ImportPreview {
  importId: string;
  servers: ImportServer[];
  secretsCaptured: number;
  warnings: string[];
  /** Sensitive payload: one-time transfer to the authenticated hub for immediate encryption. Never log. */
  secretValues: SecretValue[];
}
/** One source entry in a source-independent shape; values are plaintext until `convert` splits secrets out. */
type RawServer = {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClientId?: string;
};
type Candidate = { name: string; raw: RawServer; source: McpImportSource; origin?: string; projectId?: string; warnings?: McpImportWarning[] };

const SENSITIVE = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) if (typeof raw === 'string') result[key] = raw;
  return result;
}

/** Path key for matching `~/.claude.json` project keys against hub bindings: slashes, trailing slash and, on Windows, case. */
function pathKey(path: string, windows: boolean): string {
  const unified = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return windows ? unified.toLowerCase() : unified;
}

/** Reads only when explicitly requested by the hub; this class never writes to a source config. */
export class McpImportPreviewer {
  constructor(
    private readonly home = homedir(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly windows = process.platform === 'win32',
  ) {}

  async preview(request: ImportRequest, importId = randomUUID()): Promise<ImportPreview> {
    const warnings: string[] = [];
    const candidates = request.projectRoots ? await this.collect(request.projectRoots, warnings) : await this.collectLegacy(request.projectRoot, warnings);
    const servers: ImportServer[] = [];
    const secretValues: SecretValue[] = [];
    for (const candidate of candidates) {
      const built = this.convert(candidate, request.machineId, warnings);
      if (!built) continue;
      servers.push(built.server);
      secretValues.push(...built.secretValues);
    }
    if (!request.projectRoots) for (const value of secretValues) delete value.entryId;
    return { importId, servers, secretsCaptured: secretValues.length, warnings: warnings.slice(0, 100), secretValues };
  }

  /** Request of a hub before import v2: one project root, later sources override earlier ones by name. */
  private async collectLegacy(projectRoot: string, warnings: string[]): Promise<Candidate[]> {
    const byName = new Map<string, Candidate>();
    const add = (value: unknown, source: 'user' | 'local' | 'project') => {
      for (const candidate of this.claudeEntries(value, source, warnings)) {
        if (byName.has(candidate.name)) warnings.push(`Duplicate MCP server ${candidate.name}; ${source} configuration takes precedence`);
        byName.set(candidate.name, candidate);
      }
    };
    const root = await this.readJson(join(this.home, '.claude.json'), warnings);
    add(root?.mcpServers, 'user');
    const projects = isRecord(root?.projects) ? root.projects : {};
    add(isRecord(projects[projectRoot]) ? projects[projectRoot].mcpServers : undefined, 'local');
    const project = await this.readJson(join(projectRoot, '.mcp.json'), warnings);
    add(project?.mcpServers, 'project');
    return [...byName.values()].map(({ name, raw, source }) => ({ name, raw, source }));
  }

  /** Import v2 (D4): user, local of every project, `.mcp.json` of bound projects, Codex and enabled Claude plugins. */
  private async collect(projectRoots: Array<{ projectId: string; path: string }>, warnings: string[]): Promise<Candidate[]> {
    const bindings = new Map(projectRoots.map(root => [pathKey(root.path, this.windows), root.projectId]));
    const root = await this.readJson(join(this.home, '.claude.json'), warnings);
    const user = this.claudeEntries(root?.mcpServers, 'user', warnings);
    const local: Candidate[] = [];
    for (const [path, entry] of Object.entries(isRecord(root?.projects) ? root.projects : {})) {
      if (!isRecord(entry)) continue;
      const projectId = bindings.get(pathKey(path, this.windows));
      for (const candidate of this.claudeEntries(entry.mcpServers, 'local', warnings)) {
        local.push(projectId ? { ...candidate, origin: path, projectId } : { ...candidate, origin: path, warnings: ['unbound-path'] });
      }
    }
    const project: Candidate[] = [];
    for (const binding of projectRoots) {
      const file = await this.readJson(join(binding.path, '.mcp.json'), warnings);
      for (const candidate of this.claudeEntries(file?.mcpServers, 'project', warnings)) project.push({ ...candidate, origin: binding.path, projectId: binding.projectId });
    }
    const codex = await this.codexEntries(warnings);
    const userByName = new Map(user.map(candidate => [candidate.name, JSON.stringify(candidate.raw)]));
    const keptCodex = codex.filter(candidate => {
      const same = userByName.get(candidate.name);
      if (same === undefined) return true;
      if (same !== JSON.stringify(candidate.raw)) warnings.push(`Skipped Codex MCP server ${candidate.name}: ~/.claude.json has a different server with this name`);
      return false;
    });
    return [...user, ...local, ...project, ...keptCodex, ...(await this.pluginEntries(warnings))];
  }

  private async readJson(path: string, warnings: string[]): Promise<Record<string, unknown> | null> {
    const text = await this.readText(path, warnings);
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      return isRecord(value) ? value : null;
    } catch {
      warnings.push(`Could not read MCP configuration at ${path}`);
      return null;
    }
  }

  private async readText(path: string, warnings: string[]): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read MCP configuration at ${path}`);
      return null;
    }
  }

  /** `mcpServers` of Claude Code: `~/.claude.json`, `.mcp.json` of a project or a plugin. */
  private claudeEntries(value: unknown, source: McpImportSource, warnings: string[]): Candidate[] {
    if (!isRecord(value)) return [];
    const result: Candidate[] = [];
    for (const [name, cfg] of Object.entries(value)) {
      if (!isRecord(cfg)) {
        warnings.push(`Skipped unsupported MCP entry ${name}`);
        continue;
      }
      const raw: RawServer = { transport: cfg.type === 'http' ? 'http' : cfg.type === 'sse' ? 'sse' : 'stdio' };
      if (typeof cfg.command === 'string') raw.command = cfg.command;
      if (Array.isArray(cfg.args) && cfg.args.every(arg => typeof arg === 'string')) raw.args = cfg.args as string[];
      if (typeof cfg.url === 'string') raw.url = cfg.url;
      const env = stringMap(cfg.env);
      if (env) raw.env = env;
      const headers = stringMap(cfg.headers);
      if (headers) raw.headers = headers;
      if (isRecord(cfg.oauth) && typeof cfg.oauth.clientId === 'string') raw.oauthClientId = cfg.oauth.clientId;
      result.push({ name, raw, source });
    }
    return result;
  }

  /** `[mcp_servers.<name>]` of `$CODEX_HOME/config.toml`; bearer and env headers are read from this process environment. */
  private async codexEntries(warnings: string[]): Promise<Candidate[]> {
    const path = join(this.env.CODEX_HOME || join(this.home, '.codex'), 'config.toml');
    const text = await this.readText(path, warnings);
    if (text === null) return [];
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(text) as Record<string, unknown>;
    } catch {
      warnings.push(`Could not read MCP configuration at ${path}`);
      return [];
    }
    const result: Candidate[] = [];
    for (const [name, cfg] of Object.entries(isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {})) {
      if (!isRecord(cfg)) continue;
      if (cfg.enabled === false) {
        warnings.push(`Skipped Codex MCP server ${name}: disabled in config.toml`);
        continue;
      }
      const raw: RawServer = { transport: typeof cfg.url === 'string' ? 'http' : 'stdio' };
      if (typeof cfg.command === 'string') raw.command = cfg.command;
      if (Array.isArray(cfg.args) && cfg.args.every(arg => typeof arg === 'string')) raw.args = cfg.args as string[];
      if (typeof cfg.url === 'string') raw.url = cfg.url;
      const env = stringMap(cfg.env);
      if (env) raw.env = env;
      const headers: Record<string, string> = { ...stringMap(cfg.http_headers) };
      for (const [header, variable] of Object.entries(stringMap(cfg.env_http_headers) ?? {})) {
        const value = this.env[variable];
        if (value) headers[header] = value;
        else warnings.push(`Codex MCP server ${name}: environment variable ${variable} for header ${header} is not set`);
      }
      if (typeof cfg.bearer_token_env_var === 'string') {
        const token = this.env[cfg.bearer_token_env_var];
        if (token) headers.Authorization = `Bearer ${token}`;
        else warnings.push(`Codex MCP server ${name}: environment variable ${cfg.bearer_token_env_var} is not set`);
      }
      if (Object.keys(headers).length) raw.headers = headers;
      result.push({ name, raw, source: 'codex' });
    }
    return result;
  }

  /** MCP servers of installed Claude plugins enabled in `~/.claude/settings.json`, named the way Claude Code names them. */
  private async pluginEntries(warnings: string[]): Promise<Candidate[]> {
    const settings = await this.readJson(join(this.home, '.claude', 'settings.json'), warnings);
    const enabled = isRecord(settings?.enabledPlugins) ? settings.enabledPlugins : {};
    const installed = await this.readJson(join(this.home, '.claude', 'plugins', 'installed_plugins.json'), warnings);
    const result: Candidate[] = [];
    for (const [key, installs] of Object.entries(isRecord(installed?.plugins) ? installed.plugins : {})) {
      if (enabled[key] !== true || !Array.isArray(installs)) continue;
      const install = installs.find(item => isRecord(item) && typeof item.installPath === 'string') as { installPath: string } | undefined;
      if (!install) continue;
      const plugin = key.split('@')[0]!;
      for (const candidate of this.claudeEntries(await this.pluginServers(install.installPath, warnings), 'plugin', warnings)) {
        result.push({ ...candidate, name: `plugin_${plugin}_${candidate.name}`, raw: this.withPluginRoot(candidate.raw, install.installPath), origin: key });
      }
    }
    return result;
  }

  private async pluginServers(installPath: string, warnings: string[]): Promise<unknown> {
    const file = await this.readJson(join(installPath, '.mcp.json'), warnings);
    if (file) return file.mcpServers;
    const manifest = await this.readJson(join(installPath, '.claude-plugin', 'plugin.json'), warnings);
    if (isRecord(manifest?.mcpServers)) return manifest.mcpServers;
    if (typeof manifest?.mcpServers !== 'string') return undefined;
    const path = isAbsolute(manifest.mcpServers) ? manifest.mcpServers : join(installPath, manifest.mcpServers);
    return (await this.readJson(path.replaceAll(PLUGIN_ROOT, installPath), warnings))?.mcpServers;
  }

  private withPluginRoot(raw: RawServer, installPath: string): RawServer {
    const swap = (value: string) => value.replaceAll(PLUGIN_ROOT, installPath);
    const swapMap = (map: Record<string, string> | undefined) => (map ? Object.fromEntries(Object.entries(map).map(([key, value]) => [key, swap(value)])) : undefined);
    const result: RawServer = { ...raw };
    if (raw.command) result.command = swap(raw.command);
    if (raw.args) result.args = raw.args.map(swap);
    if (raw.url) result.url = swap(raw.url);
    if (raw.env) result.env = swapMap(raw.env);
    return result;
  }

  private convert(candidate: Candidate, machineId: string, warnings: string[]): { server: ImportServer; secretValues: SecretValue[] } | null {
    const { name, raw } = candidate;
    const id = randomUUID();
    const secretValues: SecretValue[] = [];
    const secretFor = (location: 'env' | 'header' | 'url', key: string, value: string): string => {
      secretValues.push({ serverName: name, entryId: id, location, key, value });
      return randomUUID();
    };
    if (raw.transport === 'stdio' && !raw.command) {
      warnings.push(`Skipped MCP entry ${name}: missing stdio command`);
      return null;
    }
    if (raw.transport !== 'stdio' && !raw.url) {
      warnings.push(`Skipped MCP entry ${name}: missing URL`);
      return null;
    }
    let url = raw.url;
    let urlSecretId: string | undefined;
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.username) {
          const ref = secretFor('url', 'username', decodeURIComponent(parsed.username));
          urlSecretId ??= ref;
          parsed.username = '__AGENT_HUB_SECRET__';
        }
        if (parsed.password) {
          const ref = secretFor('url', 'password', decodeURIComponent(parsed.password));
          urlSecretId ??= ref;
          parsed.password = '__AGENT_HUB_SECRET__';
        }
        for (const [key, value] of parsed.searchParams) {
          if (!SENSITIVE.test(key) || !value) continue;
          const ref = secretFor('url', key, value);
          urlSecretId ??= ref;
          parsed.searchParams.set(key, '__AGENT_HUB_SECRET__');
        }
        url = parsed.toString();
      } catch {
        warnings.push(`Skipped MCP entry ${name}: invalid URL`);
        return null;
      }
    }
    const env = this.mapValues('env', raw.env, secretFor);
    const headers = this.mapValues('header', raw.headers, secretFor);
    const server: ImportServer = {
      id,
      name,
      enabled: true,
      transport: raw.transport,
      mode: raw.transport === 'stdio' ? 'machine-shared' : 'remote',
      ...(raw.command ? { command: raw.command } : {}),
      ...(raw.args ? { args: raw.args } : {}),
      ...(url ? { url } : {}),
      ...(urlSecretId ? { urlSecretId } : {}),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
      ...(raw.oauthClientId ? { oauthClientId: raw.oauthClientId } : {}),
      secrets: [],
      machineScope: { allMachines: false, machineIds: [machineId] },
      projectIds: [],
      revision: 0,
      source: candidate.source,
      ...(candidate.origin ? { origin: candidate.origin } : {}),
      ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
      ...(candidate.warnings ? { warnings: candidate.warnings } : {}),
    };
    return { server, secretValues };
  }

  private mapValues(
    location: 'env' | 'header',
    value: Record<string, string> | undefined,
    makeSecret: (location: 'env' | 'header' | 'url', key: string, value: string) => string,
  ): Record<string, ConfigValue> | undefined {
    if (!value) return undefined;
    const result: Record<string, ConfigValue> = {};
    for (const [key, raw] of Object.entries(value)) {
      // An empty value is not a secret (nano-banana ships GEMINI_API_KEY: ""); the hub rejects empty secret values.
      if (SENSITIVE.test(key) && raw) result[key] = { kind: 'secret', secretId: makeSecret(location, key, raw) };
      else result[key] = { kind: 'literal', value: raw };
    }
    return result;
  }
}
