// Test agents created without a stateDir run on AGENT_STATE_DIR (agent/vitest.config.ts): the machine's ~/.agent-hub holds
// the live codex-homes (auth.json) and mcp-registry.json of the running agent, which a test hub would otherwise wipe.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('test state dir', () => {
  it('is a temp folder, not the machine one', () => {
    expect(process.env.AGENT_STATE_DIR).toBeTruthy();
    expect(process.env.AGENT_STATE_DIR).not.toBe(join(homedir(), '.agent-hub'));
  });
});
