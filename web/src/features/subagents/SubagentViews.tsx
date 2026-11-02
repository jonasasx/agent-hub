/**
 * Subagents in the UI (change `subagents`, design S9). Requirements (subagents): Список субагентов и счётчик;
 * Переход от вызова к чату субагента; Чат субагента только для чтения; Живое обновление; Субагенты на телефоне.
 * - SubagentsButton: «Субагенты N · M работают» in the chat header (and in the phone's info line and «⋯»); opens the
 *   list — a popover on the desktop, a sheet from the bottom on the phone.
 * - SubagentLink: «Открыть чат субагента» with the status at an `Agent`/`Task` call, the addressee's chat at
 *   `SendMessage`, the sender's chat at «Сообщение от X».
 * - SubagentChat: the read-only chat of one subagent, a tab like a session's.
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { PROVIDER_LABELS, type BackgroundTaskStatus, type BackgroundTaskView, type HubSubagentView, type SessionView, type SubagentStatus, type SubagentView } from '../../api/types';
import { useStore } from '../../store';
import { clockLabel, colorVar, STATUS_LABEL } from '../sessions/status';
import { ProviderIcon } from '../chat/ProviderIcon';
import { useDialog } from '../ui/a11y';
import { ensureSession, loadSubagents, openSession, openSubagent } from '../workspace/actions';
import { SUBAGENT_STATUS_LABEL, durationLabel, forCall, forTarget, subDurationMs, subStatus, subTitle, subTree, subType } from './model';
import { BG_KIND_LABEL, BG_STATUS_LABEL, bgDurationMs, bgStatus, bgTitle, expiresLabel } from './background';

/** The session whose registry the links of a feed look in (the parent session for a subagent's own feed). */
export const SubagentScope = createContext<string | null>(null);

/**
 * Who wrote the user lines of a feed: no label in a session (Ivan: «Вы» is noise), «Лид» in a subagent's feed (its
 * task and the lead's messages), where it tells the writers apart.
 */
export const UserLabel = createContext('');

function useList(sessionId: string | null): SubagentView[] | undefined {
  const ids = useStore(st => (sessionId ? st.subagentLists[sessionId] : undefined));
  const rows = useStore(st => st.subagents);
  return useMemo(() => ids?.flatMap(id => (rows[id] ? [rows[id]!] : [])), [ids, rows]);
}

function useHubChildren(sessionId: string | null): HubSubagentView[] | undefined {
  return useStore(st => (sessionId ? st.hubLists[sessionId] : undefined));
}

function useBackground(sessionId: string | null): BackgroundTaskView[] | undefined {
  return useStore(st => (sessionId ? st.backgroundLists[sessionId] : undefined));
}

export function SubStatusDot({ status, label: text }: { status: SubagentStatus | BackgroundTaskStatus; label?: string }) {
  const label = text ?? SUBAGENT_STATUS_LABEL[status as SubagentStatus];
  if (status === 'running') return <span className="g-work" role="img" aria-label={label} title={label} />;
  return <span className={`sub-dot ${status}`} role="img" aria-label={label} title={label} />;
}

/** «Субагенты N · M работают»; no button when the session has none. */
export function SubagentsButton({ s, compact }: { s: SessionView; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const list = useList(s.id);
  const session = s;
  const bg = useBackground(s.id);
  const hubTotal = s.subagents?.hub?.total ?? 0;
  const hubWorking = s.subagents?.hub?.working ?? 0;
  const total = (list?.length ?? s.subagents?.total ?? 0) + hubTotal;
  // change `background-tasks`: monitors and background commands next to the subagents
  const bgTotal = s.subagents?.background ?? bg?.length ?? 0;
  const bgRunning = bg ? bg.filter(v => bgStatus(v) === 'running').length : 0;
  // only «работает»: a teammate waiting for messages (idle) is not counted (spec subagents, QA subagents 2)
  const running = (list ? list.filter(v => subStatus(v, session) === 'running').length : (s.subagents?.running ?? 0)) + bgRunning + hubWorking;
  // the count from the session differs from the loaded list: a row was missed (the list is loaded again)
  const stale = list !== undefined && s.subagents?.total !== undefined && s.subagents.total !== list.length;
  // a background task started, ended or expired: the hub sends session.upsert with other counts — the list follows
  const bgKey = `${s.subagents?.background ?? 0}|${s.subagents?.working ?? 0}|${hubTotal}|${hubWorking}`;
  const seenBg = useRef(bgKey);
  const loaded = list !== undefined;
  useEffect(() => {
    const changed = seenBg.current !== bgKey;
    seenBg.current = bgKey;
    if (s.subagents?.total || s.subagents?.background || hubTotal) void loadSubagents(s.id, stale || (changed && loaded));
  }, [s.id, s.subagents?.total, s.subagents?.background, hubTotal, stale, bgKey, loaded]);
  if (!total && !bgTotal) return null;
  const parts = [total ? `Субагенты ${total}` : '', bgTotal ? (total ? `фоновые ${bgTotal}` : `Фоновые ${bgTotal}`) : ''].filter(Boolean).join(' · ');
  return (
    <>
      <button type="button" className={`btn sub-btn${compact ? ' compact' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {compact ? (
          // the phone's info line: «24 · 1» fits next to the project; the full words are the accessible name
          <>
            <span className="sr-only">{parts} </span>
            <svg className="sub-ico" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="4" cy="3.5" r="1.8" />
              <circle cx="12" cy="8" r="1.8" />
              <circle cx="4" cy="12.5" r="1.8" />
              <path d="M5.8 3.5h1.7a2 2 0 0 1 2 2v.5M5.8 12.5h1.7a2 2 0 0 0 2-2V10" />
            </svg>
            {total + bgTotal}
            {running > 0 && (
              <span className="sub-running">
                {' · '}
                {running}
                <span className="sr-only"> {running === 1 ? 'работает' : 'работают'}</span>
              </span>
            )}
          </>
        ) : (
          <>
            {parts}
            {running > 0 && (
              <span className="sub-running">
                {' '}
                · {running} {running === 1 ? 'работает' : 'работают'}
              </span>
            )}
          </>
        )}
      </button>
      {open && <SubagentList s={s} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The list of a session's subagents: a tree by the parent, status, start time and duration. */
export function SubagentList({ s, onClose }: { s: SessionView; onClose: () => void }) {
  const list = useList(s.id);
  const bg = useBackground(s.id);
  const hub = useHubChildren(s.id);
  const phone = useStore(st => st.device === 'phone');
  const sessions = useStore(st => st.sessions);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [now, setNow] = useState(Date.now());
  useDialog(ref, onClose);
  useEffect(() => {
    void loadSubagents(s.id);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s.id]);
  const rows = useMemo(() => subTree(list ?? []), [list]);
  // events of a running monitor do not come over the socket: the open list asks again every 10 s
  const bgWorking = !!bg?.some(v => bgStatus(v, now) === 'running');
  useEffect(() => {
    if (!bgWorking) return;
    const t = setInterval(() => void loadSubagents(s.id, true), 10_000);
    return () => clearInterval(t);
  }, [s.id, bgWorking]);
  const title = bg?.length ? (list?.length || hub?.length ? 'Субагенты и фоновые задачи' : 'Фоновые задачи сессии') : 'Субагенты сессии';
  // one list of children: sessions started over the hub and subagents of the process. Blocks (a root and its subtree) are
  // ordered by need: a permission request, working, waiting, the rest, finished last
  const items = useMemo(() => {
    type Item = { key: string; depth: number; hub?: HubSubagentView; sub?: SubagentView };
    const blocks: { rank: number; rows: Item[] }[] = [];
    for (const h of hub ?? []) {
      const st = sessions[h.id]?.status ?? h.status;
      blocks.push({ rank: st === 'permission' ? 0 : st === 'working' ? 1 : st === 'waiting' ? 2 : 4, rows: [{ key: h.id, depth: 0, hub: h }] });
    }
    for (const { v, depth } of rows) {
      const item: Item = { key: v.id, depth, sub: v };
      if (depth === 0 || !blocks.length) {
        const st = subStatus(v, s);
        blocks.push({ rank: st === 'running' ? 1 : st === 'idle' ? 2 : st === 'failed' || st === 'interrupted' ? 3 : 4, rows: [item] });
      } else blocks[blocks.length - 1]!.rows.push(item);
    }
    return blocks.sort((a, b) => a.rank - b.rank).flatMap(b => b.rows);
  }, [hub, rows, s, sessions]);
  const empty = !!list && !list.length && !hub?.length && !bg?.length;
  return createPortal(
    <div className={`scrim${phone ? ' sheet-scrim' : ' sub-scrim'}`} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`sub-list${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sub-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </div>
        {empty && <p className="sub-empty">Дочерних сессий нет</p>}
        {!list && (
          <div className="sk-rows" role="status" aria-label="Загрузка списка">
            {[78, 62, 86].map(w => (
              <span key={w} className="skeleton" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {!!items.length && (
          <ul className="sub-rows">
            {items.map(({ key, depth, hub: h, sub: v }) => {
              if (h) {
                return (
                  <li key={key}>
                    <HubChildRow
                      h={h}
                      onOpen={() => {
                        onClose();
                        void openSession(h.id);
                      }}
                    />
                  </li>
                );
              }
              const st = subStatus(v!, s);
              return (
                <li key={key}>
                  <button
                    type="button"
                    className="sub-row"
                    style={{ '--depth': depth } as CSSProperties}
                    onClick={() => {
                      onClose();
                      openSubagent(v!);
                    }}
                  >
                    <SubStatusDot status={st} />
                    <span className="sub-main">
                      <span className="sub-title">{subTitle(v!)}</span>
                      <span className="sub-meta">
                        {subType(v!)} · {SUBAGENT_STATUS_LABEL[st]} · {clockLabel(v!.startedAt)}
                        {durationLabel(subDurationMs(v!, st, now)) && ` · ${durationLabel(subDurationMs(v!, st, now))}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!!bg?.length && (
          <section className="bg-section" aria-label="Фоновые задачи">
            {!!(list?.length || hub?.length) && <h3 className="bg-head">Фоновые задачи</h3>}
            <ul className="sub-rows bg-rows">
              {bg.map(v => (
                <li key={v.id}>
                  <BackgroundRow v={v} now={now} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A child hub session: provider mark, title, machine, status (live from the store when the session is loaded), start. */
function HubChildRow({ h, onOpen }: { h: HubSubagentView; onOpen: () => void }) {
  const live = useStore(st => st.sessions[h.id]);
  const status = live?.status ?? h.status;
  const alive = live?.processAlive ?? h.processAlive;
  const label = STATUS_LABEL[status];
  return (
    <button type="button" className="sub-row hub-row" onClick={onOpen}>
      {status === 'working' && alive ? (
        <span className="g-work" role="img" aria-label={label} title={label} />
      ) : (
        <span className={`sub-dot ${status === 'waiting' ? 'idle' : status === 'permission' ? 'interrupted' : 'stopped'}`} role="img" aria-label={label} title={label} />
      )}
      <span className="sub-main">
        <span className="sub-title">
          <ProviderIcon provider={h.provider} size={13} /> {h.title}
        </span>
        <span className="sub-meta">
          {PROVIDER_LABELS[h.provider]} · {h.machine} · {label} · {clockLabel(h.createdAt)}
        </span>
      </span>
    </button>
  );
}

/** A monitor or a background command: status, title, kind, start, duration; opened — the command and the last event. */
function BackgroundRow({ v, now }: { v: BackgroundTaskView; now: number }) {
  const st = bgStatus(v, now);
  const dur = durationLabel(bgDurationMs(v, st, now));
  const exp = expiresLabel(v, st, now);
  return (
    <details className="bg-row">
      <summary className="sub-row">
        <SubStatusDot status={st} label={BG_STATUS_LABEL[st]} />
        <span className="sub-main">
          <span className="sub-title">{bgTitle(v)}</span>
          <span className="sub-meta">
            {BG_KIND_LABEL[v.kind]} · {BG_STATUS_LABEL[st]} · {clockLabel(v.startedAt)}
            {dur && ` · ${dur}`}
            {exp && ` · ${exp}`}
          </span>
          {v.lastEvent && <span className="sub-meta bg-event mono">{v.lastEvent}</span>}
        </span>
      </summary>
      <div className="bg-body">
        {v.command && <pre className="bg-cmd mono">{v.command}</pre>}
        {v.lastEvent && (
          <div className="bg-last">
            <span className="sub-meta">Последнее событие{v.lastEventAt ? ` · ${clockLabel(v.lastEventAt)}` : ''}</span>
            <pre className="bg-cmd mono">{v.lastEvent}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

/** The status of the task a Monitor / background Bash call started, next to the call in the feed. */
export function BackgroundStatus({ toolUseId }: { toolUseId: string }) {
  const scope = useContext(SubagentScope);
  const bg = useBackground(scope);
  const total = useStore(st => (scope ? (st.sessions[scope]?.subagents?.background ?? 0) : 0));
  useEffect(() => {
    if (scope && total) void loadSubagents(scope);
  }, [scope, total]);
  const v = bg?.find(x => x.id === toolUseId);
  if (!v) return null;
  const st = bgStatus(v);
  return (
    <span className="sub-link">
      <SubStatusDot status={st} label={BG_STATUS_LABEL[st]} />
      <span className="sub-link-st">
        {BG_KIND_LABEL[v.kind]} {BG_STATUS_LABEL[st]}
      </span>
    </span>
  );
}

/** «Открыть чат субагента» at a call (by tool_use id) or a chat link by the addressee / sender name. */
export function SubagentLink({ toolUseId, target, label }: { toolUseId?: string; target?: string; label?: string }) {
  const scope = useContext(SubagentScope);
  const list = useList(scope);
  const session = useStore(st => (scope ? st.sessions[scope] : undefined));
  useEffect(() => {
    if (scope) void loadSubagents(scope);
  }, [scope]);
  const v = toolUseId ? forCall(list, toolUseId) : forTarget(list, target);
  if (!v) return null;
  const st = subStatus(v, session);
  return (
    <span className="sub-link">
      <SubStatusDot status={st} />
      <span className="sub-link-st">{SUBAGENT_STATUS_LABEL[st]}</span>
      <a
        href={`#subagent-${v.id}`}
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          openSubagent(v);
        }}
      >
        {/* addressed by agentId: the registry row's name reads better than the id (QA subagents 3) */}
        {target && v.name ? `Чат ${v.name}` : (label ?? (v.kind === 'teammate' && v.name ? `Чат ${v.name}` : 'Открыть чат субагента'))}
      </a>
    </span>
  );
}

/** The header of a subagent's chat: the description, «Субагент сессии <родитель>», the type, the status. */
export function SubagentHead({ v, parent }: { v: SubagentView; parent: SessionView | undefined }) {
  const parentSub = useStore(st => (v.parentId ? st.subagents[v.parentId] : undefined));
  const [now, setNow] = useState(Date.now());
  const st = subStatus(v, parent);
  useEffect(() => {
    if (st !== 'running' && st !== 'idle') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [st]);
  const dur = durationLabel(subDurationMs(v, st, now));
  return (
    <>
      <div className="chat-head">
        <div className="chat-title">
          {subTitle(v)}
          <span className="sub mono">
            {subType(v)}
            {v.model ? ` · ${v.model}` : ''}
            {dur ? ` · ${dur}` : ''}
          </span>
        </div>
        <div className="head-controls">
          <span className="pill">
            <SubStatusDot status={st} />
            {SUBAGENT_STATUS_LABEL[st]}
          </span>
        </div>
      </div>
      <div className="banner sub-banner" role="note">
        <div className="b-text">
          Субагент сессии{' '}
          <a
            href={`/s/${v.sessionId}`}
            onClick={e => {
              e.preventDefault();
              openSession(v.sessionId);
            }}
          >
            {parent?.title ?? v.session.title}
          </a>
          {parentSub && (
            <>
              {' · вызван '}
              <a
                href={`#subagent-${parentSub.id}`}
                onClick={e => {
                  e.preventDefault();
                  openSubagent(parentSub);
                }}
              >
                {subTitle(parentSub)}
              </a>
            </>
          )}{' '}
          — только чтение
          {/* the phone hides the chat header: the status and the type stay visible here */}
          <span className="sub-banner-st">
            {' · '}
            <SubStatusDot status={st} /> {SUBAGENT_STATUS_LABEL[st]} · {subType(v)}
            {dur ? ` · ${dur}` : ''}
          </span>
        </div>
      </div>
    </>
  );
}

/** Loads the parent session's card and registry for a subagent tab. */
export function useSubagentParent(v: SubagentView | undefined): SessionView | undefined {
  const parent = useStore(st => (v ? st.sessions[v.sessionId] : undefined));
  // the list is dropped when the chat leaves the screen or the socket reconnects: loaded again while the tab is shown
  const listMissing = useStore(st => (v ? st.subagentLists[v.sessionId] === undefined : false));
  useEffect(() => {
    if (!v) return;
    void ensureSession(v.sessionId);
    if (listMissing) void loadSubagents(v.sessionId);
  }, [v?.sessionId, v, listMissing]);
  return parent;
}

export const subagentColor = (parent: SessionView | undefined) => colorVar(parent?.project.colorKey);
