// Requirement: Нативные уведомления (design D6).
import { describe, expect, it } from 'vitest';
import { RUNNERS, session } from '../test/factories.js';
import { HubState } from './hubState.js';
import { decideNotification } from './notify.js';

const base = { runners: RUNNERS, activeVisible: false as boolean | undefined, windowVisibleAndFocused: false };

describe('decideNotification', () => {
  it('working → waiting+unread: «Ждёт ответа: …» / «<проект> · <машина>»', () => {
    const prev = session({ status: 'working' });
    const next = { ...prev, status: 'waiting' as const, unread: true };
    expect(decideNotification({ ...base, prev, next })).toEqual({ sessionId: prev.id, reason: 'turn_ended', title: 'Ждёт ответа: Ревизия DNS', body: 'Сеть · X1' });
  });
  it('→ permission: «Ждёт разрешения: …»', () => {
    const prev = session({ status: 'working' });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'permission' } })?.title).toBe('Ждёт разрешения: Ревизия DNS');
  });
  it('a session unseen before is a baseline: its first waiting upsert does not notify (long-waiting after a reseed)', () => {
    expect(decideNotification({ ...base, prev: undefined, next: session({ status: 'permission' }) })).toBeNull();
    expect(decideNotification({ ...base, prev: undefined, next: session({ status: 'waiting', unread: true }) })).toBeNull();
  });
  it('→ permission with activeVisible: true — suppressed', () => {
    const prev = session({ status: 'working' });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'permission' }, activeVisible: true })).toBeNull();
  });
  it('no activeVisible field: suppressed when the window is visible and focused, shown otherwise', () => {
    const prev = session({ status: 'working' });
    const next = { ...prev, status: 'permission' as const };
    expect(decideNotification({ ...base, prev, next, activeVisible: undefined, windowVisibleAndFocused: true })).toBeNull();
    expect(decideNotification({ ...base, prev, next, activeVisible: undefined, windowVisibleAndFocused: false })).not.toBeNull();
  });
  it('activeVisible: false wins over the focused window (the hub knows better)', () => {
    const prev = session({ status: 'working' });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'permission' }, activeVisible: false, windowVisibleAndFocused: true })).not.toBeNull();
  });
  it('the same waiting upsert again — no second notification', () => {
    const s = session({ status: 'waiting', unread: true });
    expect(decideNotification({ ...base, prev: s, next: { ...s } })).toBeNull();
  });
  it('permission → waiting+unread stays waiting — no notification', () => {
    const s = session({ status: 'permission' });
    expect(decideNotification({ ...base, prev: s, next: { ...s, status: 'waiting', unread: true } })).toBeNull();
  });
  it('Сессия из терминала (isHubManaged = false) — no notification', () => {
    const prev = session({ status: 'working', isHubManaged: false, source: 'terminal' });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'waiting', unread: true } })).toBeNull();
  });
  it('a session a hub session started: a finished turn does not notify (it answers the parent), a permission request does', () => {
    const by = { id: 'p', title: 'Родитель' };
    const prev = session({ status: 'working', spawnedBy: by });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'waiting' as const, unread: true } })).toBeNull();
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'permission' as const } })?.reason).toBe('permission');
  });
  it('a turn ends while background tasks or child sessions work — no notification; the end of the last one notifies', () => {
    const sub = (working: number, hub = 0) => ({ total: 2, running: 0, working, background: 2, hub: { total: 1, working: hub } });
    const prev = session({ status: 'working', subagents: sub(2) });
    const ended = { ...prev, status: 'waiting' as const, unread: true };
    expect(decideNotification({ ...base, prev, next: ended })).toBeNull();
    const childOnly = { ...ended, subagents: sub(0, 1) };
    expect(decideNotification({ ...base, prev: ended, next: childOnly })).toBeNull();
    const done = { ...ended, subagents: sub(0) };
    expect(decideNotification({ ...base, prev: childOnly, next: done })?.reason).toBe('turn_ended');
    // read while the children worked — nothing to notify when they end
    expect(decideNotification({ ...base, prev: { ...ended, unread: false }, next: { ...done, unread: false } })).toBeNull();
  });
  it('a permission request notifies while background tasks work', () => {
    const prev = session({ status: 'working', subagents: { total: 1, running: 1, working: 1 } });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'permission' } })?.reason).toBe('permission');
  });
  it('cron — no notification', () => {
    const prev = session({ status: 'working', isCron: true });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'permission' } })).toBeNull();
  });
  it('waiting read (unread false) and offline machine — no notification', () => {
    const prev = session({ status: 'working' });
    expect(decideNotification({ ...base, prev, next: { ...prev, status: 'waiting', unread: false } })).toBeNull();
    const off = session({ status: 'working', runnerId: 'hp' });
    expect(decideNotification({ ...base, prev: off, next: { ...off, status: 'permission' } })).toBeNull();
  });
});

describe('HubState', () => {
  it('seed from the sidebar never notifies; Переподключение без дублей', () => {
    const st = new HubState();
    const a = session({ status: 'permission' });
    const b = session({ status: 'waiting', unread: true });
    st.seed({ now: [a, b], runners: [...RUNNERS.values()] });
    expect(st.waitingCount()).toBe(2);
    // The hub re-sends the same rows after a reconnect: no transition.
    expect(st.handle({ type: 'session.upsert', session: a, activeVisible: false }, false)).toEqual({ kind: 'changed', notification: null });
    // Seed again (reconnect) with the same state: still nothing to notify, counter unchanged.
    st.seed({ now: [a, b], runners: [...RUNNERS.values()] });
    expect(st.waitingCount()).toBe(2);
  });
  it('upsert of a turn end notifies once, reading it lowers the counter', () => {
    const st = new HubState();
    const s = session({ status: 'working' });
    st.seed({ now: [s], runners: [...RUNNERS.values()] });
    const ended = { ...s, status: 'waiting' as const, unread: true };
    const r = st.handle({ type: 'session.upsert', session: ended, activeVisible: false }, false);
    expect(r.kind === 'changed' && r.notification?.title).toBe('Ждёт ответа: Ревизия DNS');
    expect(st.waitingCount()).toBe(1);
    st.handle({ type: 'session.upsert', session: { ...ended, unread: false }, activeVisible: true }, false);
    expect(st.waitingCount()).toBe(0);
  });
  it('seed takes «Сейчас» from now ∪ projects[].sessions, like the web', () => {
    const st = new HubState();
    const inNow = session({ status: 'permission' });
    const onlyInProject = session({ status: 'waiting', unread: true });
    st.seed({
      now: [inNow],
      projects: [{ project: inNow.project, live: 1, total: 2, lastActivityAt: null, sessions: [inNow, onlyInProject] }],
      runners: [...RUNNERS.values()],
    });
    expect(st.sessions.size).toBe(2);
    expect(st.waitingCount()).toBe(2);
  });
  it('a machine coming back online asks for a silent reseed; going offline does not', () => {
    const st = new HubState();
    const hp = RUNNERS.get('hp')!;
    st.seed({ now: [], runners: [...RUNNERS.values()] });
    expect(st.handle({ type: 'runner.status', runner: { ...hp, online: true } }, false)).toEqual({ kind: 'reseed' });
    expect(st.handle({ type: 'runner.status', runner: { ...hp, online: true } }, false)).toEqual({ kind: 'changed', notification: null });
    expect(st.handle({ type: 'runner.status', runner: { ...hp, online: false } }, false)).toEqual({ kind: 'changed', notification: null });
    expect(st.handle({ type: 'runner.status', runner: { ...RUNNERS.get('x1')!, id: 'new', online: true } }, false)).toEqual({ kind: 'reseed' });
  });
  it('runner.status updates machines; projects.changed asks for a reseed; junk is ignored', () => {
    const st = new HubState();
    st.seed({ now: [session({ status: 'permission' })], runners: [...RUNNERS.values()] });
    st.handle({ type: 'runner.status', runner: { ...RUNNERS.get('x1')!, online: false } }, false);
    expect(st.waitingCount()).toBe(0);
    expect(st.handle({ type: 'projects.changed' }, false)).toEqual({ kind: 'reseed' });
    expect(st.handle({ type: 'session.events', sessionId: 'x', events: [] }, false)).toEqual({ kind: 'ignored' });
    expect(st.handle(null, false)).toEqual({ kind: 'ignored' });
    expect(st.handle({ type: 'session.upsert' }, false)).toEqual({ kind: 'ignored' });
  });
});
