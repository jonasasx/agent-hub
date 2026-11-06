/**
 * The app window (design D2, D3, D14). Requirements: Окно с прод-вебом; Навигация и внешние ссылки; Изоляция окна;
 * Окно в присутствии хаба; Экран «Нет связи».
 */
import { BrowserWindow, Menu, nativeImage, screen, session, shell, type Session } from 'electron';
import { join } from 'node:path';
import { decideNavigation, hubPath, isImageViewerUrl, isPermissionAllowed, isPermissionCheckAllowed } from '../core/navigation.js';
import { HEALTH_POLL_MS, HEALTH_TIMEOUT_MS, actionOnHubBack, actionOnHubUnreachable, isOfflineHttpStatus, isOfflineLoadError, type WindowOutageView } from '../core/offline.js';
import { offlinePage, toDataUrl } from '../core/pages.js';
import { shouldHideOnToggle, type TrayIconName } from '../core/trayView.js';
import { parseWindowState, restoreWindowState, type WindowState } from '../core/windowState.js';
import { log, readText, userFile, writeText } from './files.js';
import { openImageWindow } from './imageWindow.js';

export const PARTITION = 'persist:agenthub';

export interface AppWindowOptions {
  hubUrl: string;
  assetsDir: string;
  /** The page navigated to `/auth/login?return=…`. */
  onLoginRequested(returnPath: string): void;
  /** The window entered or left «Нет связи». */
  onOfflineChanged(offline: boolean): void;
  /** The hub answers `/healthz` again after «Нет связи». */
  onHubBack(): void;
}

export function hubSession(): Session {
  return session.fromPartition(PARTITION);
}

/**
 * Permission handlers of the window's storage: clipboard write, fullscreen (D2) and sound recording by the hub's pages
 * (change voice-input, D8).
 */
export function lockDownSession(s: Session, hubOrigin: string): void {
  s.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const d = details as { requestingUrl?: string; mediaTypes?: string[] };
    const ok = isPermissionAllowed(permission, { hubOrigin, requestingUrl: d.requestingUrl, mediaTypes: d.mediaTypes });
    if (!ok) log(`permission denied: ${permission}`);
    cb(ok);
  });
  s.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    isPermissionCheckAllowed(permission, { hubOrigin, requestingUrl: requestingOrigin, mediaType: (details as { mediaType?: string }).mediaType }),
  );
}

export class AppWindow {
  readonly win: BrowserWindow;
  quitting = false;
  private lastBlurAt = 0;
  private offline = false;
  /** The hub connection says the hub is unreachable (socket offline and /healthz failing). */
  private hubDown = false;
  /** The current hub page finished loading while `hubDown` — i.e. from the web's service worker cache (D14). */
  private loadedDuringOutage = false;
  /** Last hub address of the main frame (where «Повторить» and the return after «Нет связи» go). */
  private lastHubUrl: string;
  private healthTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly statePath = userFile('window-state.json');

  constructor(private readonly o: AppWindowOptions) {
    this.lastHubUrl = `${o.hubUrl}/`;
    const primary = screen.getPrimaryDisplay().workArea;
    const st = restoreWindowState(
      parseWindowState(readText(this.statePath)),
      screen.getAllDisplays().map(d => d.workArea),
      primary,
    );
    Menu.setApplicationMenu(null);
    this.win = new BrowserWindow({
      x: st.x,
      y: st.y,
      width: st.width,
      height: st.height,
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: 'Agent Hub',
      icon: nativeImage.createFromPath(join(o.assetsDir, 'app.ico')),
      autoHideMenuBar: true,
      backgroundColor: '#f6f6f4',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        // Must stay true: with false Electron keeps document.visibilityState 'visible' for a hidden window and the
        // web's presence (notification suppression) breaks (D2).
        backgroundThrottling: true,
        spellcheck: true,
        devTools: process.env.AGENTHUB_DEVTOOLS === '1',
      },
    });
    this.win.setMenu(null);
    if (st.maximized) this.win.maximize();
    lockDownSession(this.win.webContents.session, new URL(o.hubUrl).origin);
    this.wire(st);
  }

  private wire(_initial: WindowState): void {
    const wc = this.win.webContents;
    const origin = new URL(this.o.hubUrl).origin;

    this.win.on('close', e => {
      if (this.quitting) return;
      e.preventDefault();
      this.win.hide();
    });
    // Windows log-off / shutdown: let the window close.
    this.win.on('session-end', () => {
      this.quitting = true;
    });
    this.win.on('blur', () => {
      this.lastBlurAt = Date.now();
    });
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize'] as const) this.win.on(ev as 'resize', () => this.scheduleSave());
    this.win.on('page-title-updated', e => {
      e.preventDefault();
    });

    const guard = (e: { preventDefault(): void }, url: string) => {
      const d = decideNavigation(url, origin);
      if (d.kind === 'allow') return;
      e.preventDefault();
      if (d.kind === 'login') this.o.onLoginRequested(d.returnPath);
      else if (d.kind === 'external') void shell.openExternal(d.url);
      else log(`navigation denied: ${url.slice(0, 200)}`);
    };
    wc.on('will-navigate', e => guard(e, e.url));
    wc.on('will-redirect', e => guard(e, e.url));
    wc.on('will-frame-navigate', e => {
      // Sub-frames of the hub page may only show the hub's own origin (no external iframes taking over).
      if (e.isMainFrame) return;
      const d = decideNavigation(e.url, origin);
      if (d.kind !== 'allow' && !e.url.startsWith('about:')) e.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      // «Открыть оригинал»: the picture in a window of its own, the app stays (change image-viewer, D4)
      if (isImageViewerUrl(url, origin)) {
        openImageWindow(url, origin, this.o.assetsDir);
        return { action: 'deny' };
      }
      const d = decideNavigation(url, origin);
      if (d.kind === 'allow') void this.win.loadURL(url);
      else if (d.kind === 'login') this.o.onLoginRequested(d.returnPath);
      else if (d.kind === 'external') void shell.openExternal(d.url);
      return { action: 'deny' };
    });
    wc.on('did-fail-load', (_e, errorCode, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      log(`load failed ${errorCode} ${desc}`);
      if (isOfflineLoadError(errorCode)) this.goOffline(url);
    });
    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      if (!url.startsWith(origin)) return;
      if (isOfflineHttpStatus(httpResponseCode)) return this.goOffline(url);
      this.lastHubUrl = url;
      if (this.offline) this.setOffline(false);
    });
    wc.on('did-finish-load', () => {
      if (wc.getURL().startsWith(origin)) this.loadedDuringOutage = this.hubDown;
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame && url.startsWith(origin)) this.lastHubUrl = url;
    });
    wc.on('render-process-gone', (_e, d) => log(`renderer gone: ${d.reason}`));
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveState(), 500);
  }

  saveState(): void {
    if (this.win.isDestroyed() || this.win.isMinimized()) return;
    const b = this.win.isMaximized() ? this.win.getNormalBounds() : this.win.getBounds();
    try {
      writeText(this.statePath, JSON.stringify({ ...b, maximized: this.win.isMaximized() }));
    } catch (e) {
      log(`window state not saved: ${(e as Error).message}`);
    }
  }

  get isOffline(): boolean {
    return this.offline;
  }

  isVisibleAndFocused(): boolean {
    return this.win.isVisible() && !this.win.isMinimized() && this.win.isFocused();
  }

  show(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  toggle(): void {
    const hide = shouldHideOnToggle({
      visible: this.win.isVisible(),
      minimized: this.win.isMinimized(),
      focused: this.win.isFocused(),
      msSinceBlur: Date.now() - this.lastBlurAt,
    });
    if (hide) this.win.hide();
    else this.show();
  }

  /** Opens a hub path (`/`, `/s/<id>`); while «Нет связи» only remembers it for the return. */
  openHubPath(path: string): void {
    const url = hubPath(this.o.hubUrl, path);
    this.lastHubUrl = url;
    if (this.offline) return;
    void this.win.loadURL(url).catch((e: Error) => log(`loadURL: ${e.message}`));
  }

  reloadHub(): void {
    this.openHubPath(new URL(this.lastHubUrl).pathname + new URL(this.lastHubUrl).search);
  }

  /** One of the app's own screens (pages.ts). */
  showPage(html: string): void {
    void this.win.loadURL(toDataUrl(html)).catch((e: Error) => log(`page: ${e.message}`));
  }

  setOverlay(icon: TrayIconName | null, text: string): void {
    this.win.setOverlayIcon(icon ? nativeImage.createFromPath(join(this.o.assetsDir, 'tray', `${icon}.ico`)) : null, text);
  }

  private goOffline(url: string): void {
    if (url.startsWith(this.o.hubUrl)) this.lastHubUrl = url;
    this.showPage(offlinePage(this.o.hubUrl, this.lastHubUrl));
    this.setOffline(true);
  }

  private setOffline(v: boolean): void {
    if (this.offline === v) return;
    this.offline = v;
    this.o.onOfflineChanged(v);
    if (v) this.startHealthPoll();
    else this.stopHealthPoll();
  }

  private outageView(): WindowOutageView {
    const url = this.win.webContents.getURL();
    return { offlineScreen: this.offline, onHubPage: url.startsWith(new URL(this.o.hubUrl).origin), loadedDuringOutage: this.loadedDuringOutage };
  }

  /**
   * The hub connection found the hub unreachable (`/healthz` fails while the socket is offline). A hub page served
   * by the web's service worker never fails to load, so the app shows its own «Нет связи» over it (B2 of QA).
   */
  hubUnreachable(): void {
    this.hubDown = true;
    if (actionOnHubUnreachable(this.outageView()) === 'show_offline') {
      log('hub unreachable: showing «Нет связи» over the cached page');
      this.goOffline(this.win.webContents.getURL());
    }
  }

  /** The hub connection is back (socket online) or `/healthz` answers again. */
  hubIsBack(): void {
    this.hubDown = false;
    const action = actionOnHubBack(this.outageView());
    if (action === 'reload') {
      log('hub back: reloading the page loaded during the outage');
      this.loadedDuringOutage = false;
      const u = new URL(this.win.webContents.getURL());
      this.openHubPath(u.pathname + u.search + u.hash);
      return;
    }
    if (action !== 'return') return;
    this.offline = false;
    this.stopHealthPoll();
    this.o.onOfflineChanged(false);
    const u = new URL(this.lastHubUrl);
    this.openHubPath(u.pathname + u.search + u.hash);
  }

  private startHealthPoll(): void {
    this.stopHealthPoll();
    const tick = async () => {
      try {
        const r = await fetch(`${this.o.hubUrl}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (r.status === 200) {
          log('hub is back (healthz 200)');
          this.hubIsBack();
          this.o.onHubBack();
          return;
        }
      } catch {
        /* still offline */
      }
      if (this.offline) this.healthTimer = setTimeout(() => void tick(), HEALTH_POLL_MS);
    };
    this.healthTimer = setTimeout(() => void tick(), HEALTH_POLL_MS);
  }

  private stopHealthPoll(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }
}
