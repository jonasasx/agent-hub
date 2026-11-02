import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { RunnerView } from '../../api/types';
import { RunnerFooter, agentMark, formatLastSeen, runnerTooltip } from './RunnerFooter';

const NOW = new Date(2026, 9, 25, 12, 0);
const today641 = new Date(2026, 9, 25, 6, 41).toISOString();
const yesterday = new Date(2026, 9, 24, 23, 5).toISOString();

const base: RunnerView = {
  id: 'x1',
  name: 'X1',
  kind: 'machine',
  os: 'Windows 11 Pro',
  online: true,
  lastSeenAt: today641,
  agentVersion: '0.1.0',
  claudeVersion: '2.1.310',
  protocolVersion: '1.0',
  incompatible: false,
  vaultRoot: null,
  homeDir: null,
};

const runners: RunnerView[] = [base, { ...base, id: 'hp', name: 'HP', online: false }, { ...base, id: 'vm', name: 'ВМ .3', os: 'Ubuntu 24.04.1 LTS', online: false, lastSeenAt: yesterday }];

describe('formatLastSeen', () => {
  it('shows time for today and date + time for earlier days', () => {
    expect(formatLastSeen(today641, NOW)).toBe('06:41');
    expect(formatLastSeen(yesterday, NOW)).toBe('24.10 23:05');
    expect(formatLastSeen(null, NOW)).toBeNull();
  });
});

describe('RunnerFooter — «Три машины в подвале панели»', () => {
  it('lists X1, HP and ВМ .3 in order with online/offline dots', () => {
    render(<RunnerFooter runners={runners} now={NOW} />);
    const list = screen.getByRole('list', { name: 'Машины' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map(i => i.textContent)).toEqual(['X1', 'HP · не в сети', 'ВМ .3 · не в сети']);
    expect(items[1]).toHaveClass('off');
    expect(items[0]!.querySelector('.dot')).toHaveClass('ok');
    expect(items[1]!.querySelector('.dot')).toHaveClass('bad');
    expect(items[2]!.querySelector('.dot')).toHaveClass('bad');
  });

  it('hover shows the OS, and for an offline machine the last connection time', () => {
    render(<RunnerFooter runners={runners} now={NOW} />);
    expect(screen.getByText('X1')).toHaveAttribute('title', 'Windows 11 Pro · агент 0.1.0');
    expect(screen.getByText('HP')).toHaveAttribute('title', 'Windows 11 Pro · агент 0.1.0 · не в сети с 06:41');
    expect(screen.getByText('ВМ .3')).toHaveAttribute('title', 'Ubuntu 24.04.1 LTS · агент 0.1.0 · не в сети с 24.10 23:05');
  });

  it('exposes the status to screen readers and keyboard focus', () => {
    render(<RunnerFooter runners={runners} now={NOW} />);
    const hp = screen.getByRole('listitem', { name: /^HP: не в сети/ });
    expect(hp).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('listitem', { name: /^X1: в сети/ })).toBeInTheDocument();
  });

  it('marks an incompatible agent («несовместимая версия агента»)', () => {
    const r: RunnerView = { ...base, id: 'hp', name: 'HP', online: false, incompatible: true, protocolVersion: '2.0' };
    render(<RunnerFooter runners={[r]} now={NOW} />);
    const item = screen.getByText('HP');
    expect(item.querySelector('.dot')).toHaveClass('warn');
    expect(item).toHaveAttribute('title', 'Windows 11 Pro · агент 0.1.0 · несовместимая версия агента · не в сети с 06:41');
    expect(screen.getByRole('listitem', { name: /^HP: несовместимая версия агента/ })).toBeInTheDocument();
  });

  it('a machine that never connected says so', () => {
    expect(runnerTooltip({ ...base, online: false, lastSeenAt: null, os: null, agentVersion: null }, NOW)).toBe('ОС неизвестна · ещё не подключалась');
  });
});

// change client-versions: spec «Версии агентов в подвале машин», design D8
describe('RunnerFooter — agent versions', () => {
  const hp: RunnerView = { ...base, id: 'hp', name: 'HP', agentVersion: '0.1.2', outdated: true };

  it('«Устаревший агент»: HP online with 0.1.2 while the hub hands out 0.2.0 — «· агент устарел», the hint has «агент 0.1.2»', () => {
    render(<RunnerFooter runners={[hp]} now={NOW} />);
    const item = screen.getByRole('listitem', { name: /^HP: в сети, агент устарел\. Windows 11 Pro · агент 0\.1\.2$/ });
    expect(item).toHaveTextContent('HP · агент устарел');
    expect(item).toHaveAttribute('title', 'Windows 11 Pro · агент 0.1.2');
    expect(item.querySelector('.ag-note')).not.toHaveClass('upd');
  });

  it('«Идёт обновление»: «· обновляется» instead of «· агент устарел»', () => {
    render(<RunnerFooter runners={[{ ...hp, update: { version: '0.2.0', status: 'installing', error: null, at: '' } }]} now={NOW} />);
    const item = screen.getByRole('listitem', { name: /^HP: в сети, обновляется\./ });
    expect(item).toHaveTextContent('HP · обновляется');
    expect(item).not.toHaveTextContent('агент устарел');
    expect(item.querySelector('.ag-note')).toHaveClass('upd');
  });

  it('a failed update leaves the agent outdated: «· агент устарел»', () => {
    render(<RunnerFooter runners={[{ ...hp, update: { version: '0.2.0', status: 'failed', error: 'sha_mismatch', at: '' } }]} now={NOW} />);
    expect(screen.getByRole('listitem', { name: /^HP: в сети, агент устарел/ })).toHaveTextContent('HP · агент устарел');
  });

  it('«Актуальный агент»: no mark, the hint has the version; an offline or unknown agent gets no mark', () => {
    render(
      <RunnerFooter
        runners={[
          { ...base, agentVersion: '0.2.0', outdated: false },
          { ...hp, id: 'off', name: 'Офлайн', online: false },
        ]}
        now={NOW}
      />,
    );
    expect(screen.getByText('X1')).toHaveTextContent(/^X1$/);
    expect(screen.getByText('X1')).toHaveAttribute('title', 'Windows 11 Pro · агент 0.2.0');
    expect(screen.getByText('Офлайн')).toHaveTextContent('Офлайн · не в сети');
    expect(agentMark({ ...hp, online: false })).toBeNull();
    expect(agentMark({ ...base, agentVersion: null, outdated: undefined })).toBeNull();
  });
});
