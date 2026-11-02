// MCP snapshots in the hub's database (mcp-management design M6) and the views of the panel and the machine block (M8).
// Requirements: Статус MCP сессии; Отметка проблем MCP; MCP спящей сессии; MCP машины; Совместимость управления MCP.
import {
  MCP_AUTH_CONTROLS_PROTOCOL,
  MCP_PROTOCOL,
  isAuthErrorText,
  protocolAtLeast,
  type McpAuthFlowView,
  type McpMachineView,
  type McpPendingAction,
  type McpServerSnapshot,
  type McpServerView,
  type McpSessionView,
  type McpSnapshot,
} from '@agent-hub/shared';
import type { Db } from '../db/db.js';

/** `failed` + `needs-auth`: the mark in the head and the sidebar; `disabled` is not a problem. */
export function countProblems(servers: readonly McpServerSnapshot[]): number {
  return servers.filter(s => s.status === 'failed' || s.status === 'needs-auth').length;
}

/** Servers of the user configuration (source/scope `user`): the machine block. */
export function userServers(servers: readonly McpServerSnapshot[]): McpServerSnapshot[] {
  return servers.filter(s => s.scope === 'user');
}

/** jsonb of the column → rows (pg returns the parsed array). */
function rowsOf(v: unknown): McpServerSnapshot[] {
  return Array.isArray(v) ? (v as McpServerSnapshot[]) : [];
}

/**
 * Writes the snapshot of a session when it is newer than the stored one. Returns null when older (nothing written),
 * else whether the problem count changed (the sidebar row needs a session.upsert).
 */
export async function storeSessionSnapshot(db: Db, sessionId: string, snap: McpSnapshot): Promise<{ problemsChanged: boolean } | null> {
  const at = new Date(snap.observedAt);
  const prev = await db.selectFrom('sessions').select(['mcp_problems']).where('id', '=', sessionId).executeTakeFirst();
  if (!prev) return null;
  const problems = countProblems(snap.servers);
  const r = await db
    .updateTable('sessions')
    .set({ mcp_servers: JSON.stringify(snap.servers), mcp_observed_at: at, mcp_problems: problems, mcp_project_root: snap.projectRoot ?? null })
    .where('id', '=', sessionId)
    .where(eb => eb.or([eb('mcp_observed_at', 'is', null), eb('mcp_observed_at', '<', at)]))
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0) return null;
  return { problemsChanged: prev.mcp_problems !== problems };
}

/**
 * The user servers of a machine from a session snapshot or a probe, when newer than the stored ones (newer wins).
 * `probe` also records the time of the check. Returns whether the row changed.
 */
export async function storeMachineServers(db: Db, runnerId: string, snap: McpSnapshot, source: 'session' | 'probe'): Promise<boolean> {
  const at = new Date(snap.observedAt);
  const r = await db
    .updateTable('runners')
    .set({ mcp_servers: JSON.stringify(userServers(snap.servers)), mcp_observed_at: at, ...(source === 'probe' ? { mcp_probe_at: at } : {}) })
    .where('id', '=', runnerId)
    .where(eb => eb.or([eb('mcp_observed_at', 'is', null), eb('mcp_observed_at', '<', at)]))
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) > 0) return true;
  if (source === 'probe') {
    // an older probe (clock): the time of the check still counts for «проверено в»
    await db.updateTable('runners').set({ mcp_probe_at: at }).where('id', '=', runnerId).execute();
  }
  return false;
}

/** The hub's state of one server: the action in flight and the last action's error. */
export interface ServerState {
  pending?: McpPendingAction;
  lastError?: string;
}

/** `persistence` of «Выключить» (M8): dynamic and sdk servers live in the process only; others are kept per project. */
export function persistenceOf(s: Pick<McpServerSnapshot, 'scope' | 'transport'>): 'project' | 'process' {
  return s.scope === 'dynamic' || s.scope === 'sdk' || s.transport === 'sdk' ? 'process' : 'project';
}

/** «Войти» is possible for http/sse (not claudeai-proxy, not stdio). */
export function canAuthOf(s: Pick<McpServerSnapshot, 'transport'>): boolean {
  return s.transport === 'http' || s.transport === 'sse';
}

export function toServerView(s: McpServerSnapshot, st?: ServerState): McpServerView {
  return {
    ...s,
    ...(st?.pending ? { pendingAction: st.pending } : {}),
    ...(st?.lastError ? { lastError: st.lastError } : {}),
    persistence: persistenceOf(s),
    canAuth: canAuthOf(s),
    // mcp-auth-controls A1/A2: the agent's yes/no (absent from an agent of 1.7 → false); the auth-error heuristic
    oauth: canAuthOf(s) && s.oauth === true,
    authError: s.status === 'failed' && isAuthErrorText(s.error),
  };
}

export interface SessionMcpRow {
  is_hub_managed: boolean;
  process_alive: boolean;
  mcp_servers: unknown;
  mcp_observed_at: Date | null;
  /** 028: snapshot `projectRoot` (agent 0.2.5+); absent/null from an older agent. */
  mcp_project_root?: string | null;
}

/** The panel of a session (M8). `protocol` — of its machine's agent; `online` — the agent is connected. */
export function toSessionMcpView(
  row: SessionMcpRow,
  o: { protocol: string | null; online: boolean; states?: ReadonlyMap<string, ServerState>; flows?: McpAuthFlowView[]; waking?: boolean },
): McpSessionView {
  const servers = rowsOf(row.mcp_servers);
  const outdated = !protocolAtLeast(o.protocol, MCP_PROTOCOL);
  const reason = outdated ? 'agent_outdated' : !row.is_hub_managed ? 'not_hub_managed' : !row.mcp_observed_at ? 'no_snapshot' : undefined;
  return {
    available: !outdated && row.is_hub_managed,
    ...(reason ? { reason } : {}),
    live: row.process_alive && o.online,
    observedAt: row.mcp_observed_at ? row.mcp_observed_at.toISOString() : null,
    ...(row.mcp_project_root ? { projectRoot: row.mcp_project_root } : {}),
    servers: servers.map(s => toServerView(s, o.states?.get(s.name))),
    authFlows: o.flows ?? [],
    waking: o.waking ?? false,
    authControls: protocolAtLeast(o.protocol, MCP_AUTH_CONTROLS_PROTOCOL),
  };
}

export interface RunnerMcpRow {
  protocol_version: string | null;
  mcp_servers: unknown;
  mcp_observed_at: Date | null;
  mcp_probe_at: Date | null;
}

/** The machine block (M8): the user servers, their source (probe when the stored snapshot is the probe's), «Проверить». */
export function toMachineMcpView(row: RunnerMcpRow, o: { online: boolean; probing: boolean; probeAvailableAt: Date | null; probeError: string | null; now: Date }): McpMachineView {
  const outdated = !protocolAtLeast(row.protocol_version, MCP_PROTOCOL);
  const has = row.mcp_observed_at !== null;
  const reason = outdated ? 'agent_outdated' : !has ? 'no_snapshot' : undefined;
  const source = !has ? null : row.mcp_probe_at && row.mcp_probe_at.getTime() === row.mcp_observed_at!.getTime() ? 'probe' : 'session';
  return {
    available: !outdated,
    ...(reason ? { reason } : {}),
    observedAt: has ? row.mcp_observed_at!.toISOString() : null,
    source,
    servers: rowsOf(row.mcp_servers).map(s => toServerView(s)),
    probeAt: row.mcp_probe_at ? row.mcp_probe_at.toISOString() : null,
    probeAvailableAt: o.probeAvailableAt && o.probeAvailableAt > o.now ? o.probeAvailableAt.toISOString() : null,
    probing: o.probing,
    probeError: o.probeError,
    online: o.online,
    authControls: protocolAtLeast(row.protocol_version, MCP_AUTH_CONTROLS_PROTOCOL),
  };
}
