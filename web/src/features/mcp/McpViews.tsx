/**
 * MCP in the UI (change mcp-management, design M10, task 5.4).
 * Requirements: Статус MCP сессии; Отметка проблем MCP; Переподключение MCP-сервера; Включение и выключение
 * MCP-сервера; Вход в удалённый MCP с любого устройства; Защита потока входа MCP; MCP спящей сессии; Совместимость
 * управления MCP с агентом.
 * - McpButton: «MCP» with the number of servers in `failed`/`needs-auth` in the chat head (compact in the phone's info
 *   line, only with problems); opens the panel.
 * - McpPanel: a popover under the head's «MCP» button on the desktop (UI review M1), a sheet from the bottom on the
 *   phone (like «Субагенты»).
 * - McpAuthBlock: the link «Открыть страницу входа» (an <a target=_blank>, not window.open after a WS event — the phone's
 *   popup blocker); for `redirect: 'localhost'` numbered steps with the paste field and «Вставить» (UI review H1); the
 *   time left.
 * - McpTreeMark: the mark in a tree row; McpMenuItem: «MCP-серверы…» in the «⋯» menu.
 * - mcp-auth-controls A6: «Войти заново» and «Выйти» (ghost, after «Выключить») of an OAuth server, «Войти» of a server
 *   failed with an auth error; McpLogoutConfirm — the confirmation of «Выйти» under the row (focus on «Отмена», Esc).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MCP_TEXTS, type McpAuthFlowView, type McpServerView, type McpSessionView, type SessionView } from '../../api/types';
import { useStore } from '../../store';
import { clockLabel, runnerIndex } from '../sessions/status';
import { useDialog, useNow } from '../ui/a11y';
import { openSettings } from '../settings/Settings';
import { closeMcpPanel, loadMcp, logoutServer, mcpAction, openMcpPanel, refreshMcp, startMcpAuth, submitMcpCallback } from './actions';
import { McpRegistry } from './McpRegistry';
import {
  MCP_STATUS_LABEL,
  MCP_STATUS_TONE,
  agentMcpVerdict,
  authKey,
  disabledCaption,
  flowLeft,
  infoLine,
  kindLine,
  markCount,
  pasteProblem,
  pendingText,
  problemTone,
  problemsFirst,
  reasonText,
  resigninHint,
  rowActions,
  rowLayout,
  type RowButton,
  shownStatus,
  sleepingNote,
  snapshotLine,
} from './mcpModel';

const PLUG = (
  <svg className="mcp-ico" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0V5ZM8 11.5V14" />
  </svg>
);

/**
 * The view of the session, fetched once it is on screen. Only a hub of this change sends `SessionView.mcpProblems`
 * (0 by default): without the field there is no MCP API to ask.
 */
function useMcpView(s: SessionView): McpSessionView | null | undefined {
  const view = useStore(st => st.mcp[s.id]);
  const supported = s.mcpProblems !== undefined;
  useEffect(() => {
    if (supported) void loadMcp(s.id);
  }, [s.id, supported]);
  return supported ? view : (view ?? null);
}

/** «MCP» / «MCP 2» in the head; `compact` — the phone's info line, shown only when something needs attention. */
export function McpButton({ s, compact }: { s: SessionView; compact?: boolean }) {
  const view = useMcpView(s);
  const open = useStore(st => st.mcpPanel === s.id);
  const count = markCount(view, s.mcpProblems);
  const tone = problemTone(view, count);
  if (view === null) return null;
  if (view === undefined && !count) return null;
  if (compact && !count) return null;
  const label = count ? `MCP: проблемных серверов ${count}` : 'MCP-серверы';
  return (
    <button
      type="button"
      className={`btn mcp-btn${compact ? ' compact' : ''}${tone ? ` ${tone}` : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={label}
      title={count ? `${label} — открыть панель MCP` : 'MCP-серверы сессии'}
      onClick={() => (open ? closeMcpPanel() : openMcpPanel(s.id))}
    >
      {compact && PLUG}
      MCP
      {count > 0 && <span className="mcp-count">{count}</span>}
    </button>
  );
}

/** «MCP-серверы…» in the «⋯» menu (the phone, narrow panes). */
export function McpMenuItem({ s, onPick }: { s: SessionView; onPick: () => void }) {
  const view = useMcpView(s);
  if (view === null) return null;
  const count = markCount(view, s.mcpProblems);
  return (
    <button
      type="button"
      role="menuitem"
      className="btn menu-mcp"
      onClick={() => {
        onPick();
        openMcpPanel(s.id);
      }}
    >
      {PLUG} MCP-серверы{count > 0 ? ` · проблем ${count}` : ''}
    </button>
  );
}

/** The mark of MCP problems in a tree row. */
export function McpTreeMark({ s }: { s: SessionView }) {
  const view = useStore(st => st.mcp[s.id]);
  const count = markCount(view, s.mcpProblems);
  const tone = problemTone(view, count);
  if (!count || !tone) return null;
  return (
    <span className={`mcp-mark ${tone}`} role="img" aria-label={`Проблемы MCP: ${count}`} title={`Проблемы MCP: ${count}`}>
      {PLUG}
      {count > 1 ? count : null}
    </span>
  );
}

/** The panel of the session `s`, when it is the open one. */
export function McpPanelHost({ s }: { s: SessionView }) {
  const open = useStore(st => st.mcpPanel === s.id);
  // QA fix 3: a mark inside the session's pane, so the desktop popover hangs under this pane's button, not another's
  const mark = useRef<HTMLSpanElement>(null);
  return open ? (
    <>
      <span ref={mark} hidden />
      <McpPanel s={s} onClose={closeMcpPanel} paneMark={mark} />
    </>
  ) : null;
}

export function McpPanel({ s, onClose, paneMark }: { s: SessionView; onClose: () => void; paneMark?: RefObject<HTMLElement | null> }) {
  const view = useStore(st => st.mcp[s.id]);
  const phone = useStore(st => st.device === 'phone');
  const runner = useStore(st => runnerIndex(st.runners)[s.runnerId]);
  const machine = runner?.name ?? s.runnerId;
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const anchor = useAnchor(!phone, paneMark);
  useDialog(ref, onClose);
  useNow(60_000);
  useEffect(() => {
    void loadMcp(s.id);
    closeRef.current?.focus({ preventScroll: true });
  }, [s.id]);
  useEffect(() => {
    if (view === null) onClose(); // the hub has no MCP API for this session: nothing to show
  }, [view, onClose]);
  const refresh = async () => {
    setErr(null);
    setRefreshing(true);
    const r = await refreshMcp(s.id);
    setRefreshing(false);
    if (!r.ok && r.message) setErr(r.message);
  };
  const outdated = view?.reason === 'agent_outdated';
  const reason = view && !outdated ? reasonText(view) : null;
  const verdict = outdated ? agentMcpVerdict(runner, true) : null;
  const sleeping = view ? sleepingNote(view) : null;
  // UI review M7: a sleeping session has nothing to refresh — no button at all
  const canRefresh = !!view && view.live && !outdated && view.reason !== 'not_hub_managed';
  return createPortal(
    <div className={`scrim${phone ? ' sheet-scrim' : ' sub-scrim'}`} style={anchor} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`sub-list mcp-panel${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sub-head mcp-head">
          <div className="mcp-head-t">
            <h2 id={titleId}>MCP-серверы</h2>
            {view && <span className="mcp-when">{snapshotLine(view, iso => clockLabel(iso))}</span>}
          </div>
          {canRefresh && (
            <button type="button" className="btn ghost mcp-refresh" disabled={refreshing || view.waking} title="Запросить свежий статус у процесса сессии" onClick={() => void refresh()}>
              {refreshing ? 'Обновляем…' : 'Обновить'}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={() => setRegistryOpen(true)}>
            Реестр
          </button>
          <button type="button" className="icon-btn" aria-label="Закрыть" ref={closeRef} onClick={onClose}>
            ×
          </button>
        </div>
        {view === undefined && (
          <div className="sk-rows" role="status" aria-label="Загрузка списка">
            {[78, 62, 86].map(w => (
              <span key={w} className="skeleton" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {view && view.waking && (
          <p className="mcp-note info" role="status">
            <span className="spinner" aria-hidden="true" /> Сессия просыпается…
          </p>
        )}
        {sleeping && (
          <p className="mcp-note info" role="note">
            {sleeping}
          </p>
        )}
        {verdict && (
          /* UI review H3: the machine and the versions in the banner itself; «Машины» is a secondary link */
          <div className="mcp-note warn" role="note">
            <b>{MCP_TEXTS.agentOutdated}</b>
            <span>{verdict.line}</span>
            <span className="mcp-note-sub">{verdict.next}</span>
            <button
              type="button"
              className="btn ghost mcp-note-link"
              onClick={() => {
                onClose();
                openSettings('machines');
              }}
            >
              Открыть «Машины»
            </button>
          </div>
        )}
        {reason && (
          <div className="mcp-note" role="note">
            <span>{reason}</span>
          </div>
        )}
        {err && (
          <p className="mcp-note bad" role="alert">
            {err}
          </p>
        )}
        {view && (
          <ul className="mcp-rows" aria-label="Серверы">
            {problemsFirst(view.servers).map(srv => (
              <McpServerRow key={srv.name} s={s} view={view} srv={srv} machine={machine} phone={phone} />
            ))}
            {!view.servers.length && view.observedAt && <li className="mcp-empty">MCP-серверов в этой сессии нет</li>}
          </ul>
        )}
      </div>
      {registryOpen && <McpRegistry onClose={() => setRegistryOpen(false)} />}
    </div>,
    document.body,
  );
}

/**
 * UI review M1: the desktop popover hangs under the head's «MCP» button (its right edge under the button's right edge),
 * not in the window's corner; the phone's sheet is not anchored. QA fix 3: the button is looked up in the session's own
 * pane (several panes on a desktop): its «MCP», else its «⋯» (opened from the menu), else the pane's top right corner.
 */
function useAnchor(on: boolean, paneMark?: RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [pos, setPos] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!on) {
      setPos(undefined);
      return;
    }
    const place = () => {
      const pane = paneMark?.current?.closest<HTMLElement>('section') ?? null;
      const scope: ParentNode = pane ?? document;
      const shown = (sel: string) =>
        Array.from(scope.querySelectorAll<HTMLElement>(sel))
          .map(b => b.getBoundingClientRect())
          .find(r => r.width > 0);
      const r = shown('.mcp-btn') ?? shown('.ctl-more > .icon-btn');
      if (r) return setPos({ paddingTop: Math.round(r.bottom + 6), paddingRight: Math.max(12, Math.round(window.innerWidth - r.right)) });
      const p = pane?.getBoundingClientRect();
      if (!p || !p.width) return setPos(undefined);
      setPos({ paddingTop: Math.round(p.top + 48), paddingRight: Math.max(12, Math.round(window.innerWidth - p.right + 8)) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [on, paneMark]);
  return pos;
}

function McpServerRow({ s, view, srv, machine, phone }: { s: SessionView; view: McpSessionView; srv: McpServerView; machine: string; phone: boolean }) {
  const authError = useStore(st => st.mcpAuthErrors[authKey(s.id, srv.name)]);
  const [err, setErr] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const status = shownStatus(srv);
  const tone = MCP_STATUS_TONE[status];
  const flow = view.authFlows.find(f => f.server === srv.name);
  const acts = rowActions(srv, view, !!flow);
  const layout = rowLayout(srv, acts);
  const label = (b: RowButton): string =>
    b === 'signin'
      ? flow
        ? 'Войти заново'
        : 'Войти'
      : b === 'resignin'
        ? 'Войти заново'
        : b === 'reconnect'
          ? 'Переподключить'
          : b === 'logout'
            ? 'Выйти'
            : acts.toggle === 'enable'
              ? 'Включить'
              : 'Выключить';
  const classOf = (b: RowButton): string => (b === 'signin' ? (flow ? 'btn' : 'btn primary') : b === 'reconnect' && !acts.quiet && !layout.menu.length ? 'btn' : 'btn ghost');
  const pending = pendingText(srv);
  const info = infoLine(srv);
  const kind = kindLine(srv);
  const act = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setErr(null);
    const r = await fn();
    if (!r.ok && r.message) setErr(r.message);
  };
  const run = (b: RowButton) => {
    if (b === 'logout') return setConfirming(true);
    if (b === 'signin' || b === 'resignin') return void act(() => startMcpAuth(s.id, srv.name));
    void act(() => mcpAction(s.id, srv.name, b === 'reconnect' ? 'reconnect' : acts.toggle));
  };
  // UI review H2: while an action is on the way the previous error is history, not an alarm
  const lastError = !err && srv.lastError ? srv.lastError : null;
  return (
    <li className={`mcp-row ${tone}`} aria-label={`${srv.name}: ${MCP_STATUS_LABEL[status]}`}>
      <div className="mcp-r-top">
        <span className={`mcp-dot ${tone}`} aria-hidden="true" />
        <span className="mcp-name">{srv.name}</span>
        <span className={`mcp-st ${tone}`}>{MCP_STATUS_LABEL[status]}</span>
      </div>
      {kind && <div className="mcp-meta">{kind}</div>}
      {srv.target && (
        /* UI review L6: a long command opens in full on a tap (the full text is in the title for the pointer) */
        <div className={`mcp-target mono${wide ? ' wide' : ''}`} title={srv.target} onClick={() => setWide(!wide)}>
          {srv.target}
        </div>
      )}
      {info && <div className="mcp-meta">{info}</div>}
      {srv.status === 'disabled' && <div className="mcp-meta">{disabledCaption(srv, view.projectRoot, machine)}</div>}
      {srv.status === 'failed' && srv.error && <div className="mcp-err">{srv.error}</div>}
      {pending && (
        <div className="mcp-pending" role="status">
          <span className="spinner" aria-hidden="true" /> {pending}
        </div>
      )}
      {err && (
        <div className="mcp-err" role="alert">
          {err}
        </div>
      )}
      {lastError &&
        (srv.pendingAction ? (
          <div className="mcp-meta mcp-past">Прошлая ошибка: {lastError}</div>
        ) : (
          <div className="mcp-err" role="alert">
            {lastError}
          </div>
        ))}
      {flow && <McpAuthBlock sessionId={s.id} server={srv.name} flow={flow} phone={phone} hint={resigninHint(srv)} />}
      {!flow && authError && (
        <div className="mcp-err" role="alert">
          {authError}
        </div>
      )}
      {view.available && srv.pendingAction !== 'logout' && (
        <div className="mcp-actions">
          {layout.visible.map(b => (
            <button key={b} type="button" className={classOf(b)} disabled={acts.locked} onClick={() => run(b)}>
              {label(b)}
            </button>
          ))}
          {layout.menu.length > 0 && <McpRowMenu name={srv.name} disabled={acts.locked} items={layout.menu.map(b => ({ key: b, label: label(b), danger: b === 'logout', onPick: () => run(b) }))} />}
        </div>
      )}
      {confirming && acts.logout && (
        <McpLogoutConfirm
          server={srv.name}
          machine={machine}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void act(() => logoutServer(s.id, srv.name));
          }}
        />
      )}
    </li>
  );
}

/**
 * UI review H1 (mcp-auth-controls): the «⋯» menu of a row — «Выключить», «Выйти» (and for an auth error
 * «Переподключить»). Esc, a click outside and the focus leaving it close it without closing the panel; ↑/↓, Home/End
 * move between the items; after an item the focus is back on «⋯»; it opens upwards near the list's end.
 */
export function McpRowMenu({ name, disabled, items }: { name: string; disabled: boolean; items: Array<{ key: string; label: string; danger?: boolean; onPick: () => void }> }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const toggle = () => {
    if (!open) {
      const r = btn.current?.getBoundingClientRect();
      const list = btn.current?.closest('.mcp-rows')?.getBoundingClientRect();
      setUp(!!r && !!list && r.bottom + 44 * items.length + 16 > list.bottom);
    }
    setOpen(!open);
  };
  return (
    <span
      className="mcp-more"
      ref={box}
      data-own-escape={open ? '' : undefined}
      onBlur={e => {
        if (open && !box.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={e => {
        if (!open) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
          return;
        }
        const list = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        if (!list.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
        list[next]!.focus();
      }}
    >
      <button type="button" ref={btn} className="btn ghost mcp-more-btn" aria-label={`Действия с ${name}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}>
        ⋯
      </button>
      {open && (
        <div className={`menu mcp-menu${up ? ' up' : ''}`} role="menu" aria-label={`Действия с ${name}`}>
          {items.map(it => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              onClick={() => {
                setOpen(false);
                btn.current?.focus();
                it.onPick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * mcp-auth-controls A6, UI review H2: the confirmation of «Выйти» under the row — the spec text with the machine, a
 * filled danger «Выйти и отозвать токен» and «Отмена»; the focus starts on «Отмена», Esc cancels (not the panel).
 */
function confirmBody(server: string, machine: string): ReactNode {
  return (
    <>
      Выйти из {server} на {machine}? Вход сбросится во <b>всех</b> сессиях {machine} и в новых сессиях; токен будет отозван у провайдера.
    </>
  );
}

export function McpLogoutConfirm({ server, machine, onConfirm, onCancel }: { server: string; machine: string; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    cancel.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className="mcp-confirm"
      role="alertdialog"
      aria-labelledby={id}
      data-own-escape=""
      onKeyDown={e => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <p id={id}>{confirmBody(server, machine)}</p>
      <div className="mcp-confirm-actions">
        <button type="button" className="btn danger-fill" onClick={onConfirm}>
          Выйти и отозвать токен
        </button>
        <button type="button" className="btn" ref={cancel} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

/**
 * The sign-in attempt being waited for (UI review H1, M4): the link to the provider; for `localhost` three numbered
 * steps — open and sign in, copy the address of the error page, paste it here («Вставить» reads the clipboard and sends
 * a valid address at once). After the link is used «Готово» becomes the main button; an accepted address hides the form.
 */
export function McpAuthBlock({ sessionId, server, flow, phone = false, hint = null }: { sessionId: string; server: string; flow: McpAuthFlowView; phone?: boolean; hint?: string | null }) {
  const now = useNow(1000);
  const flowError = useStore(st => st.mcpAuthErrors[authKey(sessionId, server)]);
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const left = flowLeft(flow, now);
  const shown = err ?? flowError ?? null;
  useEffect(() => {
    if (flowError) setAccepted(false); // the hub refused the pasted address over WS: the form again
  }, [flowError]);
  const send = async (value: string) => {
    const p = pasteProblem(value);
    if (p) return setErr(p);
    setErr(null);
    setBusy(true);
    const r = await submitMcpCallback(sessionId, server, value);
    setBusy(false);
    if (!r.ok && r.message) setErr(r.message);
    else if (r.ok) {
      setText('');
      setAccepted(true);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };
  const paste = async () => {
    // no access to the clipboard (a refused permission, an older browser) reads as an empty text
    const clip = await Promise.resolve(navigator.clipboard?.readText?.())
      .then(t => t ?? '')
      .catch(() => '');
    if (!clip.trim()) return field.current?.focus(); // no access to the clipboard: the user pastes by hand
    setText(clip);
    const p = pasteProblem(clip);
    if (p) {
      setErr(p);
      field.current?.focus();
    } else void send(clip);
  };
  if (!left)
    return (
      <div className="mcp-auth" role="status">
        Время попытки входа вышло — нажмите «Войти заново»
      </div>
    );
  const link = (
    <a className={`btn${opened ? '' : ' primary'} mcp-auth-link`} href={flow.authUrl} target="_blank" rel="noopener" onClick={() => setOpened(true)}>
      Открыть страницу входа
    </a>
  );
  const reset = hint && (
    <p className="mcp-auth-hint mcp-auth-reset" role="note">
      {hint}
    </p>
  );
  if (flow.redirect === 'hub')
    return (
      <div className="mcp-auth">
        {reset}
        {link}
        <span className="mcp-auth-left">Ссылка действует ещё {left}</span>
        <p className="mcp-auth-hint">После входа провайдер вернёт вас в хаб, сервер подключится сам.</p>
        {shown && (
          <p className="mcp-err" role="alert">
            {shown}
          </p>
        )}
      </div>
    );
  if (accepted && !shown)
    return (
      <div className="mcp-auth">
        <p className="mcp-auth-ok" role="status">
          <span className="spinner" aria-hidden="true" /> Адрес принят — подключаем…
        </p>
      </div>
    );
  return (
    <div className="mcp-auth">
      {reset}
      <ol className="mcp-steps">
        <li>
          <span>Откройте страницу входа и войдите.</span>
          {link}
          <span className="mcp-auth-left">Ссылка действует ещё {left}</span>
        </li>
        <li>
          <span>
            Браузер покажет ошибку — это нормально. Скопируйте адрес страницы: <span className="mono">http://localhost:{flow.callbackPort ?? '…'}/callback?…</span>
          </span>
          {phone && <span className="mcp-auth-hint">На телефоне: «Открыть в браузере» или «Поделиться → Скопировать».</span>}
        </li>
        <li>
          <form className="mcp-paste" onSubmit={submit}>
            <label htmlFor={id}>Вставьте адрес сюда</label>
            <div className="mcp-paste-row">
              <input
                id={id}
                ref={field}
                className="input mono"
                value={text}
                placeholder={`http://localhost:${flow.callbackPort ?? ''}/callback?code=…`}
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                aria-label="Адрес страницы после входа"
                aria-invalid={!!shown}
                aria-describedby={shown ? `${id}-err` : undefined}
                onChange={e => setText(e.target.value)}
              />
              <button type="button" className="btn" disabled={busy} onClick={() => void paste()}>
                Вставить
              </button>
            </div>
            {shown && (
              <p className="mcp-err" id={`${id}-err`} role="alert">
                {shown}
              </p>
            )}
            <button type="submit" className={`btn${opened ? ' primary' : ''} mcp-paste-done`} disabled={busy}>
              {busy ? 'Проверяем…' : 'Готово'}
            </button>
          </form>
        </li>
      </ol>
    </div>
  );
}
