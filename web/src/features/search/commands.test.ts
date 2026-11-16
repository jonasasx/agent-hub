// Ctrl K «>» commands (change profile-menu-grouping, spec quick-actions): the list by access and the filter.
import { describe, expect, it } from 'vitest';
import { buildCommands, filterCommands, isCommandQuery } from './commands';

const USER = { isAdmin: false, hasSubs: false, hasDesktop: false, canSleep: false };

describe('commands', () => {
  it('pages by access, then settings, then actions; sleep only with an awake session', () => {
    const ids = buildCommands(USER).map(c => c.id);
    expect(ids).toEqual([
      'page:machines',
      'page:sessions',
      'page:notifications',
      'page:language',
      'page:security',
      'param:idle',
      'param:language',
      'param:push',
      'action:hidden',
      'action:reset',
      'action:theme',
    ]);
    const admin = buildCommands({ isAdmin: true, hasSubs: true, hasDesktop: true, canSleep: true }).map(c => c.id);
    expect(admin).toContain('page:users');
    expect(admin).toContain('page:subscriptions');
    expect(admin).toContain('page:desktop');
    expect(admin).toContain('action:sleep');
  });

  it('«>» marks a command query', () => {
    expect(isCommandQuery('>сон')).toBe(true);
    expect(isCommandQuery('  > тема')).toBe(true);
    expect(isCommandQuery('сон')).toBe(false);
  });

  it('every word matches the label, the page or the keywords, case-insensitive; empty «>» lists all', () => {
    const all = buildCommands({ ...USER, canSleep: true });
    expect(filterCommands(all, '>')).toHaveLength(all.length);
    const sleep = filterCommands(all, '>СОН').map(c => c.id);
    expect(sleep).toContain('param:idle');
    expect(sleep).toContain('action:sleep');
    expect(filterCommands(all, '>сон сессии').map(c => c.id)).toContain('param:idle');
    expect(filterCommands(all, '>zzz')).toEqual([]);
    const idle = all.find(c => c.id === 'param:idle')!;
    expect(idle.kind).toBe('param');
    expect(idle.page).toBe('Сессии');
  });
});
