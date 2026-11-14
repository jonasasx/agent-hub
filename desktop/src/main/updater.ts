/**
 * Auto-update from the hub feed (design D15). Requirement: Автообновление.
 * electron-updater, generic provider `<PUBLIC_URL>/api/desktop/updates/`, `Cookie: ah_session` set before every check;
 * sha512 of `latest.yml` is verified by electron-updater. Errors never interrupt the app.
 */
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import { SingleFlight, type UpdateCheckResult, UPDATE_FIRST_CHECK_MS, UPDATE_INTERVAL_MS, manualCheckMessage, updateErrorText, updateFeedUrl, updateRequestHeaders } from '../core/updates.js';
import { log } from './files.js';
import { dt } from '../core/i18n.js';
import { selfUpdateSupported } from './platform.js';

export class Updater {
  private ready = false;
  private readonly flight = new SingleFlight<UpdateCheckResult>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hubUrl: string,
    private readonly userAgent: string,
    private readonly getCookie: () => Promise<string | null>,
    private readonly onReadyChanged: () => void,
  ) {}

  private get au() {
    return electronUpdater.autoUpdater;
  }

  get updateReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (!app.isPackaged) {
      log('updater: not packaged, checks disabled');
      return;
    }
    if (!selfUpdateSupported) {
      log('updater: self-update is not supported on this platform, checks disabled');
      return;
    }
    const au = this.au;
    // The hub serves single-range requests only (a multi-range request gets the full file): without this flag the
    // differential download by blockmap silently falls back to a full download.
    au.setFeedURL({ provider: 'generic', url: updateFeedUrl(this.hubUrl), useMultipleRangeRequest: false });
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.logger = {
      info: (m: unknown) => log(`updater: ${String(m)}`),
      warn: (m: unknown) => log(`updater warn: ${String(m)}`),
      error: (m: unknown) => log(`updater error: ${String(m)}`),
      debug: () => {},
    };
    au.on('update-downloaded', info => {
      log(`updater: ${info.version} downloaded`);
      this.ready = true;
      this.onReadyChanged();
    });
    au.on('error', e => log(`updater error: ${updateErrorText(e)}`));
    this.timer = setTimeout(() => {
      void this.check(false);
      this.timer = setInterval(() => void this.check(false), UPDATE_INTERVAL_MS);
    }, UPDATE_FIRST_CHECK_MS);
  }

  /**
   * Background (`manual = false`) or «Проверить обновления». A manual check while a background one runs awaits that
   * check and reports its result (A7 of the review); one that was skipped for lack of a session is run again.
   */
  async check(manual: boolean): Promise<void> {
    if (!app.isPackaged) {
      if (manual) void dialog.showMessageBox({ type: 'info', title: 'Agent Hub', message: dt('desktop.updates.notPackaged', { version: app.getVersion() }) });
      return;
    }
    if (!selfUpdateSupported) {
      if (manual) void dialog.showMessageBox({ type: 'info', title: 'Agent Hub', message: dt('desktop.updates.manualDownload', { version: app.getVersion() }) });
      return;
    }
    let r = await this.flight.run(() => this.runCheck(manual));
    if (manual && r.kind === 'skipped') r = await this.flight.run(() => this.runCheck(true));
    if (!manual || r.kind === 'skipped') return;
    const message = r.kind === 'error' ? manualCheckMessage(r) : manualCheckMessage(r.kind === 'available' ? r : { kind: 'latest', version: app.getVersion() });
    void dialog.showMessageBox({ type: r.kind === 'error' ? 'warning' : 'info', title: 'Agent Hub', message });
  }

  private async runCheck(manual: boolean): Promise<UpdateCheckResult> {
    try {
      const cookie = await this.getCookie();
      // The feed is behind the hub session (401 without it): a background check while signed out only adds noise.
      if (!cookie && !manual) {
        log('updater: signed out, background check skipped');
        return { kind: 'skipped' };
      }
      this.au.requestHeaders = updateRequestHeaders(cookie, this.userAgent);
      const r = await this.au.checkForUpdates();
      const latest = r?.updateInfo?.version;
      return r?.isUpdateAvailable && latest ? { kind: 'available', version: latest } : { kind: 'latest', version: app.getVersion() };
    } catch (e) {
      log(`updater check failed: ${updateErrorText(e)}`);
      return { kind: 'error', message: updateErrorText(e) };
    }
  }

  install(): void {
    if (!this.ready) return;
    // Silent (no NSIS pages) and start the app after the update (B3 of QA).
    this.au.quitAndInstall(true, true);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
