/**
 * The list of sessions: «Сейчас» and the tree «Проекты» (docs/prototype.html, sidebar()/srow()). The body of the
 * «Сессии» tool window on the desktop and of the home screen on the phone.
 * Requirements (workspace-ui): Раздел «Сейчас»; Дерево «Проекты». Requirement (tool-windows-file-explorer): the filter by machine.
 */
import { useLayoutEffect, useRef, type CSSProperties, type DragEvent } from 'react';
import { useNow } from '../ui/a11y';
import { PROVIDER_LABELS, type SessionView } from '../../api/types';
import { ProviderIcon } from '../chat/ProviderIcon';
import { projectKey, useStore } from '../../store';
import { Glyph } from '../sessions/Glyph';
import { McpTreeMark } from '../mcp/McpViews';
import { agoLabel, colorVar, displayStatus, nowList, runnerIndex, SOURCE_LABEL, statusText, type RunnerIndex } from '../sessions/status';
import { leaves, shownIn } from '../layout/layout';
import { sortProjects, type ProjectInfo } from '../projects/projects';
import { collapseMore, loadMore, openSession, toggleCron, toggleProject } from '../workspace/actions';
import { ProjectActions } from '../projects/ProjectActions';
import { NewProjectButton } from '../projects/NewProject';
import { useMachineFilter } from '../machines/machineFilter';
import { PhoneFileTabs } from '../files/PhoneFileTabs';
import { usePhone } from '../toolwindows/usePhone';

const PREVIEW = 5;

function startDrag(e: DragEvent, sid: string) {
  useStore.setState({ dragSid: sid });
  e.dataTransfer.setData('text/plain', sid);
  e.dataTransfer.effectAllowed = 'move';
}
const endDrag = () => useStore.setState({ dragSid: null });

const CHEVRON = (
  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 2l3 3-3 3" />
  </svg>
);

function SessionRow({ s, runners, shown, now, showRunner }: { s: SessionView; runners: RunnerIndex; shown: boolean; now: number; showRunner: boolean }) {
  const st = displayStatus(s, runners);
  const runner = runners[s.runnerId]?.name ?? s.runnerId;
  return (
    <button
      type="button"
      className={`srow${s.status === 'closed' ? ' dim' : ''}${shown ? ' active' : ''}`}
      data-sid={s.id}
      style={{ '--gc': colorVar(s.project.colorKey) } as CSSProperties}
      title={`${s.title}\n${runner} · ${statusText(s, st)} · ${SOURCE_LABEL[s.originSource ?? s.source]}`}
      draggable
      onDragStart={e => startDrag(e, s.id)}
      onDragEnd={endDrag}
      onClick={() => void openSession(s.id)}
    >
      <span className="st">
        <Glyph status={st} unread={s.unread} label={statusText(s, st)} />
      </span>
      <span className="title">
        {s.forkOf ? '⑂ ' : ''}
        {s.spawnedBy ? '↳ ' : ''}
        {s.title}
      </span>
      <McpTreeMark s={s} />
      <span className="provider-mark" title={PROVIDER_LABELS[s.provider ?? 'claude']}>
        <ProviderIcon provider={s.provider ?? 'claude'} size={14} />
      </span>
      {s.remoteControl && (
        <span className="rc-tag" title="Remote Control" aria-label="Remote Control">
          RC
        </span>
      )}
      {showRunner && <span className="rn">{runner}</span>}
      <span className="meta">{agoLabel(s.lastEventAt ?? s.createdAt, now)}</span>
    </button>
  );
}

/** Rows of the tree while they load (first load, «ещё N»). */
export function SkeletonRows({ n = 6 }: { n?: number }) {
  return (
    <div className="sk-rows" role="status" aria-label="Загрузка списка">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${[78, 62, 86, 54, 70, 66][i % 6]}%` }} />
      ))}
    </div>
  );
}

/** The statuses the hub counts as a live session of a project (the same set as the server's `live`). */
const LIVE_STATUS = new Set<string>(['working', 'waiting', 'permission', 'sleeping']);

/** The rows of the sessions; `scroller` — the element the list scrolls in (the focus of a moved row is restored there). */
export function SessionsList() {
  const runners = useStore(s => s.runners);
  const sessions = useStore(s => s.sessions);
  const projects = useStore(s => s.projects);
  const more = useStore(s => s.moreSessions);
  const moreLoading = useStore(s => s.moreLoading);
  const openState = useStore(s => s.openProjects);
  const showCron = useStore(s => s.showCron);
  const ws = useStore(s => s.ws);
  const filter = useMachineFilter(s => s.runnerId);
  const setFilter = useMachineFilter(s => s.set);
  const now = useNow(60_000);
  const idx = runnerIndex(runners);
  const phone = usePhone();

  const byMachine = <T extends { runnerId: string }>(list: T[]): T[] => (filter ? list.filter(s => s.runnerId === filter) : list);
  const nowRows = byMachine(nowList(Object.values(sessions), idx, showCron));
  // by last activity, «Без проекта» always last (the hub sorts too; local moves keep the order, D9)
  const sorted = sortProjects(projects).filter(p => !filter || p.sessions.some(x => (sessions[x.id] ?? x).runnerId === filter));
  // projects of the sessions shown in this window's panes open by themselves (spec «Дерево „Проекты“»)
  const shownProjects = new Set(
    leaves(ws.layout)
      .map(id => ws.panes[id]?.active)
      .flatMap(sid => (sid && sessions[sid] ? [projectKey(sessions[sid].project.id)] : [])),
  );
  // a focused row that moved to another project keeps the focus in its new place, without scrolling (4.8)
  const refocus = useStore(s => s.refocusSid);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!refocus) return;
    useStore.setState({ refocusSid: null });
    scroller.current?.querySelector<HTMLElement>(`.pchildren [data-sid="${refocus}"]`)?.focus({ preventScroll: true });
  }, [refocus, projects]);

  return (
    <div className="side-scroll" ref={scroller}>
      {filter && (
        <div className="tw-fchips">
          <span className="tw-fchip on">
            Машина: {idx[filter]?.name ?? filter}
            <button type="button" aria-label="Сбросить фильтр по машине" title="Сбросить фильтр по машине" onClick={() => setFilter(null)}>
              ×
            </button>
          </span>
        </div>
      )}
      {phone && <PhoneFileTabs />}
      <h2 className="sec-h">
        Сейчас <span className="n">{nowRows.length}</span>
      </h2>
      {nowRows.length ? (
        nowRows.map(s => {
          const st = displayStatus(s, idx);
          return (
            <button
              key={s.id}
              type="button"
              className={`srow${shownIn(ws, s.id) ? ' active' : ''}`}
              style={{ '--gc': colorVar(s.project.colorKey) } as CSSProperties}
              draggable
              onDragStart={e => startDrag(e, s.id)}
              onDragEnd={endDrag}
              onClick={() => void openSession(s.id)}
            >
              <span className="st">
                <Glyph status={st} unread={s.unread} label={statusText(s, st)} />
              </span>
              <span className="title">
                {s.title}
                <span className="now-sub">
                  {s.project.title} · {idx[s.runnerId]?.name ?? s.runnerId} · {statusText(s, st)}
                </span>
              </span>
            </button>
          );
        })
      ) : (
        <p className="hint">Ничего не ждёт ответа</p>
      )}
      <h2 className="sec-h" id="sidebar-projects-heading" tabIndex={-1}>
        Проекты
        <span className="sp" />
        <NewProjectButton />
        <button type="button" onClick={() => void toggleCron()} aria-pressed={showCron}>
          {showCron ? 'скрыть cron' : 'показать cron'}
        </button>
      </h2>
      {!sorted.length && <p className="hint">Сессий пока нет</p>}
      {sorted.map(p => {
        const key = projectKey(p.project.id);
        const extra = more[key];
        const all = [...p.sessions, ...(extra ?? []).filter(x => !p.sessions.some(y => y.id === x.id))].map(x => sessions[x.id] ?? x);
        const list = byMachine(all);
        const hasShown = list.some(x => shownIn(ws, x.id));
        const open = openState[key] ?? (hasShown || shownProjects.has(key) || sorted.length === 1);
        const archived = !!(p.project as ProjectInfo).archived;
        // with a machine filter only the loaded rows of that machine are counted: the hidden rest is of unknown machines
        const hidden = filter ? 0 : p.total - list.length;
        // and so are the counters of the project: over the loaded rows of that machine (the server counts all machines)
        const total = filter ? list.length : p.total;
        const live = filter ? list.filter(x => LIVE_STATUS.has(x.status)).length : p.live;
        return (
          <div key={key}>
            <div className="project-row">
              <button
                type="button"
                className={`prow${open ? ' open' : ''}${archived ? ' archived' : ''}`}
                style={{ '--gc': colorVar(p.project.colorKey) } as CSSProperties}
                title={p.project.path ? `${p.project.path}${archived ? ' · в архиве' : ''}` : 'Проект не определён'}
                aria-expanded={open}
                onClick={() => toggleProject(key, open)}
              >
                <span className="chev" aria-hidden="true">
                  {CHEVRON}
                </span>
                <span className="pdot project-initial" aria-hidden="true">
                  {Array.from(p.project.title)[0]?.toLocaleUpperCase()}
                </span>
                <span className="pname">{p.project.title}</span>
                {live > 0 && live !== total && (
                  <span className="badge live" title="активных" aria-label={`активных: ${live}`}>
                    {live}
                    <span className="project-count-label" aria-hidden="true">
                      {' '}
                      акт.
                    </span>
                  </span>
                )}
                <span className={`badge${live > 0 && live === total ? ' live' : ''}`} title={live === total ? 'всего, все активны' : 'всего'} aria-label={`всего ${total}`}>
                  {total}
                  <span className="project-count-label" aria-hidden="true">
                    {' '}
                    всего
                  </span>
                </span>
              </button>
              {p.project.id && <ProjectActions project={p.project} total={p.total} />}
            </div>
            {open && (
              <div className="pchildren">
                {list.slice(0, extra ? list.length : PREVIEW).map(s => (
                  <SessionRow key={s.id} s={s} runners={idx} shown={shownIn(ws, s.id)} now={now} showRunner={new Set(list.map(x => x.runnerId)).size > 1} />
                ))}
                {moreLoading[key] && <SkeletonRows n={Math.min(3, hidden)} />}
                {!extra && hidden > 0 && (
                  <button type="button" className="more" disabled={moreLoading[key]} aria-busy={moreLoading[key]} onClick={() => void loadMore(p.project.id)}>
                    {moreLoading[key] && <span className="spinner" aria-hidden="true" />} ещё {hidden}
                  </button>
                )}
                {extra && (
                  <button type="button" className="more" onClick={() => collapseMore(p.project.id)}>
                    свернуть
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
