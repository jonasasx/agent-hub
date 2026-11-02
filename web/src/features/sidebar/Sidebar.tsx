/**
 * Left panel (docs/prototype.html, sidebar()/srow()).
 * Requirements (workspace-ui): Раздел «Сейчас»; Дерево «Проекты»; Быстрый поиск Ctrl+K (button); Темы.
 * Requirement (runners): Реестр раннеров — machines footer.
 * API: GET /api/sidebar, GET /api/projects/:id/sessions (D10).
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useMenu, useNow } from '../ui/a11y';
import { PROVIDER_LABELS, type SessionView } from '../../api/types';
import { ProviderIcon } from '../chat/ProviderIcon';

/** Short vendor mark next to a session name; one per provider, Claude included. */
import { projectKey, usableRunner, useStore, type SettingsTab } from '../../store';
import { openSettings } from '../settings/Settings';
import { RunnerFooter } from '../machines/RunnerFooter';
import { SubscriptionLimits } from '../limits/SubscriptionLimits';
import { applyTheme, currentTheme } from '../theme/theme';
import { Glyph } from '../sessions/Glyph';
import { McpTreeMark } from '../mcp/McpViews';
import { agoLabel, colorVar, displayStatus, nowList, runnerIndex, SOURCE_LABEL, statusText, type RunnerIndex } from '../sessions/status';
import { leaves, shownIn } from '../layout/layout';
import { sortProjects, type ProjectInfo } from '../projects/projects';
import { collapseMore, loadMore, openSession, toggleCron, toggleProject } from '../workspace/actions';
import { requestUpdate, useUpdate } from '../update/check';
import { formatBuild } from '../update/buildInfo';
import { desktopVersion } from '../update/desktopVersion';

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

/**
 * Versions at the bottom of the profile menu (change client-versions, spec «Версии в меню профиля»): the client, the hub
 * («—» until it answers) and, in the desktop app, the app's version from the user-agent.
 */
function Versions() {
  const client = useUpdate(s => s.client);
  const hub = useUpdate(s => s.hub);
  const app = desktopVersion();
  return (
    <dl className="m-ver" aria-label="Версии">
      <dt>Клиент</dt>
      <dd>{formatBuild(client)}</dd>
      <dt>Хаб</dt>
      <dd>{hub ? formatBuild(hub) : '—'}</dd>
      {app && (
        <>
          <dt>Приложение</dt>
          <dd>{app}</dd>
        </>
      )}
    </dl>
  );
}

/** «⋯» of the panel header: sign-out lives here, not next to the theme switch (UI review L7). */
function ProfileMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenu(open, box, () => setOpen(false));
  const email = useStore(s => (s.auth.kind === 'signed_in' ? s.auth.me.user.email : ''));
  // change `multi-user`: «Пользователи» only for role admin
  const isAdmin = useStore(s => s.auth.kind === 'signed_in' && s.auth.me.user.role === 'admin');
  // claude-subscriptions P12: «Подписки» and «Расход» for every user, while the hub has the subscriptions API
  const hasSubs = useStore(s => s.subs !== null);
  // shown while the builds differ, whatever «Позже» said (design D5)
  const updatable = useUpdate(s => s.available && s.hub !== null);
  const go = (tab: SettingsTab) => {
    setOpen(false);
    openSettings(tab);
  };
  return (
    <div ref={box} className="pm">
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label="Профиль" title="Профиль" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {/* phone: a bottom sheet over a scrim that stays under the toast stack (the banner keeps working) */}
      {open && <div className="pm-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className="menu" role="menu" aria-label="Профиль">
          {email && <div className="m-title">{email}</div>}
          {updatable && (
            <button
              type="button"
              role="menuitem"
              className="m-upd"
              onClick={() => {
                if (requestUpdate()) setOpen(false);
              }}
            >
              <span className="u-dot" aria-hidden="true" />
              Обновить до новой версии
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => go('machines')}>
            Машины
          </button>
          {hasSubs && (
            <>
              <button type="button" role="menuitem" onClick={() => go('subscriptions')}>
                Подписки
              </button>
              <button type="button" role="menuitem" onClick={() => go('usage')}>
                Расход
              </button>
            </>
          )}
          {isAdmin && (
            <button type="button" role="menuitem" onClick={() => go('users')}>
              Пользователи
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => go('security')}>
            Безопасность
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            Выйти
          </button>
          <div className="m-sep" role="separator" />
          <Versions />
        </div>
      )}
    </div>
  );
}

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const runners = useStore(s => s.runners);
  const sessions = useStore(s => s.sessions);
  const projects = useStore(s => s.projects);
  const more = useStore(s => s.moreSessions);
  const moreLoading = useStore(s => s.moreLoading);
  const openState = useStore(s => s.openProjects);
  const showCron = useStore(s => s.showCron);
  const ws = useStore(s => s.ws);
  const [theme, setTheme] = useState(currentTheme);
  const now = useNow(60_000);
  const idx = runnerIndex(runners);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  const nowRows = nowList(Object.values(sessions), idx, showCron);
  // by last activity, «Без проекта» always last (the hub sorts too; local moves keep the order, D9)
  const sorted = sortProjects(projects);
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
    <aside className="side" aria-label="Сессии и проекты">
      <div className="side-top">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ah
          </div>
          Agent Hub
        </div>
        <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} title="Сменить тему">
          ◐
        </button>
        <ProfileMenu onLogout={onLogout} />
      </div>
      <div className="side-actions">
        <button type="button" className="search" onClick={() => useStore.setState({ modal: { type: 'search' } })}>
          <span aria-hidden="true">⌕</span>Найти сессию<kbd>Ctrl K</kbd>
        </button>
        <button type="button" className="btn primary" title="Новая сессия" aria-label="Новая сессия" onClick={() => useStore.setState({ modal: { type: 'new' } })}>
          ＋
        </button>
      </div>
      <div className="side-scroll" ref={scroller}>
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
        <h2 className="sec-h">
          Проекты
          <span className="sp" />
          <button type="button" onClick={() => void toggleCron()} aria-pressed={showCron}>
            {showCron ? 'скрыть cron' : 'показать cron'}
          </button>
        </h2>
        {!sorted.length && <p className="hint">Сессий пока нет</p>}
        {sorted.map(p => {
          const key = projectKey(p.project.id);
          const extra = more[key];
          const list = [...p.sessions, ...(extra ?? []).filter(x => !p.sessions.some(y => y.id === x.id))].map(x => sessions[x.id] ?? x);
          const hasShown = list.some(x => shownIn(ws, x.id));
          const open = openState[key] ?? (hasShown || shownProjects.has(key) || sorted.length === 1);
          const archived = !!(p.project as ProjectInfo).archived;
          const hidden = p.total - list.length;
          return (
            <div key={key}>
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
                <span className="pdot" />
                <span className="pname">{p.project.title}</span>
                {p.live > 0 && p.live !== p.total && (
                  <span className="badge live" title="активных" aria-label={`активных: ${p.live}`}>
                    {p.live}
                  </span>
                )}
                <span className={`badge${p.live > 0 && p.live === p.total ? ' live' : ''}`} title={p.live === p.total ? 'всего, все активны' : 'всего'} aria-label={`всего ${p.total}`}>
                  {p.total}
                </span>
              </button>
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
      <SubscriptionLimits />
      <div className="side-bottom">
        <RunnerFooter runners={runners.filter(usableRunner)} />
      </div>
    </aside>
  );
}
