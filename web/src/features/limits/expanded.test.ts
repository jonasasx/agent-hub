// The expanded subscriptions are remembered under a versioned key; the key of the first build is migrated once.
import { afterEach, describe, expect, it } from 'vitest';
import { loadExpanded } from './SubscriptionsWindow';

describe('loadExpanded', () => {
  afterEach(() => localStorage.clear());

  it('reads the old key once, moves it to the new one and removes it', () => {
    localStorage.setItem('subsExpanded', JSON.stringify(['a', 'b']));
    expect(loadExpanded()).toEqual(['a', 'b']);
    expect(localStorage.getItem('subsExpanded')).toBeNull();
    expect(JSON.parse(localStorage.getItem('ah-subs-expanded.v1')!)).toEqual(['a', 'b']);
  });

  it('the new key wins over the old one', () => {
    localStorage.setItem('ah-subs-expanded.v1', JSON.stringify(['n']));
    localStorage.setItem('subsExpanded', JSON.stringify(['o']));
    expect(loadExpanded()).toEqual(['n']);
    expect(localStorage.getItem('subsExpanded')).toBeNull();
  });

  it('nothing stored: all collapsed', () => {
    expect(loadExpanded()).toEqual([]);
  });
});
