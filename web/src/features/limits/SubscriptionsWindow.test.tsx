// The ring of a collapsed subscription is built from the windows of the rows. Requirement (tool-windows): Окно «Подписки».
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useStore } from '../../store';
import { resetStore } from '../../test/factories';
import { subsResponse, SUB_A } from '../subscriptions/fixtures';
import { limResponse, limView, win } from './fixtures';
import { SubscriptionsWindow } from './SubscriptionsWindow';

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

describe('SubscriptionsWindow ring', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    useStore.setState({ subs: subsResponse() });
  });

  it('a quiet check later than the window and a reset window: the ring is still there, with the largest live window', () => {
    const lim = limView({
      windows: [
        win({ type: 'five_hour', utilization: 0, resetsAt: at(-60), observedAt: at(-90) }),
        win({ type: 'seven_day', utilization: 26, resetsAt: at(3 * 1440), observedAt: at(-6), status: 'allowed' }),
      ],
      quietAt: at(-1),
    });
    useStore.setState({ limits: limResponse([lim]) });
    render(<SubscriptionsWindow />);
    const ring = screen.getByRole('img', { name: /^7 дн — 26%, сброс / });
    expect(ring).toBeInTheDocument();
    expect(ring.getAttribute('aria-label')).not.toContain('неизвестен');
  });

  it('all windows reset: a ring of 0% with the first window', () => {
    const lim = limView({ subscriptionId: SUB_A, windows: [win({ utilization: 40, resetsAt: at(-10) })], quietAt: at(-1) });
    useStore.setState({ limits: limResponse([lim]) });
    render(<SubscriptionsWindow />);
    const ring = screen.getByRole('img', { name: '5 ч — окно сброшено' });
    expect(ring).toHaveClass('ok');
    expect(ring.querySelector('.vl')?.getAttribute('stroke-dasharray')).toMatch(/^0\.00 /);
  });

  const show = (windows: ReturnType<typeof win>[], over: Parameters<typeof limView>[0] = {}) => {
    useStore.setState({ limits: limResponse([limView({ windows, ...over })]) });
    return render(<SubscriptionsWindow />);
  };
  const dash = (ring: HTMLElement) => ring.querySelector('.vl')?.getAttribute('stroke-dasharray')?.split(' ')[0];

  it('40% and 82%: the ring is 82% and yellow with «7 дн — 82%, сброс …»', () => {
    show([win({ type: 'five_hour', utilization: 40, resetsAt: at(100) }), win({ type: 'seven_day', utilization: 82, resetsAt: at(3000) })]);
    const ring = screen.getByRole('img', { name: /^7 дн — 82%, сброс / });
    expect(ring).toHaveClass('warn');
  });

  it('equal percents: the earlier reset wins', () => {
    show([win({ type: 'seven_day', utilization: 50, resetsAt: at(3000) }), win({ type: 'five_hour', utilization: 50, resetsAt: at(100) })]);
    expect(screen.getByRole('img', { name: /^5 ч — 50%/ })).toBeInTheDocument();
  });

  it('rejected without a percent is 100% red, allowed_warning without a percent is 80% yellow', () => {
    const { unmount } = show([win({ utilization: null, status: 'rejected', resetsAt: at(100) })]);
    const red = screen.getByRole('img', { name: /^5 ч — 100%/ });
    expect(red).toHaveClass('bad');
    expect(Number(dash(red as unknown as HTMLElement))).toBeGreaterThan(0);
    unmount();
    show([win({ utilization: null, status: 'allowed_warning', resetsAt: at(100) })]);
    expect(screen.getByRole('img', { name: /^5 ч — 80%/ })).toHaveClass('warn');
  });

  it('a state other than ok or no windows: no ring, «нет данных» when expanded', async () => {
    const { unmount } = show([win({ resetsAt: at(100) })], { state: 'stale' });
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { expanded: false })[0]!);
    expect(screen.getByText('нет данных')).toBeInTheDocument();
    unmount();
    localStorage.clear();
    show([]);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('an expanded subscription has no ring; a reset window shows 0% without a reset time', async () => {
    show([win({ type: 'five_hour', utilization: 70, resetsAt: at(-5) }), win({ type: 'seven_day', utilization: 26, resetsAt: at(3000) })]);
    await userEvent.click(screen.getAllByRole('button', { expanded: false })[0]!);
    expect(screen.queryByRole('img')).toBeNull();
    const row = screen.getByText('5 ч').closest('.tw-lim') as HTMLElement;
    expect(row).toHaveClass('reset');
    expect(within(row).getByText('0%')).toBeInTheDocument();
    expect(row.querySelector('.tw-rs')?.textContent).toBe('');
  });
});
