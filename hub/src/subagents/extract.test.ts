// The extractor on lines of the real session cc291a76 (HP, 2026-10-26; texts and paths anonymised; `killed`, the skill
// and the nested call are marked synthetic in the fixtures). Requirement (subagents): Реестр субагентов сессии;
// Статус субагента.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { notifications, promptSha, scanLines, teammateName, type Fact } from './extract.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l, i) => ({ lineNo: i, obj: JSON.parse(l) as Record<string, unknown> }));
const only = <T extends Fact['t']>(facts: Fact[], t: T) => facts.filter((f): f is Extract<Fact, { t: T }> => f.t === t);

describe('scanLines on the main transcript', () => {
  const facts = scanLines({ kind: 'main', agentIdOfFile: null }, fixture('main.jsonl'));

  it('background call → async_launched with the agentId → <task-notification> completed', () => {
    const call = only(facts, 'call').find(f => f.toolUseId === 'toolu_018W6Ey1mbLRDnPiML8TB4Ev')!;
    expect(call).toMatchObject({ description: 'Collect facts for agent hub brief', agentType: 'general-purpose', background: true, kind: 'subagent', parentAgentId: null });
    expect(call.promptSha).toBeInstanceOf(Buffer);
    expect(only(facts, 'result').find(f => f.toolUseId === 'toolu_018W6Ey1mbLRDnPiML8TB4Ev')).toMatchObject({ agentId: 'ae7c275287abe82aa', state: null });
    expect(only(facts, 'notify').find(f => f.agentId === 'ae7c275287abe82aa')).toMatchObject({ toolUseId: 'toolu_018W6Ey1mbLRDnPiML8TB4Ev', state: 'completed' });
  });

  it('foreground completed: agentId only in the text of the result, the type, duration, tokens and tool uses from it', () => {
    expect(only(facts, 'result').find(f => f.toolUseId === 'toolu_01SogddeZ8UPSv1rAbfvRBFq')).toMatchObject({
      agentId: 'ae58397c483dd9a81',
      state: 'completed',
      agentType: 'general-purpose',
      durationMs: 118617,
      totalTokens: 173192,
      toolUses: 9,
    });
  });

  it('failed and killed notifications; a notification of a Bash task is a fact the registry ignores (no row)', () => {
    const notes = only(facts, 'notify');
    expect(notes.find(f => f.agentId === 'a225717d9560b148b')).toMatchObject({ state: 'failed' });
    expect(notes.find(f => f.agentId === 'a0000000000000kil')).toMatchObject({ state: 'stopped' });
    expect(notes.some(f => f.agentId && !/^a[0-9a-f]{16}$|kil$/.test(f.agentId))).toBe(true); // b1mumyyhh — a Bash task
  });

  it('teammate_spawned: teammate kind, its name, team and model; forked: a skill', () => {
    expect(only(facts, 'call').find(f => f.toolUseId === 'toolu_01GMUqs9n1P8YitSCd3qzQ7Q')).toMatchObject({ kind: 'subagent', name: 'devops-x1' }); // no team_name in the call: the result decides
    expect(only(facts, 'result').find(f => f.toolUseId === 'toolu_01GMUqs9n1P8YitSCd3qzQ7Q')).toMatchObject({
      agentId: 'adevops-x1-8db2d007e785553a',
      kind: 'teammate',
      name: 'devops-x1',
      teamName: 'session-6fa81d2b',
    });
    expect(only(facts, 'result').find(f => f.toolUseId === 'toolu_synthetic_skill')).toMatchObject({ agentId: 'a00000000000skill', kind: 'skill', agentType: 'code-review' });
  });

  it('SendMessage with resumedAgentId resumes the subagent', () => {
    expect(only(facts, 'resume')).toEqual([expect.objectContaining({ agentId: 'a47eb06adb4df8cad' })]);
  });

  it('a queue-operation with a notification is read like a user line', () => {
    expect(only(facts, 'notify').length).toBeGreaterThanOrEqual(5);
  });
});

describe('scanLines on transcripts of subagents', () => {
  it("first line: the task (its sha equals the sha of the call's prompt), activity, SubagentStop → completed", () => {
    const facts = scanLines({ kind: 'subagent', agentIdOfFile: 'ae7c275287abe82aa' }, fixture('agent-ae7c275287abe82aa.jsonl'));
    const file = only(facts, 'file')[0]!;
    const call = only(scanLines({ kind: 'main', agentIdOfFile: null }, fixture('main.jsonl')), 'call').find(f => f.toolUseId === 'toolu_018W6Ey1mbLRDnPiML8TB4Ev')!;
    expect(file.promptSha!.equals(call.promptSha!)).toBe(true);
    expect(file.teammate).toBeNull();
    expect(only(facts, 'hook')).toEqual([expect.objectContaining({ state: 'completed' })]);
    expect(only(facts, 'activity')).toHaveLength(1);
  });

  it('a teammate: <teammate-message summary> is the description, the name from the agentId; the last hook TeammateIdle → idle', () => {
    const facts = scanLines({ kind: 'subagent', agentIdOfFile: 'adevops-x1-8db2d007e785553a' }, fixture('agent-adevops-x1-8db2d007e785553a.jsonl'));
    expect(only(facts, 'file')[0]).toMatchObject({ description: 'Install agent on X1 and watch takeover', teammate: { name: 'devops-x1' } });
    expect(only(facts, 'hook').at(-1)).toMatchObject({ state: 'idle' });
    // a peer message delivered mid-turn is activity, not a resume of its own
    expect(only(facts, 'activity').some(f => !f.resumes)).toBe(true);
  });

  it("a call inside a subagent's transcript is nested: its parent is that subagent", () => {
    const facts = scanLines({ kind: 'subagent', agentIdOfFile: 'aef6947385afad951' }, fixture('agent-aef6947385afad951.jsonl'));
    expect(only(facts, 'call')).toEqual([expect.objectContaining({ toolUseId: 'toolu_01VCiwoFVubxZEvGhAiPqBTy', parentAgentId: 'aef6947385afad951', agentType: 'ui-ux-reviewer' })]);
  });
});

describe('background commands', () => {
  it('the tool result of a run_in_background command starts a task; an error result does not', () => {
    const line = (content: unknown, isError = false) => ({
      lineNo: 1,
      obj: { type: 'user', timestamp: '2026-10-26T10:35:50.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: isError, content }] } },
    });
    expect(scanLines({ kind: 'main', agentIdOfFile: null }, [line('Command running in background with ID: biuxx3odl. Output is being written to: x')])).toEqual([
      { t: 'bgstart', toolUseId: 'toolu_1', taskId: 'biuxx3odl', kind: 'bash', timeoutMs: null, persistent: false, ownerAgentId: null, ts: new Date('2026-10-26T10:35:50.000Z') },
    ]);
    expect(scanLines({ kind: 'main', agentIdOfFile: null }, [line('Command running in background with ID: x', true)]).filter(f => f.t === 'bgstart')).toEqual([]);
    expect(scanLines({ kind: 'main', agentIdOfFile: null }, [line('total 0')])).toEqual([]);
  });

  it('a foreground command moved to the background over its timeout starts a task with the metadata of its call', () => {
    const main = { kind: 'main' as const, agentIdOfFile: null };
    const call = {
      lineNo: 1,
      obj: {
        type: 'assistant',
        timestamp: '2026-11-07T05:49:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test', description: 'Run tests', timeout: 600000 } }] },
      },
    };
    const result = (content: string, toolUseResult?: Record<string, unknown>) => ({
      lineNo: 2,
      obj: { type: 'user', timestamp: '2026-11-07T05:59:00.000Z', toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: false, content }] } },
    });
    const moved = 'Command did not complete within its 600s timeout and was moved to the background (ID: beqf5k97b). Output is being written to: x';
    const start = { t: 'bgstart', toolUseId: 'toolu_2', taskId: 'beqf5k97b', kind: 'bash', timeoutMs: null, persistent: false, ownerAgentId: null, ts: new Date('2026-11-07T05:59:00.000Z') };
    expect(scanLines(main, [call, result(moved)])).toEqual([
      {
        t: 'bgcall',
        toolUseId: 'toolu_2',
        kind: 'bash',
        description: 'Run tests',
        command: 'npm test',
        timeoutMs: null,
        persistent: false,
        ownerAgentId: null,
        ts: new Date('2026-11-07T05:49:00.000Z'),
      },
      start,
    ]);
    // the call in an earlier chunk; the text changed but toolUseResult names the task
    expect(scanLines(main, [result('moved', { backgroundTaskId: 'beqf5k97b', timedOutAfterMs: 600000 })])).toEqual([start]);
    expect(scanLines(main, [call, result('total 0')])).toEqual([]);
  });
});

// Change `background-tasks`: lines in the format of the X1 session 4a49f2ec (2026-10-08). Requirement
// (background-tasks): Учёт фоновых задач сессии; Конец фоновой задачи.
describe('monitors', () => {
  const at = '2026-10-08T18:57:00.000Z';
  const main = { kind: 'main' as const, agentIdOfFile: null };
  const L = (obj: Record<string, unknown>) => ({ lineNo: 1, obj: { timestamp: at, ...obj } });
  const ev = `<task-notification>
<task-id>b19s2119t</task-id>
<summary>Monitor event: "CI"</summary>
<event>build-api: success</event>
If this event…
</task-notification>`;

  it('a call of Monitor and of a background Bash gives bgcall; a foreground Bash gives nothing', () => {
    const facts = scanLines(main, [
      L({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tm', name: 'Monitor', input: { description: 'CI #1', command: 'x'.repeat(3000), timeout_ms: 600000 } },
            { type: 'tool_use', id: 'tb', name: 'Bash', input: { description: 'tests', command: 'npm test', run_in_background: true } },
            { type: 'tool_use', id: 'tf', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ]);
    expect(facts).toEqual([
      { t: 'bgcall', toolUseId: 'tm', kind: 'monitor', description: 'CI #1', command: 'x'.repeat(2000), timeoutMs: 600000, persistent: false, ownerAgentId: null, ts: new Date(at) },
      { t: 'bgcall', toolUseId: 'tb', kind: 'bash', description: 'tests', command: 'npm test', timeoutMs: null, persistent: false, ownerAgentId: null, ts: new Date(at) },
    ]);
  });

  it('a background Bash keeps its own timeout in the call; an error result gives bgfail; the copy of a notification in queued_command gives notify', () => {
    const call = L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'sleep 9', timeout: 600000, run_in_background: true } }] } });
    expect(only(scanLines(main, [call]), 'bgcall')[0]).toMatchObject({ toolUseId: 'tb', kind: 'bash', timeoutMs: 600000 });
    const err = L({
      type: 'user',
      toolUseResult: 'InputValidationError: …',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tm', is_error: true, content: '<tool_use_error>InputValidationError: Monitor failed</tool_use_error>' }] },
    });
    expect(only(scanLines(main, [err]), 'bgfail')).toEqual([{ t: 'bgfail', toolUseId: 'tm', ts: new Date(at) }]);
    const done = `<task-notification>
<task-id>bkl112941</task-id>
<tool-use-id>tb</tool-use-id>
<status>completed</status>
<summary>Background command "x" completed (exit code 0)</summary>
</task-notification>`;
    const q = L({ type: 'attachment', attachment: { type: 'queued_command', prompt: done, origin: { kind: 'task-notification' } } });
    expect(only(scanLines({ kind: 'subagent', agentIdOfFile: 'a3d' }, [q]), 'notify')).toEqual([{ t: 'notify', agentId: 'bkl112941', toolUseId: 'tb', state: 'completed', ts: new Date(at) }]);
  });

  it('the result of Monitor starts it by toolUseResult, or by the text when the result was not kept (the timeout from «expires in …»); an error does not', () => {
    const res = (tur: unknown, isError = false) =>
      L({
        type: 'user',
        toolUseResult: tur,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tm', is_error: isError, content: 'Monitor started (task b19s2119t, expires in 30m unless the source ends first).' }] },
      });
    expect(scanLines(main, [res({ taskId: 'b19s2119t', timeoutMs: 1800000, persistent: false })])).toEqual([
      { t: 'bgstart', toolUseId: 'tm', taskId: 'b19s2119t', kind: 'monitor', timeoutMs: 1800000, persistent: false, ownerAgentId: null, ts: new Date(at) },
    ]);
    expect(scanLines(main, [res(undefined)])).toEqual([
      { t: 'bgstart', toolUseId: 'tm', taskId: 'b19s2119t', kind: 'monitor', timeoutMs: 1800000, persistent: false, ownerAgentId: null, ts: new Date(at) },
    ]);
    expect(scanLines(main, [res(undefined, true)]).filter(f => f.t === 'bgstart')).toEqual([]);
  });

  it('events in the queue, in the feed and in queued_command give bgevent; the end of the stream is a notify', () => {
    const end = `<task-notification>
<task-id>b19s2119t</task-id>
<tool-use-id>tm</tool-use-id>
<status>completed</status>
<summary>Monitor "CI" stream ended</summary>
<event>PIPELINE: success</event>
</task-notification>`;
    const facts = scanLines(main, [
      L({ type: 'queue-operation', operation: 'enqueue', content: ev }),
      L({ type: 'user', message: { content: ev } }),
      L({ type: 'attachment', attachment: { type: 'queued_command', prompt: ev } }),
      L({ type: 'queue-operation', operation: 'enqueue', content: end }),
    ]);
    const e = { t: 'bgevent', taskId: 'b19s2119t', text: 'build-api: success', ts: new Date(at) };
    expect(facts).toEqual([e, e, e, { t: 'notify', agentId: 'b19s2119t', toolUseId: 'tm', state: 'completed', ts: new Date(at) }]);
  });

  it('the notice of the timeout ends the monitor (bgexpire), it is not its last event', () => {
    const notice = `<task-notification>\n<task-id>bp5z8wazn</task-id>\n<summary>Monitor event: "QA"</summary>\n<event>[Monitor expired after 3m with 6 events delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>`;
    expect(scanLines(main, [L({ type: 'queue-operation', operation: 'enqueue', content: notice }), L({ type: 'user', message: { content: notice } })])).toEqual([
      { t: 'bgexpire', taskId: 'bp5z8wazn', ts: new Date(at) },
      { t: 'bgexpire', taskId: 'bp5z8wazn', ts: new Date(at) },
    ]);
  });

  it('the result of TaskStop gives bgstop', () => {
    const facts = scanLines(main, [
      L({
        type: 'user',
        toolUseResult: { message: 'Successfully stopped task: bx1', task_id: 'bx1', task_type: 'local_bash', command: 'npm test' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'ts1', content: 'Successfully stopped task: bx1' }] },
      }),
    ]);
    expect(facts).toEqual([{ t: 'bgstop', taskId: 'bx1', ts: new Date(at) }]);
  });
});

describe('helpers', () => {
  it('teammateName, notifications, promptSha', () => {
    expect(teammateName('adevops-x1-8db2d007e785553a')).toBe('devops-x1');
    expect(teammateName('asa-m21-e0ae234737d4106c')).toBe('sa-m21');
    expect(teammateName('ae7c275287abe82aa')).toBeNull();
    expect(notifications('<task-notification>\n<task-id>a1</task-id>\n<status>stopped</status>\n</task-notification>')).toEqual([{ taskId: 'a1', toolUseId: null, state: 'stopped' }]);
    expect(notifications('<task-notification><task-id>a1</task-id><status>running</status></task-notification>')).toEqual([]);
    expect(promptSha(null)).toBeNull();
  });
});
