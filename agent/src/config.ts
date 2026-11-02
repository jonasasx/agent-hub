import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** wss:// everywhere; ws:// only to a hub on this machine (tests, local trial), never over the network. */
export function isAllowedHubUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'wss:') return true;
  return u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

const schema = z.object({
  HUB_URL: z.url().refine(isAllowedHubUrl, 'HUB_URL must be wss:// (plain ws:// only for a loopback hub)'),
  AGENT_TOKEN: z.string().min(20, 'AGENT_TOKEN is missing or too short'),
  CLAUDE_PROJECTS_DIR: z.string().optional(),
  VAULT_ROOT: z.string().optional(),
  AGENT_STATE_DIR: z.string().optional(),
  REPL_MAX_BYTES_PER_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  /** History transcripts sent at once (initial upload): 8; 2–4 on a machine with hundreds of imported sessions. */
  REPL_HISTORY_INFLIGHT: z.coerce.number().int().min(1).max(64).default(8),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export interface AgentConfig {
  hubUrl: string;
  token: string;
  claudeProjectsDir: string;
  vaultRoot: string | null;
  stateDir: string;
  replMaxBytesPerSec: number;
  replHistoryInflight: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error(`Invalid agent configuration:\n${z.prettifyError(r.error)}`);
  const c = r.data;
  const home = homedir();
  return {
    hubUrl: c.HUB_URL,
    token: c.AGENT_TOKEN,
    claudeProjectsDir: c.CLAUDE_PROJECTS_DIR ?? join(home, '.claude', 'projects'),
    vaultRoot: c.VAULT_ROOT ?? null,
    stateDir: c.AGENT_STATE_DIR ?? join(home, '.agent-hub'),
    replMaxBytesPerSec: c.REPL_MAX_BYTES_PER_SEC,
    replHistoryInflight: c.REPL_HISTORY_INFLIGHT,
    logLevel: c.LOG_LEVEL,
  };
}
