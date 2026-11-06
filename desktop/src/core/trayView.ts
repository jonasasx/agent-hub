/**
 * What the tray and the taskbar button show (design D5). Requirements: Счётчик ждущих сессий в трее; Меню трея.
 */
import type { HubConnState } from './hubClient.js';
import { dt } from './i18n.js';

export type TrayIconName = `tray-${number}` | 'tray-9plus' | 'tray-offline' | 'tray-signedout';

export interface TrayView {
  icon: TrayIconName;
  tooltip: string;
  /** Icon of the taskbar overlay, null — no overlay. */
  overlay: TrayIconName | null;
  overlayText: string;
}

export function countIcon(count: number): TrayIconName {
  if (count <= 0) return 'tray-0';
  if (count > 9) return 'tray-9plus';
  return `tray-${Math.floor(count)}`;
}

/** `windowOffline` — the window shows «Нет связи» (page failed to load) even if the socket is still up. */
export function trayView(state: HubConnState, count: number, windowOffline = false): TrayView {
  if (state === 'signed_out') return { icon: 'tray-signedout', tooltip: dt('desktop.tray.signedOut'), overlay: null, overlayText: '' };
  if (state === 'offline' || windowOffline) return { icon: 'tray-offline', tooltip: dt('desktop.tray.offline'), overlay: null, overlayText: '' };
  if (state === 'connecting') return { icon: 'tray-0', tooltip: dt('desktop.tray.connecting'), overlay: null, overlayText: '' };
  const n = Math.max(0, count);
  return { icon: countIcon(n), tooltip: dt('desktop.tray.waiting', { count: n }), overlay: n > 0 ? countIcon(n) : null, overlayText: n > 0 ? dt('desktop.tray.waitingBadge', { count: n }) : '' };
}

/**
 * Tray click / hotkey: hide when the window is visible and focused, otherwise show. A click on the tray takes the
 * focus from the window just before the click event on Windows, so a blur within `graceMs` still counts as focused.
 */
export function shouldHideOnToggle(w: { visible: boolean; minimized: boolean; focused: boolean; msSinceBlur: number }, graceMs = 400): boolean {
  if (!w.visible || w.minimized) return false;
  return w.focused || w.msSinceBlur < graceMs;
}

/** Tray context menu state (Requirement: Меню трея). */
export interface TrayMenuState {
  version: string;
  windowVisible: boolean;
  signedOut: boolean;
  hotkey: string | null;
  hotkeyRegistered: boolean;
  autostart: boolean;
  updateReady: boolean;
  /** The language of the menu: a change rebuilds it. */
  locale?: string;
}

/** Deep-equality key of the menu state (flat object of primitives, fixed key order). */
export function menuStateKey(m: TrayMenuState): string {
  return JSON.stringify([m.version, m.windowVisible, m.signedOut, m.hotkey, m.hotkeyRegistered, m.autostart, m.updateReady, m.locale]);
}

/** After a successful exchange the socket reconnects with the new cookie within ~1 s; until then it may still say signed_out. */
export const SIGN_IN_GRACE_MS = 5_000;

/**
 * State shown by the tray (A6 of the review): while an exchange runs, and shortly after it succeeded, a `signed_out`
 * of the socket is the old session being closed (4401), not a sign-out — show «подключение» instead of flashing
 * «нужен вход».
 */
export function displayConnState(state: HubConnState, sign: { exchanging: boolean; msSinceSignIn: number }): HubConnState {
  if (state !== 'signed_out') return state;
  return sign.exchanging || sign.msSinceSignIn < SIGN_IN_GRACE_MS ? 'connecting' : state;
}
