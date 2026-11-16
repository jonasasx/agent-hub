/**
 * Quick search Ctrl+K (docs/prototype.html overlays() qs).
 * Requirement (workspace-ui): Быстрый поиск Ctrl+K — the whole history by title, project and the text of the
 * replies, up to 12 rows, recent sessions on an empty query, a fragment with the match for a text hit, arrows select,
 * Enter opens in the active pane, Esc closes; cron sessions only with «показать cron».
 * API: GET /api/search?q=&limit=12&cron= (D10). While the hub answers, and if it fails, the sessions this window
 * already knows are filtered by title and project, with a note that the text is not searched.
 * profile-menu-grouping: a query starting with «>» lists local commands (`commands.ts`) and does not ask the hub.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useDialog, useNow } from '../ui/a11y';
import type { SessionView } from '../../api/types';
import { api } from '../../api/client';
import { useStore } from '../../store';
import { Glyph } from '../sessions/Glyph';
import { agoLabel, colorVar, displayStatus, runnerIndex, sleepNowState } from '../sessions/status';
import { openSession, sleepSession } from '../workspace/actions';
import { activeSession } from '../layout/layout';
import { openSettings } from '../settings/Settings';
import { openHiddenProjects } from '../projects/hiddenGroups';
import { useDock } from '../toolwindows/useDock';
import { toggleTheme } from '../theme/theme';
import { buildCommands, filterCommands, isCommandQuery, type Command, type CommandKind } from './commands';
import { hitsOf, snippetParts, type SearchHit } from './snippet';
import { hubText, useT } from '../../i18n';

export const SEARCH_LIMIT = 12;
const DEBOUNCE_MS = 150;

/** Local filter over the known sessions: the fallback while the hub answers or when it does not. */
export function searchSessions(all: SessionView[], q: string, showCron: boolean, limit = SEARCH_LIMIT): SessionView[] {
  const needle = q.trim().toLowerCase();
  return all
    .filter(s => (showCron || !s.isCron) && (!needle || s.title.toLowerCase().includes(needle) || hubText(s.project.title, s.project.i18n).toLowerCase().includes(needle)))
    .sort((a, b) => Date.parse(b.lastEventAt ?? b.createdAt) - Date.parse(a.lastEventAt ?? a.createdAt))
    .slice(0, limit);
}

type State = { kind: 'loading' } | { kind: 'ok'; hits: SearchHit[] } | { kind: 'error' };

const KIND_LABEL = { page: 'workspace.search.kindPage', param: 'workspace.search.kindParam', action: 'workspace.search.kindAction' } as const satisfies Record<CommandKind, string>;

function Fragment({ hit }: { hit: SearchHit }) {
  const parts = snippetParts(hit.snippet);
  if (!parts.length) return null;
  return <span className="qs-snippet">{parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</span>;
}

export function QuickSearch({ onClose }: { onClose: () => void }) {
  const t = useT();
  const sessions = useStore(s => s.sessions);
  const showCron = useStore(s => s.showCron);
  const runners = useStore(s => s.runners);
  const idx = runnerIndex(runners);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [state, setState] = useState<State>({ kind: 'loading' });
  // «Сбросить раскладку» runs on the second Enter or click; any change of the query disarms it
  const [armed, setArmed] = useState<string | null>(null);
  const cmdMode = isCommandQuery(q);
  const isAdmin = useStore(s => s.auth.kind === 'signed_in' && s.auth.me.user.role === 'admin');
  const hasSubs = useStore(s => s.subs !== null);
  const hasDesktop = useStore(s => !!s.desktopInfo?.available);
  const sleepSid = useStore(s => {
    const sid = activeSession(s.ws);
    const view = sid ? s.sessions[sid] : undefined;
    return view && view.isHubManaged && sleepNowState(view, runnerIndex(s.runners)) === 'ready' ? view.id : null;
  });
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose); // UI review H3
  const now = useNow(60_000); // M1

  useEffect(() => {
    if (cmdMode) return;
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
  }, [q, showCron, cmdMode]);

  const commands = useMemo(
    () => (cmdMode ? filterCommands(buildCommands({ isAdmin, hasSubs, hasDesktop, canSleep: sleepSid !== null }), q) : []),
    [cmdMode, q, isAdmin, hasSubs, hasDesktop, sleepSid],
  );
  const run = (c: Command) => {
    if (c.target.type === 'page') {
      onClose();
      openSettings(c.target.page);
      return;
    }
    const action = c.target.action;
    if (action === 'reset' && armed !== c.id) {
      setArmed(c.id);
      return;
    }
    onClose();
    if (action === 'sleep' && sleepSid) void sleepSession(sleepSid);
    else if (action === 'hidden') openHiddenProjects();
    else if (action === 'reset') useDock.getState().reset();
    else if (action === 'theme') toggleTheme();
  };

  const local = useMemo(() => searchSessions(Object.values(sessions), q, showCron).map((s): SearchHit => ({ session: s, snippet: null })), [sessions, q, showCron]);
  const hits = cmdMode ? [] : state.kind === 'ok' ? state.hits : local;
  const count = cmdMode ? commands.length : hits.length;
  const cur = Math.min(sel, count - 1);
  const activeId = cmdMode ? (commands[cur] ? `qs-${commands[cur].id.replace(':', '-')}` : undefined) : hits[cur] ? `qs-${hits[cur].session.id}` : undefined;
  const open = (hit: SearchHit) => {
    // a session from the history may be unknown to this window yet
    if (!useStore.getState().sessions[hit.session.id]) useStore.getState().upsertSessions([hit.session]);
    onClose();
    void openSession(hit.session.id);
  };
  const status = cmdMode ? null : state.kind === 'error' ? t('workspace.search.unavailable') : state.kind === 'loading' && q.trim() ? t('workspace.search.loading') : null;

  return createPortal(
    <div className="scrim top" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="qs" role="dialog" aria-modal="true" aria-label={t('workspace.search.dialog')} ref={dialog}>
        <span className="qs-field">
          <input
            autoFocus
            placeholder={t('workspace.search.placeholder')}
            aria-label={t('workspace.search.field')}
            value={q}
            role="combobox"
            aria-expanded
            aria-controls="qs-list"
            aria-activedescendant={activeId}
            aria-busy={!cmdMode && state.kind === 'loading'}
            autoComplete="off"
            onChange={e => {
              setQ(e.target.value);
              setSel(0);
              setArmed(null);
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel(Math.min(count - 1, cur + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel(Math.max(0, cur - 1));
              } else if (e.key === 'Enter' && cmdMode && commands[cur]) {
                e.preventDefault();
                run(commands[cur]);
              } else if (e.key === 'Enter' && hits[cur]) {
                e.preventDefault();
                open(hits[cur]);
              }
            }}
          />
          {!cmdMode && state.kind === 'loading' && q.trim() && <span className="spinner" aria-hidden="true" />}
        </span>
        {status && (
          <div className={`qs-status${state.kind === 'error' ? ' err' : ''}`} role="status">
            {status}
          </div>
        )}
        <div className="qs-list" id="qs-list" role="listbox" aria-label={t('workspace.search.results')}>
          {cmdMode ? (
            commands.length ? (
              commands.map((c, i) => (
                <button
                  key={c.id}
                  id={`qs-${c.id.replace(':', '-')}`}
                  type="button"
                  role="option"
                  aria-selected={i === cur}
                  className={`srow qs-row qs-cmd${i === cur ? ' sel' : ''}${armed === c.id ? ' armed' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  <span className="qs-cmd-l">
                    {armed === c.id ? t('workspace.search.cmd.resetArm') : c.label}
                    {c.page && <span className="now-sub proj">{c.page}</span>}
                  </span>
                  <span className={`qs-kind k-${c.kind}`}>{t(KIND_LABEL[c.kind])}</span>
                </button>
              ))
            ) : (
              <div className="hint" style={{ padding: 10 }}>
                {t('workspace.search.nothing')}
              </div>
            )
          ) : hits.length ? (
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
                      <span className="now-sub proj">{hubText(s.project.title, s.project.i18n)}</span>
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
              {state.kind === 'loading' ? t('workspace.search.loading') : q.trim() ? t('workspace.search.nothing') : t('workspace.sidebar.noSessions')}
            </div>
          )}
        </div>
        <div className="qs-foot">
          <span>{t('workspace.search.footSelect')}</span>
          <span>{t('workspace.search.footOpen')}</span>
          <span>{t('workspace.search.footClose')}</span>
          <span>{showCron ? t('workspace.search.cronShown') : t('workspace.search.cronHidden')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
