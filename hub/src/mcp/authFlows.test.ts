// Requirement: Защита потока входа MCP (mcp-management design M7, task 4.2).
import { describe, expect, it } from 'vitest';
import { McpAuthFlows, flowView, type McpAuthFlow } from './authFlows.js';

const base = (o: Partial<McpAuthFlow> = {}) => ({
  state: 'st',
  userId: 'u1',
  sessionId: 's1',
  runnerId: 'hp',
  claudeSessionId: 'c1',
  server: 'notion',
  authUrl: 'https://p/authorize',
  redirect: 'hub' as const,
  ...o,
});

describe('McpAuthFlows', () => {
  it('TTL 10 min: found before, gone (and reported once) after', () => {
    let t = 1_000;
    const expired: string[] = [];
    const f = new McpAuthFlows({ now: () => t, onExpire: x => expired.push(x.state) });
    f.add(base());
    t += 10 * 60_000 - 1;
    expect(f.get('st')?.server).toBe('notion');
    expect(f.holdUntil('s1')).toEqual(new Date(1_000 + 10 * 60_000));
    t += 1;
    expect(f.get('st')).toBeUndefined();
    expect(f.holdUntil('s1')).toBeNull();
    f.sweep();
    expect(expired).toEqual(['st']);
  });

  it('a new attempt of the same session and server replaces the old one; another server is kept', () => {
    const f = new McpAuthFlows({ now: () => 1 });
    f.add(base({ state: 'a' }));
    f.add(base({ state: 'x', server: 'krisp' }));
    const { removed } = f.add(base({ state: 'b' }));
    expect(removed.map(r => r.state)).toEqual(['a']);
    expect(f.get('a')).toBeUndefined();
    expect(f.find('s1', 'notion')?.state).toBe('b');
    expect(
      f
        .ofSession('s1')
        .map(x => x.state)
        .sort(),
    ).toEqual(['b', 'x']);
  });

  it('at most 8 per user: the oldest is evicted; another user is not touched', () => {
    let t = 0;
    const f = new McpAuthFlows({ now: () => t });
    f.add(base({ state: 'other', userId: 'u2' }));
    for (let i = 0; i < 9; i++) {
      t++;
      const { removed } = f.add(base({ state: `s${i}`, server: `srv${i}` }));
      if (i === 8) expect(removed.map(r => r.state)).toEqual(['s0']);
    }
    expect(f.get('s0')).toBeUndefined();
    expect(f.get('s8')).toBeDefined();
    expect(f.get('other')).toBeDefined();
    expect(f.size).toBe(9);
  });

  it('removeSession drops every attempt of the session; view has no state', () => {
    const f = new McpAuthFlows({ now: () => 5 });
    f.add(base({ state: 'a', redirect: 'localhost', callbackPort: 53412 }));
    f.add(base({ state: 'b', sessionId: 's2' }));
    expect(f.removeSession('s1').map(x => x.state)).toEqual(['a']);
    expect(f.size).toBe(1);
    const v = flowView({ ...base({ redirect: 'localhost', callbackPort: 1 }), createdAt: 0, expiresAt: 0 });
    expect(v).toEqual({ server: 'notion', authUrl: 'https://p/authorize', redirect: 'localhost', callbackPort: 1, expiresAt: new Date(0).toISOString() });
    expect(JSON.stringify(v)).not.toContain('"st"');
  });
});
