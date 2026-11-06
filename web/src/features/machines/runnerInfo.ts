/**
 * Machine facts for the UI: last-seen time, status text, agent mark and the hint.
 * Requirement: Реестр раннеров; Версионированный протокол; change client-versions (design D8): the agent version in
 * the hint, «агент устарел» / «обновляется» marks for an online machine.
 */
import type { RunnerView } from '../../api/types';
import { fmt, t } from '../../i18n';

/** "06:41" for today, "24.10 06:41" for earlier days, in the browser time zone. */
export function formatLastSeen(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const time = fmt.time(d);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  return `${fmt.dayMonth(d)} ${time}`;
}

export function runnerStatusText(r: RunnerView): string {
  if (r.incompatible && !r.online) return t('machines.status.incompatible');
  return r.online ? t('machines.status.online') : t('machines.status.offline');
}

/** The mark next to an online machine's name: the agent is outdated, or its update is running; null — none. */
export function agentMark(r: RunnerView): 'outdated' | 'updating' | null {
  if (!r.online) return null;
  if (r.update && r.update.status !== 'failed') return 'updating';
  return r.outdated ? 'outdated' : null;
}

export const markText = (mark: 'outdated' | 'updating'): string => (mark === 'updating' ? t('machines.mark.updating') : t('machines.mark.outdated'));

export function runnerTooltip(r: RunnerView, now: Date = new Date()): string {
  const parts = [r.os ?? t('machines.tip.osUnknown')];
  if (r.agentVersion) parts.push(t('machines.tip.agent', { version: r.agentVersion }));
  if (!r.online) {
    if (r.incompatible) parts.push(t('machines.status.incompatible'));
    const seen = formatLastSeen(r.lastSeenAt, now);
    parts.push(seen ? t('machines.tip.offlineSince', { since: seen }) : t('machines.tip.neverConnected'));
  }
  return parts.join(' · ');
}
