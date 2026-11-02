/**
 * Machines footer of the left panel.
 * Requirement: Реестр раннеров — scenario «Три машины в подвале панели»:
 * online/offline dot, hover shows the OS and, for an offline machine, the time of the last connection.
 * Requirement: Версионированный протокол — an incompatible agent is shown as such.
 * Change client-versions (spec «Версии агентов в подвале машин», design D8): the agent version in the hint and the
 * aria-label; «· агент устарел» for an online machine with an outdated agent and no update running (none or failed),
 * «· обновляется» while one runs.
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

const MARK_TEXT = { outdated: 'агент устарел', updating: 'обновляется' } as const;

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

export function RunnerFooter({ runners, now }: { runners: RunnerView[]; now?: Date }) {
  return (
    <ul className="side-foot" aria-label="Машины">
      {runners.map(r => {
        const dot = r.online ? 'ok' : r.incompatible ? 'warn' : 'bad';
        const tip = runnerTooltip(r, now);
        const mark = agentMark(r);
        return (
          <li
            key={r.id}
            className={`m${!r.online ? ' off' : ''}${!r.online && r.incompatible ? ' incompatible' : ''}`}
            title={tip}
            tabIndex={0}
            aria-label={`${r.name}: ${runnerStatusText(r)}${mark ? `, ${MARK_TEXT[mark]}` : ''}. ${tip}`}
          >
            <span className={`dot ${dot}`} aria-hidden="true" />
            {r.name}
            {/* UI review L5: an offline machine says so in words, its name is dimmed */}
            {!r.online && <span className="off-note"> · {runnerStatusText(r)}</span>}
            {mark && <span className={`ag-note${mark === 'updating' ? ' upd' : ''}`}> · {MARK_TEXT[mark]}</span>}
          </li>
        );
      })}
    </ul>
  );
}
