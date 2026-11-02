/**
 * Subagents of the mock (change `subagents`): session 1 runs a background reviewer (completed), a developer
 * (running) with a nested fix (completed), and a teammate `sa-m4` (waiting for messages). The session's feed has the
 * calls, a SendMessage to the teammate, the teammate's message to the lead, a queued peer message and a task
 * notification; every subagent has its own transcript.
 */
type Json = Record<string, unknown>;

export const SUB_IDS = {
  review: '00000000-0000-4000-a000-000000000001',
  dev: '00000000-0000-4000-a000-000000000002',
  fix: '00000000-0000-4000-a000-000000000003',
  mate: '00000000-0000-4000-a000-000000000004',
};

const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

export function subagentRows(session: { id: string; title: string }): Json[] {
  const base = { sessionId: session.id, model: null, totalTokens: null, toolUses: null, hasTranscript: true, session: { id: session.id, title: session.title } };
  return [
    {
      ...base,
      id: SUB_IDS.review,
      agentId: 'a8579439ace3dc3ae',
      toolUseId: 'tu-agent-review',
      parentAgentId: null,
      parentId: null,
      kind: 'subagent',
      description: 'Phase 4 code review M1',
      agentType: 'engineering-code-reviewer',
      name: null,
      background: true,
      status: 'completed',
      startedAt: at(40),
      lastEventAt: at(31),
      endedAt: at(31),
      durationMs: 9 * 60_000,
      eventCount: 4,
    },
    {
      ...base,
      id: SUB_IDS.dev,
      agentId: 'aef6947385afad951',
      toolUseId: 'tu-agent-dev',
      parentAgentId: null,
      parentId: null,
      kind: 'subagent',
      description: 'Phase 3 Dev M1: scaffold, hub, agent',
      agentType: 'general-purpose',
      name: null,
      background: true,
      status: 'running',
      startedAt: at(30),
      lastEventAt: at(1),
      endedAt: null,
      durationMs: null,
      eventCount: 6,
    },
    {
      ...base,
      id: SUB_IDS.fix,
      agentId: 'a1f1x0000000000aa',
      toolUseId: 'tu-agent-fix',
      parentAgentId: 'aef6947385afad951',
      parentId: SUB_IDS.dev,
      kind: 'subagent',
      description: 'Fix layout ping-pong loop',
      agentType: 'general-purpose',
      name: null,
      background: false,
      status: 'completed',
      startedAt: at(20),
      lastEventAt: at(15),
      endedAt: at(15),
      durationMs: 5 * 60_000,
      eventCount: 3,
    },
    {
      ...base,
      id: SUB_IDS.mate,
      agentId: 'asa-m4-e0ae234737d4106c',
      toolUseId: null,
      parentAgentId: null,
      parentId: null,
      kind: 'teammate',
      description: 'SA: per-window workspace spec',
      agentType: 'sa-m4',
      name: 'sa-m4',
      background: true,
      status: 'idle',
      startedAt: at(25),
      lastEventAt: at(10),
      endedAt: null,
      durationMs: null,
      eventCount: 3,
    },
  ];
}

const line = (id: string, l: Json): Json => ({ kind: 'line', id, ts: at(5), line: l });
const assistant = (id: string, content: Json[]) => line(id, { type: 'assistant', uuid: id, message: { id: `m-${id}`, role: 'assistant', content } });
const user = (id: string, content: unknown) => line(id, { type: 'user', uuid: id, message: { role: 'user', content } });

/** Lines appended to session 1's feed. */
export function sessionLines(): Json[] {
  return [
    assistant('l:1:0:s1', [
      {
        type: 'tool_use',
        id: 'tu-agent-review',
        name: 'Agent',
        input: { description: 'Phase 4 code review M1', subagent_type: 'engineering-code-reviewer', prompt: 'Проверь код', run_in_background: true },
      },
    ]),
    user('l:1:0:s2', [{ type: 'tool_result', tool_use_id: 'tu-agent-review', content: [{ type: 'text', text: 'async_launched agentId: a8579439ace3dc3ae' }] }]),
    assistant('l:1:0:s3', [
      {
        type: 'tool_use',
        id: 'tu-agent-dev',
        name: 'Task',
        input: { description: 'Phase 3 Dev M1: scaffold, hub, agent', subagent_type: 'general-purpose', prompt: 'Собери каркас', run_in_background: true },
      },
    ]),
    user('l:1:0:s4', [{ type: 'tool_result', tool_use_id: 'tu-agent-dev', content: [{ type: 'text', text: 'async_launched agentId: aef6947385afad951' }] }]),
    assistant('l:1:0:s5', [{ type: 'tool_use', id: 'tu-send', name: 'SendMessage', input: { to: 'sa-m4', message: 'Нужна спека окна' } }]),
    user('l:1:0:s6', [{ type: 'tool_result', tool_use_id: 'tu-send', content: 'delivered' }]),
    user('l:1:0:s7', '<teammate-message teammate_id="sa-m4" summary="SA: per-window workspace spec">Спека готова: окно хранит раскладку в sessionStorage.</teammate-message>'),
    line('l:1:0:s8', {
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'Проверь ещё раз тесты', origin: { kind: 'peer', name: 'aef6947385afad951', body: 'Проверь ещё раз тесты' } },
    }),
    user('l:1:0:s9', '<task-notification><task-id>a8579439ace3dc3ae</task-id><status>completed</status><summary>Agent "Phase 4 code review M1" completed</summary></task-notification>'),
  ];
}

/** The transcript of each subagent. */
export function subagentEvents(): Record<string, Json[]> {
  return {
    [SUB_IDS.review]: [user('l:r:1', 'Проверь код'), assistant('l:r:2', [{ type: 'text', text: 'Замечаний два: имена и тесты.' }])],
    [SUB_IDS.dev]: [
      user('l:d:1', 'Собери каркас'),
      assistant('l:d:2', [{ type: 'tool_use', id: 'tu-agent-fix', name: 'Agent', input: { description: 'Fix layout ping-pong loop', subagent_type: 'general-purpose', prompt: 'Почини цикл' } }]),
      user('l:d:3', [{ type: 'tool_result', tool_use_id: 'tu-agent-fix', content: [{ type: 'text', text: 'Цикл починен' }] }]),
      assistant('l:d:4', [{ type: 'text', text: 'Каркас собран, хаб поднят.' }]),
    ],
    [SUB_IDS.fix]: [user('l:f:1', 'Почини цикл'), assistant('l:f:2', [{ type: 'text', text: 'Цикл починен.' }])],
    [SUB_IDS.mate]: [
      user('l:m:1', '<teammate-message teammate_id="team-lead" summary="SA: per-window workspace spec">Нужна спека окна</teammate-message>'),
      assistant('l:m:2', [{ type: 'text', text: 'Пишу спеку.' }]),
    ],
  };
}
