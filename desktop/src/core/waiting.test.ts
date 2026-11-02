// Requirement: Счётчик ждущих сессий в трее. Same cases as web/src/features/sessions/status.ts (needsMe, nowList cron).
import { describe, expect, it } from 'vitest';
import { RUNNERS, session } from '../test/factories.js';
import { displayStatus, needsMe, waitingCount } from './waiting.js';

describe('needsMe (copy of web)', () => {
  it('permission waits', () => expect(needsMe(session({ status: 'permission' }), RUNNERS)).toBe(true));
  it('waiting + unread waits', () => expect(needsMe(session({ status: 'waiting', unread: true }), RUNNERS)).toBe(true));
  it('waiting read does not wait', () => expect(needsMe(session({ status: 'waiting', unread: false }), RUNNERS)).toBe(false));
  it('working, sleeping, closed do not wait', () => {
    for (const status of ['working', 'sleeping', 'closed'] as const) expect(needsMe(session({ status, unread: true }), RUNNERS)).toBe(false);
  });
  it('offline machine: displayStatus offline, does not wait', () => {
    expect(displayStatus(session({ runnerId: 'hp', status: 'permission' }), RUNNERS)).toBe('offline');
    expect(needsMe(session({ runnerId: 'hp', status: 'permission' }), RUNNERS)).toBe(false);
    expect(needsMe(session({ runnerId: 'nope', status: 'waiting', unread: true }), RUNNERS)).toBe(false);
  });
});

describe('waitingCount', () => {
  it('Две сессии ждут: permission + unread answer, the working one is not counted', () => {
    const list = [session({ status: 'permission' }), session({ status: 'waiting', unread: true }), session({ status: 'working' })];
    expect(waitingCount(list, RUNNERS)).toBe(2);
  });
  it('cron is hidden like «Сейчас» (showCron = false), terminal sessions are counted', () => {
    const list = [session({ status: 'permission', isCron: true }), session({ status: 'waiting', unread: true, isHubManaged: false, source: 'terminal' })];
    expect(waitingCount(list, RUNNERS)).toBe(1);
  });
  it('Машина ушла из сети', () => {
    const runners = new Map(RUNNERS);
    const list = [session({ status: 'permission' })];
    expect(waitingCount(list, runners)).toBe(1);
    runners.set('x1', { ...runners.get('x1')!, online: false });
    expect(waitingCount(list, runners)).toBe(0);
  });
});
