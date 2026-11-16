// Requirement: Снимок контекстного окна (session-context-usage design D1, task 2.1). The fixture is a real
// getContextUsage({detail: 'summary'}) answer of a vault session (SDK 0.3.310), lists cut to a few rows, gridRows dropped.
import { readFileSync } from 'node:fs';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { sessionContextPayload } from '@agent-hub/shared';
import { describe, expect, it } from 'vitest';
import { toContextPayload } from './contextUsage.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/context-usage-summary.json', import.meta.url), 'utf8')) as SDKControlGetContextUsageResponse;
const SID = '11111111-1111-4111-8111-111111111111';

describe('toContextPayload', () => {
  it('a real answer → a valid payload: totals, categories with kinds, ids from the CLI', () => {
    const p = toContextPayload(SID, fixture, 1000);
    expect(sessionContextPayload.parse(p)).toEqual(p);
    expect(p).toMatchObject({ sessionId: SID, observedAt: 1000, model: 'claude-haiku-5-5', usedTokens: 67331, windowTokens: 200000, percent: 34 });
    expect(p.categories?.map(c => c.id)).toEqual(fixture.categories.map(c => c.id));
    expect(p.categories?.find(c => c.id === 'free_space')?.kind).toBe('free');
    expect(p.categories?.find(c => c.id === 'autocompact_buffer')?.kind).toBe('buffer');
    expect(p.categories?.find(c => c.id === 'mcp_tools_deferred')?.kind).toBe('deferred');
  });

  it('MCP tools are summed by server, loaded tools counted, servers sorted by tokens desc', () => {
    const tools = fixture.mcpTools.map((t, i) => ({ ...t, isLoaded: i === 0 }));
    const p = toContextPayload(SID, { ...fixture, mcpTools: tools }, 1);
    const data = p.mcpServers?.find(s => s.name === 'claude_ai_Claude_Data');
    const expected = tools.filter(t => t.serverName === 'claude_ai_Claude_Data').reduce((n, t) => n + t.tokens, 0);
    expect(data).toEqual({ name: 'claude_ai_Claude_Data', tools: 4, loadedTools: 1, tokens: expected });
    expect(p.mcpServers).toHaveLength(3);
    const sizes = p.mcpServers?.map(s => s.tokens) ?? [];
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('memory files, skills and agents keep no paths of skills/agents and are sorted by tokens', () => {
    const p = toContextPayload(SID, fixture, 1);
    expect(p.memoryFiles?.[0]).toHaveProperty('path');
    expect(p.skills?.[0]).not.toHaveProperty('path');
    expect(p.agents?.[0]).not.toHaveProperty('path');
    const sizes = p.memoryFiles?.map(f => f.tokens) ?? [];
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('lists are cut to the bounds; a category without id takes its name; long strings are cut', () => {
    const skills = Array.from({ length: 400 }, (_, i) => ({ name: `s${i}`, source: 'userSettings', tokens: i }));
    const categories = [{ name: 'x'.repeat(150), tokens: 5, color: 'c', kind: 'used' as const }];
    const p = toContextPayload(SID, { ...fixture, categories, skills: { totalSkills: 400, includedSkills: 400, tokens: 1, skillFrontmatter: skills } }, 1);
    expect(p.skills).toHaveLength(300);
    expect(p.skills?.[0]).toMatchObject({ name: 's399', tokens: 399 });
    expect(p.categories?.[0]?.id).toHaveLength(64);
    expect(p.categories?.[0]?.name).toHaveLength(100);
    expect(sessionContextPayload.safeParse(p).success).toBe(true);
  });
});
