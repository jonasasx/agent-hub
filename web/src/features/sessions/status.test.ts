// Unit tests of status helpers. Requirements: Статусы сессии; Засыпание по простою («уснёт через N мин»).
import { describe, expect, it } from 'vitest';
import { RUNNERS, session } from '../../test/factories';
import { agoLabel, displayStatus, isNow, needsMe, nowList, isReadOnly, runnerIndex, sleepsInMin, statusText, tabNeedsGlyph } from './status';
import { mergeEvents } from '../workspace/actions';

const idx = runnerIndex(RUNNERS);
const NOW = Date.parse('2026-10-25T12:00:00Z');

describe('status helpers', () => {
  it('offline is computed from the runner, closed and sleeping sessions included (QA M3c: resume answers 409 runner_offline)', () => {
    expect(displayStatus(session({ runnerId: 'hp', status: 'working' }), idx)).toBe('offline');
    expect(displayStatus(session({ runnerId: 'hp', status: 'closed' }), idx)).toBe('offline');
    expect(displayStatus(session({ runnerId: 'hp', status: 'sleeping' }), idx)).toBe('offline');
    expect(isReadOnly(session({ runnerId: 'hp', status: 'closed' }), idx)).toBe(true);
    expect(displayStatus(session({ runnerId: 'x1', status: 'closed' }), idx)).toBe('closed');
    expect(displayStatus(session({ runnerId: 'nope', status: 'waiting' }), idx)).toBe('offline');
    expect(isReadOnly(session({ runnerId: 'hp' }), idx)).toBe(true);
  });
  it('tab glyph only for action needed or a running turn', () => {
    expect(tabNeedsGlyph(session({ status: 'sleeping' }), idx)).toBe(false);
    expect(tabNeedsGlyph(session({ status: 'waiting', unread: true }), idx)).toBe(true);
  });
  it('agoLabel', () => {
    const at = (m: number) => new Date(NOW - m * 60_000).toISOString();
    expect([0, 12, 180, 1500, 7200].map(m => agoLabel(at(m), NOW))).toEqual(['сейчас', '12 мин', '3 ч', 'вчера', '5 дн']);
  });
  it('sleepsInMin never exceeds the timeout: right after a turn with the client clock 20 s behind the hub — 30, not 31', () => {
    const turnEnd = NOW + 20_000; // the hub's clock is ahead
    const sleepsAt = new Date(turnEnd + 30 * 60_000).toISOString();
    expect(sleepsInMin(session({ status: 'waiting', sleepsAt, effectiveIdleTimeoutMin: 30 }), NOW)).toBe(30);
    // without skew: 30:00 exactly and 29:59.5 left — both «30 мин»
    expect(sleepsInMin(session({ status: 'waiting', sleepsAt: new Date(NOW + 30 * 60_000).toISOString(), effectiveIdleTimeoutMin: 30 }), NOW)).toBe(30);
    expect(sleepsInMin(session({ status: 'waiting', sleepsAt: new Date(NOW + 29.99 * 60_000).toISOString(), effectiveIdleTimeoutMin: 30 }), NOW)).toBe(30);
    // «не усыплять» (0) does not cap
    expect(sleepsInMin(session({ status: 'waiting', sleepsAt: new Date(NOW + 45 * 60_000).toISOString(), effectiveIdleTimeoutMin: 0 }), NOW)).toBe(45);
  });

  it('sleepsInMin counts down only while waiting', () => {
    const sleepsAt = new Date(NOW + 26.2 * 60_000).toISOString();
    expect(sleepsInMin(session({ status: 'waiting', sleepsAt }), NOW)).toBe(27);
    expect(sleepsInMin(session({ status: 'working', sleepsAt }), NOW)).toBeNull();
  });
});

describe('working subagents make the waiting session «работает»', () => {
  const sub = (running: number, working: number) => ({ total: running + 1, running, working }) as never;
  it('waiting with a working subagent or background command is working, glyph and «Сейчас» included', () => {
    const s = session({ status: 'waiting', subagents: sub(2, 1) });
    expect(displayStatus(s, idx)).toBe('working');
    expect(statusText(s, 'working')).toBe('работает в фоне');
    expect(tabNeedsGlyph(s, idx)).toBe(true);
    expect(isNow(s, idx)).toBe(true);
  });
  it('idle teammates only, a permission request, a sleeping session and an offline machine keep their status', () => {
    expect(displayStatus(session({ status: 'waiting', subagents: sub(2, 0) }), idx)).toBe('waiting');
    expect(displayStatus(session({ status: 'waiting', subagents: { total: 2, running: 2 } }), idx)).toBe('waiting');
    expect(displayStatus(session({ status: 'permission', subagents: sub(1, 1) }), idx)).toBe('permission');
    expect(displayStatus(session({ status: 'sleeping', subagents: sub(1, 1) }), idx)).toBe('sleeping');
    expect(displayStatus(session({ runnerId: 'hp', status: 'waiting', subagents: sub(1, 1) }), idx)).toBe('offline');
    expect(statusText(session({ status: 'working', subagents: sub(1, 1) }), 'working')).toBe('работает');
  });
  it('an unread answer still waits for the user; no sleep countdown while children work', () => {
    const unread = session({ id: 'u', status: 'waiting', unread: true, subagents: sub(1, 1) });
    const busy = session({ id: 'b', status: 'working' });
    expect(needsMe(unread, idx)).toBe(true);
    expect(nowList([busy, unread], idx).map(s => s.id)).toEqual(['u', 'b']);
    expect(sleepsInMin(session({ status: 'waiting', subagents: sub(1, 1), sleepsAt: new Date(NOW + 60 * 60_000).toISOString() }), NOW)).toBeNull();
  });
  it('«Сейчас» omits sessions a hub session started, except one waiting for a permission (D10)', () => {
    const by = { id: 'p', title: 'Родитель' };
    const working = session({ id: 'w', status: 'working', spawnedBy: by });
    const asking = session({ id: 'a', status: 'permission', spawnedBy: by });
    const plain = session({ id: 'n', status: 'working' });
    expect(
      nowList([working, asking, plain], idx)
        .map(s => s.id)
        .sort(),
    ).toEqual(['a', 'n']);
  });
});

describe('mergeEvents', () => {
  const note = (id: string, text: string) => ({ kind: 'note' as const, id, ts: '', text });
  it('appends new, replaces by id, prepends older pages', () => {
    const cur = [note('a', '1'), note('b', '2')];
    expect(mergeEvents(cur, [note('b', '2!'), note('c', '3')]).map(e => (e as { text: string }).text)).toEqual(['1', '2!', '3']);
    expect(mergeEvents(cur, [note('z', '0')], true).map(e => e.id)).toEqual(['z', 'a', 'b']);
  });
});

describe('change subagents: external and the pending tool (S10.1, S10.3)', () => {
  it('a closed or sleeping session written outside the hub is «работает в терминале»; a question and a plan say so', () => {
    const ext = session({ status: 'closed', source: 'terminal', originSource: 'terminal', externalActive: true });
    expect(displayStatus(ext, idx)).toBe('external');
    expect(statusText(ext, displayStatus(ext, idx))).toBe('работает в терминале');
    expect(displayStatus(session({ status: 'closed', externalActive: false }), idx)).toBe('closed');
    const p = (toolName: string | null) => session({ status: 'permission', pendingPermission: toolName ? { toolName } : null });
    expect(statusText(p('AskUserQuestion'), 'permission')).toBe('ждёт ответа на вопрос');
    expect(statusText(p('ExitPlanMode'), 'permission')).toBe('ждёт утверждения плана');
    expect(statusText(p('Bash'), 'permission')).toBe('ждёт разрешения');
    expect(statusText(p(null), 'permission')).toBe('ждёт разрешения');
  });
});
