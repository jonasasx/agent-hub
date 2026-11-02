// Monitors and background commands of a session in the UI (change `background-tasks`, design D6).
// Requirement (background-tasks): Фоновые задачи в списке рядом с субагентами.
import type { BackgroundTaskStatus, BackgroundTaskView } from '../../api/types';

export const BG_STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: 'работает',
  completed: 'завершена',
  failed: 'ошибка',
  stopped: 'остановлена',
  expired: 'истекла',
  interrupted: 'прервана',
};

export const BG_KIND_LABEL: Record<BackgroundTaskView['kind'], string> = { monitor: 'монитор', bash: 'команда' };

/** The hub's status, with the timeout applied again: a monitor may expire while the list is on screen. */
export function bgStatus(v: BackgroundTaskView, now = Date.now()): BackgroundTaskStatus {
  if (v.status === 'running' && v.expiresAt && Date.parse(v.expiresAt) <= now) return 'expired';
  return v.status;
}

/** The description, or the start of the command. */
export function bgTitle(v: BackgroundTaskView): string {
  if (v.description) return v.description;
  const c = (v.command ?? '').replace(/\s+/g, ' ').trim();
  return c ? (c.length > 80 ? `${c.slice(0, 80)}…` : c) : BG_KIND_LABEL[v.kind];
}

export function bgDurationMs(v: BackgroundTaskView, st: BackgroundTaskStatus, now = Date.now()): number | null {
  const start = v.startedAt ? Date.parse(v.startedAt) : NaN;
  if (Number.isNaN(start)) return null;
  const end = st === 'running' ? now : st === 'expired' && v.expiresAt ? Date.parse(v.expiresAt) : Date.parse(v.endedAt ?? v.lastEventAt ?? '') || start;
  return Math.max(0, end - start);
}

/** «истекает через 12 мин» for a running monitor with a timeout; '' otherwise. */
export function expiresLabel(v: BackgroundTaskView, st: BackgroundTaskStatus, now = Date.now()): string {
  if (st !== 'running' || !v.expiresAt) return '';
  const m = Math.max(1, Math.ceil((Date.parse(v.expiresAt) - now) / 60_000));
  return m < 60 ? `истекает через ${m} мин` : `истекает через ${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** A call in the feed that starts a background task: Monitor, or Bash/PowerShell with run_in_background. */
export function isBackgroundCall(name: string, input: unknown): boolean {
  if (name === 'Monitor') return true;
  return (name === 'Bash' || name === 'PowerShell') && !!input && typeof input === 'object' && (input as { run_in_background?: unknown }).run_in_background === true;
}
