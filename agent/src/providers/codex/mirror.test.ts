// The shell wrapper of a Codex command is dropped from the mirror transcript: the reader sees the script only.
// Subagents of Codex (subAgentActivity) become the lines of a background Agent that the hub's registry reads.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MirrorWriter, readLines, toolOf, unwrapShell } from './mirror.js';

const PS = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe('unwrapShell', () => {
  it('PowerShell -Command with a double-quoted script', () => {
    expect(unwrapShell(`"${PS}" -Command "git status --short; Get-Content 'a b.md'"`)).toBe("git status --short; Get-Content 'a b.md'");
  });
  it('escaped quotes inside the script are restored', () => {
    expect(unwrapShell(`"${PS}" -Command "rg -n \\"export f\\" web"`)).toBe('rg -n "export f" web');
  });
  it('single-quoted script, NoProfile and unquoted exe', () => {
    expect(unwrapShell(`${PS} -NoProfile -Command 'npm run typecheck'`)).toBe('npm run typecheck');
    expect(unwrapShell(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command "npm test"`)).toBe('npm test');
  });
  it('bash -lc and cmd /c', () => {
    expect(unwrapShell(`/bin/bash -lc 'ls -la'`)).toBe('ls -la');
    expect(unwrapShell('cmd.exe /c dir')).toBe('dir');
  });
  it('a command that only contains a shell later in the line keeps its start visible', () => {
    for (const c of ['rm -rf x; /usr/bin/pwsh -Command "ls"', 'echo a && C:\\x\\pwsh.exe -Command "b"', "rm -rf x | /bin/bash -lc 'ls'", 'rm x; cmd.exe /c dir']) expect(unwrapShell(c)).toBe(c);
  });
  it('anything else is returned as it is', () => {
    for (const c of ['git status', 'npm ci --engine-strict=false', `"${PS}" -File run.ps1`, '', `"${PS}" -Command "unterminated`]) expect(unwrapShell(c)).toBe(c);
  });
});

describe('toolOf commandExecution', () => {
  it('Bash input holds the script, not the shell wrapper', () => {
    const t = toolOf({ type: 'commandExecution', id: 'x', command: `"${PS}" -Command "npm test"`, cwd: 'C:\\w', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' });
    expect(t?.input).toEqual({ command: 'npm test', cwd: 'C:\\w' });
  });
});

// items of the real session 6a051dc9 (HP, 2026-11-18): the subagent camera_sa — started, completed, asked again, completed
const ROOT = '01a1ee5c-9861-7e51-b2ae-7c8de0c4aaa1';
const SA = '01a1eeb9-d184-7e20-987f-b5b324ea814f';
const activity = (id: string, kind: string, model: string | null = null) => ({ type: 'subAgentActivity', id, kind, agentThreadId: SA, agentPath: '/root/camera_sa', model, reasoningEffort: null });

describe('MirrorWriter subAgentActivity', () => {
  it('started → background Agent call with the thread as agentId; interacted → SendMessage resumes it; completed → <task-notification>', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirror-'));
    try {
      const w = new MirrorWriter(dir, 's1', 'C:\\w');
      w.item(activity('call_5c3543f121814aa08a325a4c06adf22d', 'started', 'gpt-6.2-sol'), 'gpt-6.2-sol');
      w.item(activity('subagent-completed-01a1eeb9-d4a9-77f1-89', 'completed'), 'gpt-6.2-sol');
      w.item(activity('call_c8d3b6e64e804fb1be170dcfb5925217', 'interacted'), 'gpt-6.2-sol');
      w.item(activity('subagent-stop', 'interrupted'), 'gpt-6.2-sol');
      await w.flush();
      const lines = await readLines(dir, 's1');
      expect(lines).toHaveLength(6);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the lines are read as written
      const [call, launched, done, send, sent, stop] = lines as Array<Record<string, any>>;
      expect(call!.message.content[0]).toMatchObject({
        type: 'tool_use',
        id: 'call_5c3543f121814aa08a325a4c06adf22d',
        name: 'Agent',
        input: { description: 'camera_sa', name: 'camera_sa', run_in_background: true },
      });
      expect(launched!.toolUseResult).toMatchObject({ status: 'async_launched', agentId: SA, resolvedModel: 'gpt-6.2-sol' });
      expect(launched!.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_5c3543f121814aa08a325a4c06adf22d' });
      expect(done!.message.content).toContain(`<task-id>${SA}</task-id>`);
      expect(done!.message.content).toContain('<status>completed</status>');
      expect(send!.message.content[0]).toMatchObject({ name: 'SendMessage', input: { to: 'camera_sa' } });
      expect(sent!.toolUseResult).toEqual({ resumedAgentId: SA });
      expect(stop!.message.content).toContain('<status>killed</status>');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('collabAgentToolCall is a call in the feed under the name the model used', () => {
    const t = toolOf({
      type: 'collabAgentToolCall',
      id: 'call_x',
      tool: 'wait',
      status: 'completed',
      senderThreadId: ROOT,
      receiverThreadIds: [SA],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: { [SA]: { status: 'completed', message: 'done' } },
    });
    expect(t).toEqual({ name: 'wait_agent', input: { targets: [SA] }, result: `${SA}: completed — done`, isError: false });
  });
});
