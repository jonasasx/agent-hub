/**
 * Agent Hub desktop — Electron main process (change desktop-app, design D1–D17).
 * The window shows the prod web of the hub; native features (tray counter, notifications, hotkey, autostart,
 * deep links, sign-in through the browser, updates) live here. No preload, the page cannot call the app.
 */
import { app, globalShortcut } from 'electron';
import { join } from 'node:path';
import type { Locale, SidebarResponse } from '@agent-hub/shared';
import { conflictMessage } from '../core/hotkey.js';
import { currentLocale, resolveLocale, setLocale } from '../core/i18n.js';
import { HubState } from '../core/hubState.js';
import type { HubClient, HubConnState } from '../core/hubClient.js';
import { PROTOCOL, launchAction, type DeepLink } from '../core/deepLink.js';
import { SIGN_IN_GRACE_MS, displayConnState, trayView } from '../core/trayView.js';
import { DesktopAuth } from './auth.js';
import { ConfigStore } from './configStore.js';
import { applyInstallSource } from './installSource.js';
import { log } from './files.js';
import { createHubClient, readSessionCookie } from './hubConnection.js';
import { Notifier } from './notifications.js';
import { AppTray } from './tray.js';
import { Updater } from './updater.js';
import { AppWindow, hubSession } from './window.js';

const APP_ID = 'io.github.jonasasx.agenthub';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  app.setAppUserModelId(APP_ID);
  const assetsDir = app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'assets');
  const userAgent = `AgentHubDesktop/${app.getVersion()}`;

  let config: ConfigStore;
  let win: AppWindow;
  let tray: AppTray;
  let hub: HubClient;
  let auth: DesktopAuth;
  let updater: Updater;
  let notifier: Notifier;
  const state = new HubState();
  let connState: HubConnState = 'connecting';
  let hotkeyRegistered = false;
  let pendingLink: DeepLink | null = null;

  const render = () => {
    if (!tray || !win) return;
    const shown = displayConnState(connState, { exchanging: auth?.exchanging ?? false, msSinceSignIn: Date.now() - (auth?.signedInAt ?? 0) });
    const view = trayView(shown, state.waitingCount(), win.isOffline);
    tray.render(view, {
      version: app.getVersion(),
      windowVisible: win.win.isVisible() && !win.win.isMinimized(),
      signedOut: shown === 'signed_out',
      hotkey: config.effective.hotkey,
      hotkeyRegistered,
      autostart: config.effective.autostart,
      updateReady: updater?.updateReady ?? false,
      locale: currentLocale(),
    });
    win.setOverlay(view.overlay, view.overlayText);
  };

  // Language: the profile choice of the hub (`/api/me`), before it is known and without a choice — the system language.
  let hubLocale: Locale | null = null;
  const applyLocale = async () => {
    const wanted = resolveLocale(hubLocale, [...app.getPreferredSystemLanguages(), app.getLocale()]);
    if (await setLocale(wanted)) {
      log(`locale ${wanted}`);
      render();
    }
  };

  const openSession = (id: string) => {
    win.show();
    if (connState === 'signed_out') auth.start(`/s/${id}`);
    else win.openHubPath(`/s/${id}`);
  };

  const handleLink = (link: DeepLink) => {
    if (link.kind === 'session') return openSession(link.id);
    void auth.onAuthLink(link.code, link.state).catch((e: Error) => log(`auth link: ${e.message}`));
  };

  const handleArgv = (argv: readonly string[], firstRun: boolean) => {
    const a = launchAction(argv);
    if (a.kind === 'link') {
      if (!win) pendingLink = a.link;
      else handleLink(a.link);
    } else if (a.kind === 'ignoredLink') {
      log('deep link ignored (invalid)');
      if (!firstRun) win?.show();
    } else if (a.kind === 'show' || !firstRun) {
      win?.show();
    }
  };

  const applyHotkey = (accel: string | null, announceConflict: boolean) => {
    globalShortcut.unregisterAll();
    hotkeyRegistered = false;
    if (accel === null) return;
    try {
      hotkeyRegistered = globalShortcut.register(accel, () => win.toggle());
    } catch (e) {
      log(`hotkey ${accel} invalid: ${(e as Error).message}`);
      hotkeyRegistered = false;
    }
    if (!hotkeyRegistered) {
      log(`hotkey ${accel} not registered`);
      if (announceConflict) notifier.info('Agent Hub', conflictMessage(accel));
    }
  };

  const applyAutostart = (on: boolean) => {
    // Only the installed exe goes into HKCU\…\Run (dev would register electron.exe).
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ['--hidden'], name: 'Agent Hub' });
  };

  // Second launch (Win+R agenthub://…, Start menu, protocol from the browser): its argv come here.
  app.on('second-instance', (_e, argv) => {
    log('second instance');
    handleArgv(argv, false);
  });

  app.on('before-quit', () => {
    if (win) {
      win.quitting = true;
      win.saveState();
    }
  });
  app.on('window-all-closed', () => {
    /* stay in the tray */
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    hub?.stop();
    updater?.stop();
  });

  // macOS-style open-url never fires on Windows; links arrive through argv only.
  const firstAction = launchAction(process.argv);
  if (firstAction.kind === 'link') pendingLink = firstAction.link;

  void app.whenReady().then(async () => {
    config = new ConfigStore();
    // The dialog of the installer source speaks the system language: the locale is set before it.
    await applyLocale();
    applyInstallSource(config);
    const cfg = config.effective;
    log(`start ${app.getVersion()} hub=${cfg.hubUrl} packaged=${app.isPackaged}`);

    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    else if (process.env.AGENTHUB_REGISTER_PROTOCOL === '1') {
      // Dev: lets the sign-in return to `npm run dev` (overrides the installed app's registration until reinstall).
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [app.getAppPath()]);
    }

    notifier = new Notifier(id => openSession(id));
    const sess = hubSession();
    win = new AppWindow({
      hubUrl: cfg.hubUrl,
      assetsDir,
      onLoginRequested: ret => auth.onLoginRequested(ret, win.win.isVisible() && !win.win.isMinimized()),
      onOfflineChanged: () => render(),
      onHubBack: () => hub.reconnectNow(),
    });
    for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) win.win.on(ev as 'show', () => render());
    auth = new DesktopAuth(
      cfg.hubUrl,
      userAgent,
      sess,
      () => win,
      () => {
        render();
        // The grace after a sign-in ends without a state change if the socket really stays signed out: re-render then.
        setTimeout(render, SIGN_IN_GRACE_MS + 100);
      },
    );
    updater = new Updater(
      cfg.hubUrl,
      userAgent,
      () => readSessionCookie(sess, cfg.hubUrl),
      () => render(),
    );

    tray = new AppTray(assetsDir, {
      toggleWindow: () => win.toggle(),
      showWindow: () => win.show(),
      hideWindow: () => win.win.hide(),
      signIn: () => {
        win.show();
        auth.start('/');
      },
      setHotkey: accel => {
        config.update({ hotkey: accel });
        applyHotkey(accel, true);
        render();
      },
      setAutostart: on => {
        config.update({ autostart: on });
        applyAutostart(on);
        render();
      },
      checkUpdates: () => void updater.check(true),
      installUpdate: () => {
        win.quitting = true;
        updater.install();
      },
      quit: () => {
        win.quitting = true;
        app.quit();
      },
    });

    hub = createHubClient(sess, cfg.hubUrl, userAgent, {
      onState: s => {
        const prev = connState;
        connState = s;
        log(`hub state ${s}`);
        if (s === 'signed_out') state.clear();
        if (s === 'online' && prev !== 'online') win.hubIsBack();
        render();
      },
      onHealth: ok => {
        if (!ok) win.hubUnreachable();
      },
      onLocale: locale => {
        hubLocale = locale;
        void applyLocale();
      },
      onSeed: (sb: SidebarResponse) => {
        state.seed(sb);
        render();
      },
      onMessage: msg => {
        const r = state.handle(msg, win.isVisibleAndFocused());
        if (r.kind === 'changed') {
          if (r.notification) notifier.show(r.notification);
          render();
        }
        return r.kind === 'reseed';
      },
    });

    applyHotkey(cfg.hotkey, true);
    applyAutostart(cfg.autostart);

    const link = pendingLink;
    pendingLink = null;
    if (link?.kind === 'session') win.openHubPath(`/s/${link.id}`);
    else win.openHubPath('/');
    if (firstAction.kind !== 'hidden') win.show();
    if (link?.kind === 'auth') handleLink(link);
    else if (firstAction.kind === 'ignoredLink') log('deep link ignored (invalid)');

    hub.start();
    updater.start();
    render();
  });
}
