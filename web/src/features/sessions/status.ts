/**
 * Session status helpers shared by the left panel, tabs and chat (docs/prototype.html: LABEL, stOf, needsMe, isNow,
 * agoLabel). Requirements: Статусы сессии; Раздел «Сейчас»; Дерево «Проекты».
 */
import { waitsForUser } from '@agent-hub/shared';
import type { ColorKey, DisplayStatus, RunnerView, SessionSource, SessionView } from '../../api/types';
import { fmt, t } from '../../i18n';

/**
 * The records are getters: the label is translated at the moment of reading (render), so a language change redraws
 * the interface and consumers that index them (`SOURCE_LABEL[s.source]`) keep working.
 */
export const STATUS_LABEL = {
  get working() {
    return t('sessions.status.working');
  },
  get waiting() {
    return t('sessions.status.waiting');
  },
  get permission() {
    return t('sessions.status.permission');
  },
  get sleeping() {
    return t('sessions.status.sleeping');
  },
  get closed() {
    return t('sessions.status.closed');
  },
  get offline() {
    return t('sessions.status.offline');
  },
  // change `subagents` S10.1: the generic label; the exact one («работает в терминале») is externalText(s)
  get external() {
    return t('sessions.status.external');
  },
} as Record<DisplayStatus, string>;

export const SOURCE_LABEL = {
  get hub() {
    return t('sessions.source.hub');
  },
  get terminal() {
    return t('sessions.source.terminal');
  },
  get orca() {
    return t('sessions.source.orca');
  },
  get desktop() {
    return t('sessions.source.desktop');
  },
  get sdk() {
    return t('sessions.source.sdk');
  },
  get cron() {
    return t('sessions.source.cron');
  },
  get drive_import() {
    return t('sessions.source.drive_import');
  },
} as Record<SessionSource, string>;

const whereLabel = (source: SessionSource): string => t(`sessions.where.${source}`);

/**
 * «работает в терминале» etc. while the transcript grows without a hub process (`externalActive`, M4a backend
 * contract: the last 3 minutes); null otherwise. Shown instead of «Завершённая сессия».
 */
export function externalText(s: SessionView): string | null {
  return s.externalActive ? t('sessions.status.externalWhere', { where: whereLabel(s.originSource ?? s.source) }) : null;
}

export type RunnerIndex = Record<string, RunnerView | undefined>;

export function runnerIndex(runners: RunnerView[]): RunnerIndex {
  return Object.fromEntries(runners.map(r => [r.id, r]));
}

/**
 * `offline` — the runner is not online (D8), whatever the session's own status: a closed or sleeping session of an
 * offline machine cannot be resumed either (the hub answers 409 runner_offline), so the chat says «<машина> не в сети»
 * and the composer is «Недоступно» (spec sessions «Офлайн-машина»; QA M3c: 728 imported sessions of X1).
 */
export function displayStatus(s: SessionView, runners: RunnerIndex): DisplayStatus {
  // change `subagents` S10.1: written outside the hub right now, while the hub's own status says closed or sleeping
  if (s.externalActive && (s.status === 'closed' || s.status === 'sleeping' || s.readOnlyReason)) return 'external';
  const r = runners[s.runnerId];
  if (!r || !r.online) return 'offline';
  return childrenWorking(s) ? 'working' : s.status;
}

/**
 * Subagents (state `running`, idle teammates not counted) and background commands working while the session itself
 * waits for the user: the session is shown as «работает», with the animation. A permission request still wins: it
 * needs the user. The hub counts them in `subagents.working` and sends session.upsert when one starts or ends.
 */
export function childrenWorking(s: SessionView): number {
  if (s.status !== 'waiting') return 0;
  return s.subagents?.working ?? 0;
}

/**
 * The status in words for the header, the tab, the tree row and its tooltip: «работает в терминале» for `external`
 * (S10.1); «ждёт ответа на вопрос» / «ждёт утверждения плана» for a question or a plan (S10.3); otherwise the label.
 */
export function statusText(s: SessionView, st: DisplayStatus): string {
  if (st === 'external') return externalText(s) ?? STATUS_LABEL.external;
  if (st === 'working' && childrenWorking(s) > 0) return t('sessions.status.background');
  if (st === 'permission') {
    const tool = s.pendingPermission?.toolName;
    if (tool === 'AskUserQuestion') return t('sessions.status.question');
    if (tool === 'ExitPlanMode') return t('sessions.status.plan');
  }
  return STATUS_LABEL[st];
}

/**
 * Waits for the user: permission or an unread answer, machine online — `waitsForUser` of `@agent-hub/shared`, the rule
 * of the desktop tray counter. An unread answer still waits while subagents work (shown as working); a session written
 * outside the hub (`external`) does not.
 */
export function needsMe(s: SessionView, runners: RunnerIndex): boolean {
  if (displayStatus(s, runners) === 'external') return false;
  return waitsForUser(s, runners[s.runnerId]?.online === true);
}

export function isNow(s: SessionView, runners: RunnerIndex): boolean {
  const st = displayStatus(s, runners);
  return needsMe(s, runners) || st === 'working' || st === 'external';
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : 0);

/**
 * «Сейчас»: waiting for the user first, then working; inside — the freshest first. Cron hidden unless shown. Sessions
 * a hub session started (hub-subagents D10) are not listed — the hub does not send them in /api/sidebar, but the
 * socket does — except one that asks for a permission.
 */
export function nowList(sessions: SessionView[], runners: RunnerIndex, showCron = false): SessionView[] {
  return sessions
    .filter(s => (showCron || !s.isCron) && isNow(s, runners) && (!s.spawnedBy || displayStatus(s, runners) === 'permission'))
    .sort((a, b) => Number(needsMe(b, runners)) - Number(needsMe(a, runners)) || time(b.lastEventAt ?? b.createdAt) - time(a.lastEventAt ?? a.createdAt));
}

/** Glyph shown in a tab only when an action is needed or a turn is running. */
export function tabNeedsGlyph(s: SessionView, runners: RunnerIndex): boolean {
  const st = displayStatus(s, runners);
  return st === 'permission' || st === 'working' || st === 'external' || (st === 'waiting' && s.unread);
}

/** «сейчас», «12 мин», «3 ч», «вчера», «5 дн». */
export function agoLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return t('sessions.ago.now');
  if (m < 60) return t('sessions.ago.minutes', { n: m });
  if (m < 1440) return t('sessions.ago.hours', { n: Math.round(m / 60) });
  if (m < 2880) return t('sessions.ago.yesterday');
  return t('sessions.ago.days', { n: Math.round(m / 1440) });
}

/** «06:41» today, «24.10 06:41» earlier. */
export function clockLabel(iso: string | null, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const time = fmt.time(d);
  const same = d.toDateString() === now.toDateString();
  return same ? time : `${fmt.dayMonth(d)} ${time}`;
}

/** Minutes until the hub puts the session to sleep, null when it does not count down. */
export function sleepsInMin(s: SessionView, now = Date.now()): number | null {
  if (s.status !== 'waiting' || !s.sleepsAt || childrenWorking(s) > 0) return null;
  const left = Math.max(0, Math.ceil((Date.parse(s.sleepsAt) - now) / 60_000));
  // Rounding up and a client clock behind the hub's gave «31 мин» for a 30-minute timeout right after a turn (QA):
  // the countdown never exceeds the timeout the hub applies.
  const cap = s.effectiveIdleTimeoutMin;
  return cap > 0 ? Math.min(left, cap) : left;
}

export const colorVar = (key: ColorKey | undefined) => `var(--g-${key ?? 'none'})`;

export function readOnlyText(s: SessionView): string | null {
  switch (s.readOnlyReason) {
    case 'cwd_missing':
      return t('sessions.readOnly.cwdMissing');
    case 'cron':
      return t('sessions.readOnly.cron');
    case 'unknown_runner':
      return t('sessions.readOnly.unknownRunner');
    default:
      return s.isCron ? t('sessions.readOnly.cron') : null;
  }
}

/** Input, mode and model are unavailable. */
export function isReadOnly(s: SessionView, runners: RunnerIndex): boolean {
  return displayStatus(s, runners) === 'offline' || readOnlyText(s) !== null;
}
