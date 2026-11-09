// buildChat on real `.jsonl` lines (fixtures/real-session.jsonl).
import { describe, expect, it } from 'vitest';
import { wrapVoiceTurn } from '@agent-hub/shared';
import type { PermissionView } from '../../api/types';
import { fixtureEvents } from './fixtures';
import { buildChat, matchPending, pendingSlot, toolDiff, toolTarget } from './transcript';

const perm = (over: Partial<PermissionView> = {}): PermissionView => ({
  requestId: 'r1',
  sessionId: 's1',
  toolName: 'Bash',
  toolUseId: 'toolu_x',
  input: { command: 'npm run crawl -- --dry-run' },
  createdAt: '2026-10-25T05:00:00Z',
  resolvedAt: null,
  decision: null,
  message: null,
  kind: 'tool',
  ...over,
});

describe('buildChat on real lines', () => {
  const items = buildChat(fixtureEvents());

  it('keeps the order: user, Bash, Edit, Write, assistant text, interrupt, compaction notes', () => {
    expect(items.map(i => (i.kind === 'tool' ? `tool:${i.name}` : i.kind))).toEqual(['user', 'tool:Bash', 'tool:Edit', 'tool:Write', 'assistant', 'note', 'note', 'note']);
  });

  it('hides thinking, isMeta user lines, turn_duration and service lines', () => {
    expect(items.some(i => i.kind === 'user' && i.text.startsWith('[Image:'))).toBe(false);
    expect(items.filter(i => i.kind === 'note').map(i => (i as { text: string }).text)).toEqual(['Ход прерван', 'Контекст сжат', 'Compacted while idle, before the prompt cache expired']);
  });

  it('pairs a tool call with its result by tool_use_id', () => {
    const bash = items.find(i => i.kind === 'tool' && i.name === 'Bash');
    expect(bash).toMatchObject({ target: 'List guides and notes', result: { isError: false } });
    expect(bash && bash.kind === 'tool' && bash.result?.text).toContain('guide-setup.md');
  });

  it('Дифф правки: Edit uses structuredPatch of the result', () => {
    const edit = items.find(i => i.kind === 'tool' && i.name === 'Edit');
    if (edit?.kind !== 'tool') throw new Error('no edit');
    expect(edit.target).toMatch(/app\\index\.html$/);
    expect(edit.diff?.[0]).toEqual({ kind: 'hunk', text: '@@ -710,7 +710,6 @@' });
    expect(edit.diff?.filter(d => d.kind === 'del')).toHaveLength(1);
    expect(edit.diff?.filter(d => d.kind === 'ctx').length).toBeGreaterThan(3);
  });

  it('Write of a new file: every line added', () => {
    const w = items.find(i => i.kind === 'tool' && i.name === 'Write');
    if (w?.kind !== 'tool') throw new Error('no write');
    expect(w.diff?.every(d => d.kind === 'add')).toBe(true);
    expect(w.diff?.[0]?.text).toBe('---');
  });

  it('assistant text keeps Markdown source and the message id', () => {
    const a = items.find(i => i.kind === 'assistant');
    expect(a).toMatchObject({ messageId: 'msg_011CgNQDt3WpkUjUorjSAZv3' });
    expect(a && a.kind === 'assistant' && a.text).toContain('**Что можно пройти руками:**');
  });
});

describe('buildChat: hub items', () => {
  it('Карточка разрешения: an open request is a card, a resolved one a note', () => {
    expect(buildChat([{ kind: 'permission', id: 'p:r1', ts: '', request: perm() }])[0]).toMatchObject({ kind: 'permission' });
    expect(buildChat([{ kind: 'permission', id: 'p:r1', ts: '', request: perm({ resolvedAt: 'x', decision: 'allow' }) }])[0]).toMatchObject({ kind: 'note', text: 'Bash: разрешено' });
    expect(buildChat([{ kind: 'permission', id: 'p:r1', ts: '', request: perm({ resolvedAt: 'x', decision: 'deny' }) }])[0]).toMatchObject({ text: 'Bash: запрещено' });
    expect(buildChat([{ kind: 'permission', id: 'p:r1', ts: '', request: perm({ resolvedAt: 'x', decision: 'deny', message: 'уснула, не дождавшись разрешения' }) }])[0]).toMatchObject({
      text: 'Bash: запрещено — уснула, не дождавшись разрешения',
    });
  });

  it('hub notes (resume, mode change) pass through', () => {
    expect(buildChat([{ kind: 'note', id: 'n:1', ts: '', text: 'Поднята через resume' }])).toEqual([{ kind: 'note', id: 'n:1', text: 'Поднята через resume' }]);
  });

  it('a slash command becomes a note', () => {
    const line = { type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args></command-args>' } };
    expect(buildChat([{ kind: 'line', id: 'l1', ts: '', line }])[0]).toMatchObject({ kind: 'note', text: 'Команда /compact' });
  });

  it('a tool result with is_error is marked as error', () => {
    const use = { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } };
    const res = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'ENOENT' }] }] } };
    const [t] = buildChat([
      { kind: 'line', id: 'a', ts: '', line: use },
      { kind: 'line', id: 'b', ts: '', line: res },
    ]);
    expect(t).toMatchObject({ kind: 'tool', target: '/x', result: { text: 'ENOENT', isError: true } });
  });
});

describe('tool helpers', () => {
  it('targets', () => {
    expect(toolTarget('Bash', { command: 'hostname' })).toBe('hostname');
    expect(toolTarget('Grep', { pattern: 'foo', path: 'src' })).toBe('foo · src');
    expect(toolTarget('mcp__x__y', { query: 'abc' })).toBe('abc');
  });
  it('Edit without a result: diff from old/new strings', () => {
    expect(toolDiff('Edit', { old_string: 'a\nb', new_string: 'c' }, null)).toEqual([
      { kind: 'del', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
  });
  it('Edit whose big toolUseResult moved to S3 ($blob, D4): structuredPatch kept next to the reference; without it — from input', () => {
    const ref = { $blob: 'ab', size: 200_000, mime: 'application/json', preview: '{' };
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }];
    expect(toolDiff('Edit', { old_string: 'x', new_string: 'y' }, { ...ref, structuredPatch: patch })).toEqual([
      { kind: 'hunk', text: '@@ -1,1 +1,1 @@' },
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
    expect(toolDiff('Edit', { old_string: 'x', new_string: 'y' }, ref)).toEqual([
      { kind: 'del', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
  });
  it('MultiEdit joins edits with a separator', () => {
    const d = toolDiff(
      'MultiEdit',
      {
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      },
      null,
    );
    expect(d?.map(x => x.kind)).toEqual(['del', 'add', 'hunk', 'del', 'add']);
  });
  it('non-editing tools have no diff', () => {
    expect(toolDiff('Bash', {}, null)).toBeNull();
  });
});

describe('optimistic copies (bug from Ivan, M4b)', () => {
  const build = buildChat;
  const ev = (id: string, line: Record<string, unknown>) => ({ kind: 'line', id, ts: '', line }) as never;
  const user = (id: string, uuid: string, content: unknown, promptId?: string) => ev(id, { type: 'user', uuid, ...(promptId ? { promptId } : {}), message: { role: 'user', content } });
  const answer = (id: string, text: string) => ev(id, { type: 'assistant', message: { id: `m${id}`, role: 'assistant', content: [{ type: 'text', text }] } });
  const img = (sha: string) => ({ type: 'image', source: { $blob: sha, mime: 'image/png', size: 1 } });

  it('by uuid (never by the CLI promptId), else by text and image sha after its place; one line answers one copy', () => {
    const events = [answer('e1', 'раньше'), user('e2', 'other', [img('aa'), { type: 'text', text: 'Давай эту' }]), answer('e3', 'ответ'), user('e4', 'x', 'ещё', 'cu-3')];
    const items = build(events);
    expect(matchPending(items, events, [{ clientUuid: 'cu-1', text: 'Давай эту', images: [{ sha256: 'aa' }], afterEventId: 'e1' }])).toEqual(new Set(['cu-1']));
    expect(matchPending(items, events, [{ clientUuid: 'cu-2', text: 'Давай эту', images: [{ sha256: 'bb' }], afterEventId: 'e1' }])).toEqual(new Set());
    // the line before the copy's place is an older message with the same text
    expect(matchPending(items, events, [{ clientUuid: 'cu-1', text: 'Давай эту', images: [{}], afterEventId: 'e3' }])).toEqual(new Set());
    expect(matchPending(items, events, [{ clientUuid: 'cu-3', text: 'другое', images: [], afterEventId: null }])).toEqual(new Set());
    expect(matchPending(items, events, [{ clientUuid: 'x', text: 'другое', images: [], afterEventId: null }])).toEqual(new Set(['x']));
    expect(
      matchPending(items, events, [
        { clientUuid: 'a', text: 'Давай эту', images: [{}], afterEventId: 'e1' },
        { clientUuid: 'b', text: 'Давай эту', images: [{}], afterEventId: 'e1' },
      ]),
    ).toEqual(new Set(['a']));
  });

  it('a copy stands after the event it was sent after, before what came later', () => {
    const events = [answer('e1', 'раньше'), answer('e2', 'потом')];
    const items = build(events);
    expect(pendingSlot(items, events, 'e1')).toBe(1);
    expect(pendingSlot(items, events, 'e2')).toBe(2);
    expect(pendingSlot(items, events, 'gone')).toBe(2);
    expect(pendingSlot(items, events, null)).toBe(2);
  });
});

// claude-subscriptions QA obs 3: the same event once in the chat, nothing of it lost
describe('buildChat: no duplicate notes', () => {
  const note = (id: string, text: string) => ({ kind: 'note' as const, id, ts: '', text });
  const line = (id: string, l: Record<string, unknown>) => ({ kind: 'line' as const, id, ts: '', line: l });
  const typed = (id: string, text: string) => line(id, { type: 'user', uuid: id, message: { role: 'user', content: text } });
  const notes = (items: ReturnType<typeof buildChat>) => items.filter(i => i.kind === 'note').map(i => (i as { text: string }).text);

  it('«Прервать»: the hub note and the line of Claude Code are one «Ход прерван» per turn; the next turn has its own', () => {
    const items = buildChat([
      typed('u1', 'запусти'),
      note('n:1', 'Ход прерван'),
      line('l1', { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
      typed('u2', 'ещё раз'),
      line('l2', { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }),
    ]);
    expect(notes(items)).toEqual(['Ход прерван', 'Ход прерван']);
    expect(items.map(i => i.kind)).toEqual(['user', 'note', 'user', 'note']);
  });

  it('the retries of a 401 (one api_error line per attempt) are one note with the error text and the count', () => {
    const apiErr = (id: string, attempt: number) =>
      line(id, {
        type: 'system',
        subtype: 'api_error',
        level: 'error',
        source: 'request_retry',
        retryAttempt: attempt,
        maxRetries: 10,
        error: { status: 401, formatted: '401 OAuth access token is invalid.' },
      });
    const items = buildChat([typed('u1', 'привет'), apiErr('l1', 1), apiErr('l2', 2), typed('u2', 'ещё'), apiErr('l3', 1)]);
    expect(notes(items)).toEqual(['Ошибка API: 401 OAuth access token is invalid. (попыток: 2)', 'Ошибка API: 401 OAuth access token is invalid.']);
  });

  it('different API errors stay separate notes', () => {
    const items = buildChat([
      line('l1', { type: 'system', subtype: 'api_error', error: { formatted: '529 Overloaded' } }),
      line('l2', { type: 'system', subtype: 'api_error', error: { formatted: '401 OAuth access token is invalid.' } }),
    ]);
    expect(notes(items)).toEqual(['Ошибка API: 529 Overloaded', 'Ошибка API: 401 OAuth access token is invalid.']);
  });
});

// change voice-conversation D6: an utterance of a voice conversation shows its text and the «голосом» mark
describe('buildChat: voice turns', () => {
  const ev = (id: string, line: Record<string, unknown>) => ({ kind: 'line', id, ts: '', line }) as never;
  const user = (id: string, content: unknown) => ev(id, { type: 'user', uuid: id, message: { role: 'user', content } });

  it('the <voice-turn> wrapper is dropped, the item carries voice; a typed message does not', () => {
    const items = buildChat([user('e1', wrapVoiceTurn('какая погода')), user('e2', [{ type: 'text', text: wrapVoiceTurn('и завтра') }]), user('e3', 'набрано')]);
    expect(items.map(i => (i.kind === 'user' ? [i.text, i.voice ?? false] : i.kind))).toEqual([
      ['какая погода', true],
      ['и завтра', true],
      ['набрано', false],
    ]);
  });
});
