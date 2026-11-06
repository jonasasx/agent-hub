/**
 * Machine facts for the UI: last-seen time, status text, agent mark and the hint.
 * Requirement: Реестр раннеров; Версионированный протокол; change client-versions (design D8): the agent version in
 * the hint, «агент устарел» / «обновляется» marks for an online machine.
 */
import type { RunnerView } from '../../api/types';

/** "06:41" for today, "24.10 06:41" for earlier days, in the browser time zone. */
export function formatLastSeen(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return `${date} ${time}`;
}

export function runnerStatusText(r: RunnerView): string {
  if (r.incompatible && !r.online) return 'несовместимая версия агента';
  return r.online ? 'в сети' : 'не в сети';
}

/** The mark next to an online machine's name: the agent is outdated, or its update is running; null — none. */
export function agentMark(r: RunnerView): 'outdated' | 'updating' | null {
  if (!r.online) return null;
  if (r.update && r.update.status !== 'failed') return 'updating';
  return r.outdated ? 'outdated' : null;
}

export const MARK_TEXT = { outdated: 'агент устарел', updating: 'обновляется' } as const;

export function runnerTooltip(r: RunnerView, now: Date = new Date()): string {
  const parts = [r.os ?? 'ОС неизвестна'];
  if (r.agentVersion) parts.push(`агент ${r.agentVersion}`);
  if (!r.online) {
    if (r.incompatible) parts.push('несовместимая версия агента');
    const seen = formatLastSeen(r.lastSeenAt, now);
    parts.push(seen ? `не в сети с ${seen}` : 'ещё не подключалась');
  }
  return parts.join(' · ');
}
