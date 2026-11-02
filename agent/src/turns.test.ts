// Requirement: Занятость агента (change update-waits-background-tasks, specs/agent-busy): the tracker on its own, and
// wired by createAgent (manager → tracker → caffeinate) against a scripted SDK.
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from './agent.js';
import { createLogger } from './log.js';
import { Caffeinator } from './macos.js';
import { AsyncQueue } from './sessions/asyncQueue.js';
import type { QueryFn } from './sessions/manager.js';
import { BACKGROUND_RELEASE_HOLD_MS, BACKGROUND_STALE_MS, TurnTracker, type BackgroundTask } from './turns.js';

const MIN = 60_000;
const agentTask = (id = 't1'): BackgroundTask => ({ taskId: id, taskType: 'local_agent', ambient: false });
const waiting = (t: TurnTracker, sessionId = 's1') => t.observe('session.state', { sessionId, state: 'waiting', processAlive: true });

afterEach(() => {
  vi.useRealTimers();
});

describe('TurnTracker (Requirement: Занятость агента)', () => {
  const setup = () => {
    let now = 1_000_000;
    const t = new TurnTracker({ now: () => now });
    const changes: boolean[] = [];
    t.onChange(b => changes.push(b));
    return { t, changes, at: () => now, advance: (ms: number) => (now += ms) };
  };

  it('«Ход окончен, фоновый сабагент работает» → busy', () => {
    const { t, changes, at } = setup();
    waiting(t);
    expect(t.busy).toBe(false);
    t.setBackground('s1', [agentTask()], at());
    expect(t.busy).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('«Фоновая команда завершилась»: an empty set replaces the previous one → not busy after the 30-s hold, without a new message', () => {
    vi.useFakeTimers(); // Date.now is faked too: the tracker's clock and its timer move together
    const t = new TurnTracker();
    const changes: boolean[] = [];
    t.onChange(b => changes.push(b));
    waiting(t);
    t.setBackground('s1', [{ taskId: 'b1', taskType: 'local_bash', ambient: false }, agentTask('t2')], Date.now());
    t.setBackground('s1', [agentTask('t2')], Date.now());
    expect(t.busy).toBe(true);
    t.setBackground('s1', [], Date.now());
    expect(t.busy).toBe(true); // «Удержание после конца фоновых задач»
    vi.advanceTimersByTime(BACKGROUND_RELEASE_HOLD_MS - 1);
    // another empty set during the hold does not extend it
    t.setBackground('s1', [], Date.now());
    expect(t.busy).toBe(true);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]);
    expect(t.busy).toBe(false);
    t.dispose();
  });

  it('«Удержание после конца фоновых задач»: the follow-up turn starts within the hold → busy without a gap', () => {
    vi.useFakeTimers();
    const t = new TurnTracker();
    const changes: boolean[] = [];
    t.onChange(b => changes.push(b));
    waiting(t);
    t.setBackground('s1', [agentTask()], Date.now());
    t.setBackground('s1', [], Date.now());
    vi.advanceTimersByTime(2_000);
    t.observe('session.state', { sessionId: 's1', state: 'working', processAlive: true });
    vi.advanceTimersByTime(BACKGROUND_RELEASE_HOLD_MS);
    expect(t.busy).toBe(true);
    waiting(t);
    expect(t.busy).toBe(false);
    expect(changes).toEqual([true, false]);
    t.dispose();
  });

  it('no hold: session.exited and clear() release at once; ambient-only or teammate-only sets do not start one', () => {
    vi.useFakeTimers();
    const t = new TurnTracker();
    waiting(t);
    t.setBackground('s1', [agentTask()], Date.now());
    t.observe('session.exited', { sessionId: 's1', code: 0, reason: 'stopped' });
    expect(t.busy).toBe(false);
    t.setBackground('s2', [agentTask()], Date.now());
    t.clear('s2');
    expect(t.busy).toBe(false);
    t.setBackground(
      's3',
      [
        { taskId: 'a', taskType: 'local_agent', ambient: true },
        { taskId: 'm', taskType: 'in_process_teammate', ambient: false },
      ],
      Date.now(),
    );
    t.setBackground('s3', [], Date.now());
    expect(t.busy).toBe(false);
    t.dispose();
  });

  it('a stale set that then ends: the message itself (touch, then setBackground — the manager order) revives the tasks, so the hold applies', () => {
    vi.useFakeTimers();
    const t = new TurnTracker();
    const changes: boolean[] = [];
    t.onChange(b => changes.push(b));
    waiting(t);
    t.setBackground('s1', [agentTask()], Date.now());
    vi.advanceTimersByTime(BACKGROUND_STALE_MS + 1);
    expect(t.busy).toBe(false); // «Зависшая задача»
    // background_tasks_changed [] after the silence: onSdkActivity → touch first, then onBackgroundTasks
    t.touch('s1', Date.now());
    expect(t.busy).toBe(true); // «Пришедшее после этого сообщение снова делает задачи сессии активными»
    t.setBackground('s1', [], Date.now());
    expect(t.busy).toBe(true); // the active tasks just ended → 30-s hold
    vi.advanceTimersByTime(BACKGROUND_RELEASE_HOLD_MS);
    expect(t.busy).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    t.dispose();
  });

  it('a new active set during the hold keeps the session busy past the hold', () => {
    vi.useFakeTimers();
    const t = new TurnTracker();
    waiting(t);
    t.setBackground('s1', [agentTask()], Date.now());
    t.setBackground('s1', [], Date.now());
    vi.advanceTimersByTime(10_000);
    t.setBackground('s1', [agentTask('t2')], Date.now());
    vi.advanceTimersByTime(BACKGROUND_RELEASE_HOLD_MS);
    expect(t.busy).toBe(true);
    t.dispose();
  });

  it('«Процесс сессии вышел с задачей в наборе»: session.exited clears the set', () => {
    const { t, changes, at } = setup();
    waiting(t);
    t.setBackground('s1', [agentTask()], at());
    t.observe('session.exited', { sessionId: 's1', code: 0, reason: 'stopped' });
    expect(t.busy).toBe(false);
    expect(changes).toEqual([true, false]);
    // a message of the new process that is not a set does not bring the old tasks back
    t.touch('s1', at());
    waiting(t);
    expect(t.busy).toBe(false);
  });

  it('clear() drops the set', () => {
    const { t, at } = setup();
    t.setBackground('s1', [agentTask()], at());
    t.clear('s1');
    expect(t.busy).toBe(false);
  });

  it('«Ambient-задача» and «Тиммейт» do not keep the agent busy; a task without task_type does', () => {
    const { t, at } = setup();
    waiting(t);
    t.setBackground('s1', [{ taskId: 'a', taskType: 'local_agent', ambient: true }], at());
    expect(t.busy).toBe(false);
    t.setBackground('s1', [{ taskId: 'm', taskType: 'in_process_teammate', ambient: false }], at());
    expect(t.busy).toBe(false);
    t.setBackground('s1', [{ taskId: 'x', taskType: null, ambient: false }], at());
    expect(t.busy).toBe(true);
  });

  it('a running turn with an empty set is busy (as before); without any set — turns only', () => {
    const { t, at } = setup();
    t.observe('session.state', { sessionId: 's1', state: 'working', processAlive: true });
    t.setBackground('s1', [], at());
    expect(t.busy).toBe(true);
    t.observe('session.state', { sessionId: 's2', state: 'permission', processAlive: true });
    waiting(t, 's1');
    expect(t.busy).toBe(true);
    waiting(t, 's2');
    expect(t.busy).toBe(false);
    t.touch('s3', at());
    expect(t.busy).toBe(false);
  });

  it('one busy session keeps the agent busy', () => {
    const { t, at } = setup();
    waiting(t, 's1');
    waiting(t, 's2');
    t.setBackground('s1', [agentTask()], at());
    t.setBackground('s2', [], at());
    expect(t.busy).toBe(true);
  });

  it('«Зависшая задача»: 120 min without a message → onChange(false) without a call; a later message → busy again', () => {
    vi.useFakeTimers(); // Date.now is faked too: the tracker's clock and its timer move together
    const t = new TurnTracker();
    const changes: boolean[] = [];
    t.onChange(b => changes.push(b));
    waiting(t);
    t.setBackground('s1', [agentTask()], Date.now());
    vi.advanceTimersByTime(60 * MIN);
    t.touch('s1', Date.now()); // e.g. task_progress of the subagent
    vi.advanceTimersByTime(120 * MIN - 1);
    expect(t.busy).toBe(true); // 180 min since the set, but the last message was 120 min − 1 ms ago
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(10);
    expect(changes).toEqual([true, false]);
    expect(t.busy).toBe(false);
    t.touch('s1', Date.now());
    expect(t.busy).toBe(true);
    expect(changes).toEqual([true, false, true]);
    t.dispose();
  });

  it('the guard does not touch turns: a turn in progress stays busy after 120 min', () => {
    const { t, advance } = setup();
    t.observe('session.state', { sessionId: 's1', state: 'working', processAlive: true });
    advance(BACKGROUND_STALE_MS * 2);
    expect(t.busy).toBe(true);
  });

  it('dispose() removes the guard timer', () => {
    vi.useFakeTimers();
    const { t, at } = setup();
    t.setBackground('s1', [agentTask()], at());
    expect(vi.getTimerCount()).toBe(1);
    t.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A scripted SDK process (as in sessions/manager.test.ts). */
class FakeQuery {
  readonly out = new AsyncQueue<SDKMessage>();
  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
  ) {
    void (async () => {
      for await (const _ of prompt) void _;
      this.out.close();
    })();
  }
  emit(m: Record<string, unknown>): void {
    this.out.push(m as unknown as SDKMessage);
  }
  asQuery(): Query {
    const it = this.out[Symbol.asyncIterator]();
    const q = {
      next: () => it.next(),
      return: () => Promise.resolve({ value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return q;
      },
      initializationResult: () => Promise.resolve({}),
      supportedModels: () => Promise.resolve([]),
      interrupt: async () => undefined,
      close: () => this.out.close(),
    };
    return q as unknown as Query;
  }
}

class FakeProc extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', null);
    return true;
  }
}

const cmd = <T extends HubMessage['type']>(type: T, payload: PayloadOf<HubMessage, T>): HubMessage => ({ v: 1, ts: Date.now(), id: randomUUID(), type, payload }) as HubMessage;
const CWD = process.platform === 'win32' ? 'C:' + String.fromCharCode(92) + 'w' : '/w';

describe('createAgent: background tasks → turns.busy → caffeinate (Requirement: caffeinate по занятости агента)', () => {
  const setup = () => {
    const queries: FakeQuery[] = [];
    const queryFn: QueryFn = ({ prompt, options }) => {
      const f = new FakeQuery(options, prompt);
      queries.push(f);
      return f.asQuery();
    };
    const spawned: FakeProc[] = [];
    const caffeinator = new Caffeinator({
      platform: 'darwin',
      pid: 1,
      spawn: () => {
        const p = new FakeProc();
        spawned.push(p);
        return p as unknown as ChildProcess;
      },
    });
    // never started: the hub is not contacted, outgoing messages are dropped (the tracker still sees them)
    const agent = createAgent({
      hubUrl: 'ws://127.0.0.1:9/ws/agent',
      token: 'x'.repeat(24),
      vaultRoot: null,
      claudeProjectsDir: CWD,
      log: createLogger({ level: 'error', write: () => undefined }),
      queryFn,
      caffeinator,
      stopGraceMs: 50,
      watch: false,
    });
    return { agent, queries, spawned, caffeinator };
  };
  const flush = () => vi.advanceTimersByTimeAsync(5);

  it('«Mac с фоновым сабагентом после конца хода», empty set → released; «Зависшая задача не держит Mac»', async () => {
    vi.useFakeTimers();
    const { agent, queries, spawned, caffeinator } = setup();
    const sessionId = randomUUID();
    await agent.sessions.handle(cmd('session.start', { sessionId, cwd: CWD, permissionMode: 'default', model: 'haiku', prompt: 'hi', promptUuid: randomUUID() }));
    const q = queries[0]!;
    expect(caffeinator.active).toBe(true); // the turn runs
    q.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'tests' }] });
    q.emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 });
    await flush();
    expect(agent.sessions.liveSessions()).toEqual([{ sessionId, state: 'waiting' }]);
    expect(agent.turns.busy).toBe(true);
    expect(caffeinator.active).toBe(true);
    expect(spawned).toHaveLength(1);

    q.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await flush();
    expect(caffeinator.active).toBe(true); // the 30-s hold
    await vi.advanceTimersByTimeAsync(BACKGROUND_RELEASE_HOLD_MS);
    expect(agent.turns.busy).toBe(false);
    expect(caffeinator.active).toBe(false);

    // a hung task: messages of a subagent keep it, 120 min of silence release it
    q.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't2', task_type: 'local_agent', description: 'x' }] });
    await flush();
    expect(caffeinator.active).toBe(true);
    await vi.advanceTimersByTimeAsync(100 * MIN);
    q.emit({ type: 'stream_event', parent_tool_use_id: 'toolu_sub', event: { type: 'message_start', message: { id: 'm' } } });
    await vi.advanceTimersByTimeAsync(100 * MIN);
    expect(caffeinator.active).toBe(true);
    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(agent.turns.busy).toBe(false);
    expect(caffeinator.active).toBe(false);
    await agent.stop(50);
  });

  it('the process exits with a task in the set → not busy (session.exited clears it)', async () => {
    vi.useFakeTimers();
    const { agent, queries } = setup();
    const sessionId = randomUUID();
    await agent.sessions.handle(cmd('session.start', { sessionId, cwd: CWD, permissionMode: 'default', model: 'haiku', prompt: 'hi', promptUuid: randomUUID() }));
    const q = queries[0]!;
    q.emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 });
    q.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_bash', description: 'sleep' }] });
    await flush();
    expect(agent.turns.busy).toBe(true);
    q.out.close(); // the CLI process ended
    await flush();
    expect(agent.sessions.liveSessions()).toEqual([]);
    expect(agent.turns.busy).toBe(false);
    await agent.stop(50);
  });
});
