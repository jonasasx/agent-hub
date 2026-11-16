// The context window of a session for the hub (session-context-usage D1): the answer of getContextUsage({detail:
// 'summary'}) — the data behind `/context`, 80+ KB with every MCP tool — cut to a bounded snapshot: categories, MCP
// tools summed by server, memory files, skills and agents sorted by tokens desc. Paths of agents and skills, the grid
// and terminal colours are dropped.
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ContextCategory, SessionContextPayload } from '@agent-hub/shared';

const CATEGORIES_MAX = 30;
const SERVERS_MAX = 100;
const MEMORY_MAX = 100;
const SKILLS_MAX = 300;
const AGENTS_MAX = 200;

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function top<T extends { tokens: number }>(rows: T[], max: number): T[] {
  return [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, max);
}

function mcpServers(tools: SDKControlGetContextUsageResponse['mcpTools']): NonNullable<SessionContextPayload['mcpServers']> {
  const byServer = new Map<string, { name: string; tools: number; loadedTools: number; tokens: number }>();
  for (const t of tools) {
    const row = byServer.get(t.serverName) ?? { name: cut(t.serverName, 200), tools: 0, loadedTools: 0, tokens: 0 };
    row.tools += 1;
    if (t.isLoaded) {
      row.loadedTools += 1;
    }
    row.tokens += tokens(t.tokens);
    byServer.set(t.serverName, row);
  }
  return top([...byServer.values()], SERVERS_MAX);
}

/** The snapshot of `sessionId` from a getContextUsage answer read at `observedAt`. */
export function toContextPayload(sessionId: string, u: SDKControlGetContextUsageResponse, observedAt: number): SessionContextPayload {
  const windowTokens = tokens(u.rawMaxTokens) || tokens(u.maxTokens) || 1;
  const usedTokens = tokens(u.totalTokens);
  const categories: ContextCategory[] = u.categories.slice(0, CATEGORIES_MAX).map(c => ({
    id: cut(c.id ?? c.name, 64) || 'unknown',
    name: cut(c.name, 100),
    kind: c.kind ?? (c.isDeferred ? 'deferred' : 'used'),
    tokens: tokens(c.tokens),
  }));
  return {
    sessionId,
    observedAt,
    model: u.model ? cut(u.model, 200) : null,
    usedTokens,
    windowTokens,
    percent: Math.round((usedTokens / windowTokens) * 100),
    categories,
    mcpServers: mcpServers(u.mcpTools ?? []),
    memoryFiles: top(
      (u.memoryFiles ?? []).map(f => ({ path: cut(f.path, 1000), type: cut(f.type, 32), tokens: tokens(f.tokens) })),
      MEMORY_MAX,
    ),
    skills: top(
      (u.skills?.skillFrontmatter ?? []).map(s => ({ name: cut(s.name, 200), source: cut(s.source, 64), tokens: tokens(s.tokens) })),
      SKILLS_MAX,
    ),
    agents: top(
      (u.agents ?? []).map(a => ({ agentType: cut(a.agentType, 200), source: cut(a.source, 64), tokens: tokens(a.tokens) })),
      AGENTS_MAX,
    ),
  };
}
