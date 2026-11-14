/**
 * App shell: auth gate, left panel, work area, toasts, modals, live updates over /ws/ui.
 * Requirements: Вход через Google OIDC (redirect to login on 401); Браузерная сессия 30 дней (sign-out);
 * Онлайн-статус и переподключение (runner.status over /ws/ui).
 * Requirements (workspace-ui): Мои вкладки; Независимые окна; Раскладка нового окна и перезагрузка; Горячие клавиши;
 * Телефонный режим.
 * API: GET /api/me, GET /api/sidebar, GET /api/models, GET/PUT /api/layout, POST /auth/logout, WS /ws/ui (D10).
 * Change `multi-user`: Приветственный экран (no machines yet), «Подключить машину», «Настройки», /ws/ui close 4403 →
 * «Доступ отключён» (`/auth/disabled`, a hub page), 4401 → the login (UiCloseCode).
 */
import { useCallback, useEffect } from 'react';
import { ApiError, api, onUnauthorized, redirectToLogin } from './api/client';
import { connectUiSocket } from './api/uiSocket';
import { usableRunner, useStore } from './store';
import { UiCloseCode } from './api/types';
import { Welcome } from './features/machines/Welcome';
import { EnrollModal } from './features/machines/EnrollModal';
import { Settings, settingsFromPath } from './features/settings/Settings';
import { Sidebar, SkeletonRows } from './features/sidebar/Sidebar';
import { Toasts } from './features/toasts/Toasts';
import { Workspace } from './features/workspace/Workspace';
import { NewSessionModal } from './features/newSession/NewSessionModal';
import { QuickSearch } from './features/search/QuickSearch';
import { ForkModal } from './features/fork/ForkModal';
import { handleHotkey } from './features/workspace/hotkeys';
import { loadSubscriptions } from './features/subscriptions/actions';
import { loadLimits } from './features/limits/actions';
import { openMcpPanel, reloadMcp } from './features/mcp/actions';
import { LimitCard } from './features/limits/LimitCard';
import { SwitchConfirm } from './features/subscriptions/SwitchConfirm';
import { RestartConfirm } from './features/chat/RestartConfirm';
import { trackCtrlKey } from './features/ui/a11y';
import { Lightbox } from './features/images/ImagePreview';
import { startPhoneHistory } from './features/workspace/phoneHistory';
import { Rail } from './features/toolwindows/Rail';
import { Column } from './features/toolwindows/Column';
import { DropOverlay } from './features/toolwindows/DropOverlay';
import { PhoneWindow } from './features/toolwindows/PhoneWindow';
import { useDock } from './features/toolwindows/useDock';
import { applyProfileLocale, t, useT } from './i18n';
import { releasePush, syncPush } from './features/push/pushClient';
import { listenSwMessages } from './features/push/swMessages';
import { usePhone } from './features/toolwindows/usePhone';
import {
  dropSubagentLists,
  PHONE_QUERY,
  attachSocket,
  currentDevice,
  ensureLog,
  handleServerMessage,
  loadModels,
  loadSidebar,
  loadWorkspace,
  openSession,
  startLayoutPersistence,
  syncSocket,
  noteHidden,
  noteShown,
  visibleSessionIds,
} from './features/workspace/actions';

const SIGNED_OUT_FLAG = 'ah-signed-out';

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        ah
      </div>
      Agent Hub
    </div>
  );
}

export function SignedOut() {
  const t = useT();
  return (
    <main className="screen">
      <div className="card">
        <Brand />
        <h1>{t('workspace.app.signedOut')}</h1>
        <p>{t('workspace.app.signInAgain')}</p>
        <a
          className="btn primary"
          href="/auth/login?return=%2F"
          onClick={() => {
            try {
              sessionStorage.removeItem(SIGNED_OUT_FLAG);
            } catch {
              // ignore
            }
          }}
        >
          {t('workspace.app.signIn')}
        </a>
      </div>
    </main>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <main className="screen">
      <div className="card" role="alert">
        <Brand />
        <h1>{t('workspace.app.hubDown')}</h1>
        <p>{message}</p>
        <button type="button" className="btn primary" onClick={onRetry}>
          {t('workspace.app.retry')}
        </button>
      </div>
    </main>
  );
}

function signedOutFlag(): boolean {
  try {
    return sessionStorage.getItem(SIGNED_OUT_FLAG) === '1';
  } catch {
    return false;
  }
}

/** `/s/<id>` opens a session (links from notifications). */
function sessionFromPath(path: string): string | null {
  const m = /^\/s\/([0-9a-f-]{36})\/?$/i.exec(path);
  return m ? m[1]! : null;
}

export function App() {
  const auth = useStore(s => s.auth);
  const setAuth = useStore(s => s.setAuth);
  const modal = useStore(s => s.modal);
  const inChat = useStore(s => s.inChat);
  const phone = usePhone();
  const rightUsed = useDock(s => s.dock.right.length > 0);
  // opening a session on the phone leaves the tool window shown over the home screen
  useEffect(() => {
    if (inChat) useDock.getState().setPhoneWin(null);
  }, [inChat]);
  const settings = useStore(s => s.settings);
  const hasMachines = useStore(s => s.runners.some(usableRunner) || Object.keys(s.sessions).length > 0);

  const handleUnauthorized = useCallback(() => {
    if (signedOutFlag()) setAuth({ kind: 'signed_out' });
    else redirectToLogin();
  }, [setAuth]);

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      await applyProfileLocale(me.locale ?? null);
      await loadSidebar();
      setAuth({ kind: 'signed_in', me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) handleUnauthorized();
      else setAuth({ kind: 'error', message: t('workspace.app.hubUnreachable') });
      return;
    }
    void loadModels();
    void loadSubscriptions();
    void loadLimits();
    try {
      await loadWorkspace(currentDevice());
    } catch {
      useStore.setState({ layoutLoaded: true });
    }
    const set = settingsFromPath(window.location.pathname);
    if (set) {
      const tab = set === 'unknown' ? 'machines' : set;
      window.history.replaceState({ ahSettings: tab }, '', `/settings/${tab}`);
      useStore.setState({ settings: tab, inChat: true });
    }
    const sid = sessionFromPath(window.location.pathname);
    if (sid) {
      // mcp-management (M8): «Вход выполнен» leads to /s/<id>?mcp=1 — the session with its MCP panel open
      const mcp = new URLSearchParams(window.location.search).get('mcp') === '1';
      window.history.replaceState(null, '', '/');
      void openSession(sid);
      if (mcp) openMcpPanel(sid);
    }
    for (const id of visibleSessionIds()) ensureLog(id);
  }, [setAuth, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  // An action that gets 401 while the app is open means the browser session expired: go to login like on start.
  useEffect(() => {
    onUnauthorized(handleUnauthorized);
    return () => onUnauthorized(null);
  }, [handleUnauthorized]);

  const signedIn = auth.kind === 'signed_in';
  useEffect(() => {
    if (!signedIn) return;
    let first = true;
    const sock = connectUiSocket({
      onMessage: handleServerMessage,
      // State that changed while the socket was down comes from a fresh sidebar and chat pages. The window's tabs and
      // layout are its own (D11): a reconnect does not reload them.
      onOpen: () => {
        syncSocket(true);
        if (first) {
          first = false;
          return;
        }
        loadSidebar().catch(() => undefined);
        void loadSubscriptions(); // a missed subscriptions.changed
        void loadLimits(); // a missed subscription_limits.changed
        reloadMcp(); // missed session.mcp / mcp.auth
        const logs = { ...useStore.getState().logs };
        for (const id of Object.keys(logs)) delete logs[id];
        useStore.setState({ logs });
        // subagent lists missed their upserts while the socket was down: loaded again when looked at
        dropSubagentLists('all');
        for (const id of visibleSessionIds()) ensureLog(id);
      },
      onClose: code => {
        // Requirement (users): Отключение пользователя — the open windows go to «Доступ отключён»
        if (code === UiCloseCode.AccountDisabled) {
          window.location.assign('/auth/disabled');
          return;
        }
        api.me().catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) handleUnauthorized();
        });
      },
    });
    attachSocket(sock);
    const unsubPersist = startLayoutPersistence();
    const unsubHistory = startPhoneHistory(); // phone «назад»: chat → list, not out of the app
    // subscribe/presence follow the panes on screen; logs of newly shown sessions are loaded
    const unsubSync = useStore.subscribe((s, prev) => {
      if (s.ws !== prev.ws || s.inChat !== prev.inChat || s.device !== prev.device) {
        syncSocket();
        for (const id of visibleSessionIds()) ensureLog(id);
      }
    });
    const onVis = () => syncSocket();
    document.addEventListener('visibilitychange', onVis);
    // the hiding is counted from the loss of focus: Android sends visibilitychange seconds after the app is minimized
    const onBlur = () => noteHidden();
    const onFocus = () => noteShown();
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    const mq = window.matchMedia?.(PHONE_QUERY);
    const onMq = () => {
      const d = currentDevice();
      if (d !== useStore.getState().device) loadWorkspace(d).catch(() => undefined);
    };
    mq?.addEventListener?.('change', onMq);
    const onKey = (e: KeyboardEvent) => {
      handleHotkey(e);
    };
    window.addEventListener('keydown', onKey);
    const untrackCtrl = trackCtrlKey(); // tab numbers are shown while Ctrl/Cmd is held (UI review H6)
    return () => {
      untrackCtrl();
      attachSocket(null);
      sock.close();
      unsubPersist();
      unsubHistory();
      unsubSync();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      mq?.removeEventListener?.('change', onMq);
      window.removeEventListener('keydown', onKey);
    };
  }, [signedIn, handleUnauthorized]);

  // web-push-notifications D8: a tap on a push notification asks the open window to show the session (no reload);
  // the subscription is restored on start without a dialog
  const vapidKey = auth.kind === 'signed_in' ? auth.me.vapidPublicKey : null;
  const meId = auth.kind === 'signed_in' ? auth.me.user.id : null;
  useEffect(() => {
    if (!signedIn) return;
    return listenSwMessages(id => openSession(id));
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn || !meId) return;
    void syncPush({ vapidPublicKey: vapidKey, userId: meId });
  }, [signedIn, vapidKey, meId]);

  const pushToast = useStore(s => s.pushToast);
  const logout = async () => {
    // the device leaves the push list before the session ends; a failure or a slow hub never blocks the sign-out
    await releasePush(3000).catch(() => undefined);
    let redirect = '/';
    try {
      redirect = (await api.logout()).redirect;
    } catch (err) {
      // The server session may still be alive: do not pretend the user is signed out.
      if (!(err instanceof ApiError && err.status === 401)) {
        pushToast({ title: t('workspace.app.logoutFailed'), text: t('workspace.app.logoutFailedText'), color: 'var(--bad)' });
        return;
      }
    }
    try {
      sessionStorage.setItem(SIGNED_OUT_FLAG, '1');
    } catch {
      // ignore
    }
    // keycloak-auth D7: the provider ends its own session and returns to the root, where the flag shows «Вы вышли»
    if (redirect !== '/') {
      window.location.assign(redirect);
      return;
    }
    setAuth({ kind: 'signed_out' });
  };

  // first load: the panel's rows as a skeleton (M4a preloaders)
  if (auth.kind === 'loading')
    return (
      <main className="boot" aria-busy="true">
        <div className="side">
          <SkeletonRows n={8} />
        </div>
        <div className="pane-sk" />
      </main>
    );
  if (auth.kind === 'signed_out') return <SignedOut />;
  if (auth.kind === 'error') return <ErrorScreen message={auth.message} onRetry={() => void load()} />;

  const closeModal = () => useStore.setState({ modal: null });
  // Requirement (runner-enrollment): Приветственный экран — no machine and no history yet: no panel, no tabs.
  // The enrollment window stays the second child in both cases: the machine coming online while the window is open
  // swaps the welcome screen for the work area without resetting the window (its code and stages).
  const welcome = !hasMachines && !settings;
  return (
    <>
      {welcome ? (
        <Welcome onLogout={() => void logout()} />
      ) : (
        <div className={`app${inChat ? ' in-chat' : ''}`}>
          {phone ? (
            <Sidebar onLogout={() => void logout()} />
          ) : (
            <>
              <Rail side="left" onLogout={() => void logout()} />
              <Column side="left" />
            </>
          )}
          {settings ? <Settings /> : <Workspace />}
          {!phone && rightUsed && (
            <>
              <Column side="right" />
              <Rail side="right" />
            </>
          )}
          {modal?.type === 'new' && <NewSessionModal key={modal.runnerId ?? ''} preset={modal} onClose={closeModal} />}
          {modal?.type === 'search' && <QuickSearch onClose={closeModal} />}
          {modal?.type === 'fork' && <ForkModal key={modal.sessionId} sessionId={modal.sessionId} initialMode={modal.mode} onClose={closeModal} />}
          <SwitchConfirm />
          <RestartConfirm />
          <LimitCard />
          <Lightbox />
          {phone ? <PhoneWindow /> : <DropOverlay />}
        </div>
      )}
      {modal?.type === 'enroll' && <EnrollModal key={modal.runnerId ?? 'new'} runnerId={modal.runnerId} onClose={closeModal} />}
      <Toasts />
    </>
  );
}
