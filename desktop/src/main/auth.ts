/**
 * Sign-in through the system browser (design D9, D10). Requirements: Приём кода приложением; Сессия приложения,
 * выход и истечение. The verifier and state live only in memory (PendingLoginStore).
 */
import { shell, type Session } from 'electron';
import { exchangeCode, exchangeErrorText, logoutPreviousSession, sessionCookie } from '../core/exchange.js';
import { loginErrorPage, loginPendingPage, signInPage } from '../core/pages.js';
import { PendingLoginStore, startUrl } from '../core/pkce.js';
import { log } from './files.js';
import { readSessionCookie } from './hubConnection.js';
import type { AppWindow } from './window.js';

export class DesktopAuth {
  private readonly pending = new PendingLoginStore();
  private exchangingCount = 0;
  /** Time of the last successful sign-in (ms), 0 — none. */
  signedInAt = 0;

  constructor(
    private readonly hubUrl: string,
    private readonly userAgent: string,
    private readonly session: Session,
    private readonly window: () => AppWindow,
    /** Called when an exchange starts and ends (the tray hides a transient `signed_out` meanwhile). */
    private readonly onExchangingChanged: () => void = () => {},
  ) {}

  /**
   * An exchange is in progress: ending the previous session closes the app's socket with 4401 for a moment before the
   * new cookie is stored — the tray must not flash «нужен вход» (A6 of the review).
   */
  get exchanging(): boolean {
    return this.exchangingCount > 0;
  }

  /** «Войти»: opens `/auth/desktop/start` in the system browser and shows «Вход в системном браузере». */
  start(returnPath: string): void {
    const p = this.pending.begin(returnPath);
    log('sign-in started in the system browser');
    void shell.openExternal(startUrl(this.hubUrl, p));
    this.window().showPage(loginPendingPage(this.hubUrl, returnPath));
  }

  /**
   * The page went to `/auth/login`. With the window on screen — start the sign-in; with the window hidden (autostart
   * with an expired session) — do not pop a browser by itself, show «Нужен вход» and wait for «Войти».
   */
  onLoginRequested(returnPath: string, windowVisible: boolean): void {
    if (windowVisible) this.start(returnPath);
    else this.window().showPage(signInPage(this.hubUrl, returnPath));
  }

  showSignIn(returnPath: string): void {
    this.window().showPage(signInPage(this.hubUrl, returnPath));
  }

  /** `agenthub://auth?code&state`: a link with an unknown state is dropped without a request to the hub. */
  async onAuthLink(code: string, state: string): Promise<void> {
    const p = this.pending.take(state);
    if (!p) {
      log('auth link ignored: no pending sign-in with this state');
      return;
    }
    this.exchangingCount++;
    this.onExchangingChanged();
    try {
      await this.finishSignIn(code, state, p);
    } finally {
      this.exchangingCount--;
      this.onExchangingChanged();
    }
  }

  private async finishSignIn(code: string, state: string, p: { verifier: string; returnPath: string }): Promise<void> {
    const r = await exchangeCode((url, init) => fetch(url, init), this.hubUrl, this.userAgent, { code, codeVerifier: p.verifier, state });
    const w = this.window();
    w.show();
    if (!r.ok) {
      log(`exchange failed: ${r.error} (${r.status})`);
      w.showPage(loginErrorPage(this.hubUrl, p.returnPath, exchangeErrorText(r)));
      return;
    }
    const old = await readSessionCookie(this.session, this.hubUrl).catch(() => null);
    if (old && old !== r.sessionToken) {
      const st = await logoutPreviousSession((url, init) => fetch(url, init), this.hubUrl, this.userAgent, old);
      log(`previous session logged out (${st})`);
    }
    await this.session.cookies.set(sessionCookie(this.hubUrl, r.sessionToken, r.expiresAt));
    await this.session.cookies.flushStore();
    this.signedInAt = Date.now();
    log('signed in, session cookie stored');
    w.openHubPath(p.returnPath);
  }
}
