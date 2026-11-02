/**
 * Quick search Ctrl+K (docs/prototype.html overlays() qs).
 * Requirement (workspace-ui): Быстрый поиск Ctrl+K — the whole history by title, project and the text of the
 * replies, up to 12 rows, recent sessions on an empty query, a fragment with the match for a text hit, arrows select,
 * Enter opens in the active pane, Esc closes; cron sessions only with «показать cron».
 * API: GET /api/search?q=&limit=12&cron= (D10). While the hub answers, and if it fails, the sessions this window
 * already knows are filtered by title and project, with a note that the text is not searched.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useDialog, useNow } from '../ui/a11y';
import type { SessionView } from '../../api/types';
import { api } from '../../api/client';
import { useStore } from '../../store';
import { Glyph } from '../sessions/Glyph';
import { agoLabel, colorVar, displayStatus, runnerIndex } from '../sessions/status';
import { openSession } from '../workspace/actions';
import { hitsOf, snippetParts, type SearchHit } from './snippet';

export const SEARCH_LIMIT = 12;
const DEBOUNCE_MS = 150;

/** Local filter over the known sessions: the fallback while the hub answers or when it does not. */
export function searchSessions(all: SessionView[], q: string, showCron: boolean, limit = SEARCH_LIMIT): SessionView[] {
  const needle = q.trim().toLowerCase();
  return all
    .filter(s => (showCron || !s.isCron) && (!needle || s.title.toLowerCase().includes(needle) || s.project.title.toLowerCase().includes(needle)))
    .sort((a, b) => Date.parse(b.lastEventAt ?? b.createdAt) - Date.parse(a.lastEventAt ?? a.createdAt))
    .slice(0, limit);
}

type State = { kind: 'loading' } | { kind: 'ok'; hits: SearchHit[] } | { kind: 'error' };

function Fragment({ hit }: { hit: SearchHit }) {
  const parts = snippetParts(hit.snippet);
  if (!parts.length) return null;
  return <span className="qs-snippet">{parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</span>;
}

export function QuickSearch({ onClose }: { onClose: () => void }) {
  const sessions = useStore(s => s.sessions);
  const showCron = useStore(s => s.showCron);
  const runners = useStore(s => s.runners);
  const idx = runnerIndex(runners);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose); // UI review H3
  const now = useNow(60_000); // M1

  useEffect(() => {
    const ctrl = new AbortController();
    setState(s => (s.kind === 'ok' ? s : { kind: 'loading' }));
    const t = setTimeout(
      () => {
        api
          .search(q.trim(), showCron, SEARCH_LIMIT, ctrl.signal)
          .then(body => {
            setState({ kind: 'ok', hits: hitsOf(body).slice(0, SEARCH_LIMIT) });
            setSel(0);
          })
          .catch((err: unknown) => {
            if ((err as { name?: string })?.name !== 'AbortError') setState({ kind: 'error' });
          });
      },
      q.trim() ? DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, showCron]);

  const local = useMemo(() => searchSessions(Object.values(sessions), q, showCron).map((s): SearchHit => ({ session: s, snippet: null })), [sessions, q, showCron]);
  const hits = state.kind === 'ok' ? state.hits : local;
  const cur = Math.min(sel, hits.length - 1);
  const open = (hit: SearchHit) => {
    // a session from the history may be unknown to this window yet
    if (!useStore.getState().sessions[hit.session.id]) useStore.getState().upsertSessions([hit.session]);
    onClose();
    void openSession(hit.session.id);
  };
  const status = state.kind === 'error' ? 'Поиск по истории недоступен — показаны сессии из списка слева, без текста реплик' : state.kind === 'loading' && q.trim() ? 'Поиск…' : null;

  return createPortal(
    <div className="scrim top" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="qs" role="dialog" aria-modal="true" aria-label="Быстрый переход" ref={dialog}>
        <span className="qs-field">
          <input
            autoFocus
            placeholder="Название, проект или текст реплики…"
            aria-label="Сессия или проект"
            value={q}
            role="combobox"
            aria-expanded
            aria-controls="qs-list"
            aria-activedescendant={hits[cur] ? `qs-${hits[cur].session.id}` : undefined}
            aria-busy={state.kind === 'loading'}
            autoComplete="off"
            onChange={e => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel(Math.min(hits.length - 1, cur + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel(Math.max(0, cur - 1));
              } else if (e.key === 'Enter' && hits[cur]) {
                e.preventDefault();
                open(hits[cur]);
              }
            }}
          />
          {state.kind === 'loading' && q.trim() && <span className="spinner" aria-hidden="true" />}
        </span>
        {status && (
          <div className={`qs-status${state.kind === 'error' ? ' err' : ''}`} role="status">
            {status}
          </div>
        )}
        <div className="qs-list" id="qs-list" role="listbox" aria-label="Результаты поиска">
          {hits.length ? (
            hits.map((h, i) => {
              const s = useStore.getState().sessions[h.session.id] ?? h.session;
              return (
                <button
                  key={s.id}
                  id={`qs-${s.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === cur}
                  className={`srow qs-row${s.status === 'closed' ? ' dim' : ''}${i === cur ? ' sel' : ''}`}
                  style={{ '--gc': colorVar(s.project.colorKey) } as CSSProperties}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => open(h)}
                >
                  <span className="st">
                    <Glyph status={displayStatus(s, idx)} unread={s.unread} />
                  </span>
                  <span className="title">
                    <span className="qs-line">
                      {s.title}
                      {/* UI review L6: the project after the title */}
                      <span className="now-sub proj">{s.project.title}</span>
                    </span>
                    <Fragment hit={h} />
                  </span>
                  <span className="rn">{idx[s.runnerId]?.name ?? s.runnerId}</span>
                  <span className="meta">{agoLabel(s.lastEventAt ?? s.createdAt, now)}</span>
                </button>
              );
            })
          ) : (
            <div className="hint" style={{ padding: 10 }}>
              {state.kind === 'loading' ? 'Поиск…' : q.trim() ? 'Ничего не найдено' : 'Сессий пока нет'}
            </div>
          )}
        </div>
        <div className="qs-foot">
          <span>↑↓ выбор</span>
          <span>Enter — открыть в активной панели</span>
          <span>Esc — закрыть</span>
          <span>{showCron ? 'cron показан' : 'cron скрыт — «показать cron» слева'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
