/**
 * The source chips of the «Файлы» window (change tool-windows-file-explorer, task 6.2). Markup after the prototype
 * (`filesPanel`): «Сессия · <проект>» and one chip per machine. The session chip follows the active session; an offline
 * machine is dimmed and cannot be chosen.
 * Requirement (file-explorer): Окно «Файлы» и источники.
 */
import type { CSSProperties } from 'react';
import { useT } from '../../i18n';
import { useStore, usableRunner } from '../../store';
import { colorVar } from '../sessions/status';
import { projectNameOf, type Source } from './source';
import { useFiles } from './filesStore';
import { useLastSessionId } from './useSource';

export function SourceChips({ src }: { src: Source | null }) {
  const t = useT();
  const runners = useStore(s => s.runners).filter(usableRunner);
  const sessions = useStore(s => s.sessions);
  const sid = useLastSessionId();
  const session = sid ? sessions[sid] : undefined;
  const setChoice = useFiles(s => s.setChoice);
  const outdated = useFiles(s => s.outdated);
  return (
    <div className="fx-chips" role="group" aria-label={t('files.chips.label')}>
      {session ? (
        <button
          type="button"
          className={`fx-chip${src?.mode === 'session' ? ' on' : ''}`}
          style={{ '--gc': colorVar(session.project.colorKey) } as CSSProperties}
          aria-pressed={src?.mode === 'session'}
          title={t('files.chips.sessionTitle')}
          onClick={() => setChoice({ kind: 'session' })}
        >
          <span className="gc" />
          {t('files.chips.session')} · {projectNameOf(session)}
        </button>
      ) : (
        <button type="button" className="fx-chip off" disabled aria-disabled="true" title={t('files.action.noSession')}>
          <span className="gc" />
          {t('files.chips.session')}
        </button>
      )}
      {runners.map(r => {
        const on = src?.mode === 'machine' && src.runnerId === r.id;
        const title = !r.online ? t('files.error.runner_offline') : outdated[r.id] ? t('files.error.capability_unavailable') : t('files.window.homeNamed', { machine: r.name });
        return (
          <button
            key={r.id}
            type="button"
            className={`fx-chip${on ? ' on' : ''}${r.online ? '' : ' off'}`}
            aria-pressed={on}
            aria-disabled={!r.online || undefined}
            title={title}
            onClick={() => r.online && setChoice({ kind: 'machine', runnerId: r.id })}
          >
            <span className="d" />
            {r.name}
          </button>
        );
      })}
    </div>
  );
}
