/**
 * The window of «Открыть оригинал» (change image-viewer, design D4). Requirement (image-viewer): Окно оригинала в
 * десктоп-приложении — a picture of the hub opens in a window of its own with the frame of the OS, Esc closes it, the
 * main window stays on the hub. The picture is shown by Chromium's own image viewer.
 */
import { BrowserWindow, nativeImage, screen, shell } from 'electron';
import { join } from 'node:path';
import { dt } from '../core/i18n.js';
import { decideNavigation } from '../core/navigation.js';
import { log } from './files.js';
import { appIconFile } from './platform.js';
import { PARTITION } from './window.js';

const WIDTH = 1000;
const HEIGHT = 750;

/** One window per address: «Открыть оригинал» of the same picture again brings the open window forward. */
const open = new Map<string, BrowserWindow>();

export function openImageWindow(url: string, hubOrigin: string, assetsDir: string): void {
  const existing = open.get(url);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    width: Math.min(WIDTH, area.width),
    height: Math.min(HEIGHT, area.height),
    title: dt('desktop.imageWindow.title'),
    icon: nativeImage.createFromPath(join(assetsDir, appIconFile)),
    autoHideMenuBar: true,
    backgroundColor: '#0e0e0e',
    webPreferences: {
      // the same storage as the main window: the hub's cookie lets `/api/blobs` through
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      devTools: process.env.AGENTHUB_DEVTOOLS === '1',
    },
  });
  win.setMenu(null);
  open.set(url, win);
  win.on('closed', () => {
    if (open.get(url) === win) open.delete(url);
  });
  // the image viewer names the window after the file; keep the app's name
  win.on('page-title-updated', e => e.preventDefault());

  const wc = win.webContents;
  // the window shows only this picture: links of the hub stay in the main window, external ones go to the browser
  const guard = (e: { preventDefault(): void }, target: string) => {
    if (target === url) return;
    e.preventDefault();
    const d = decideNavigation(target, hubOrigin);
    if (d.kind === 'external') void shell.openExternal(d.url);
    else log(`image window navigation denied: ${target.slice(0, 200)}`);
  };
  wc.on('will-navigate', e => guard(e, e.url));
  wc.on('will-redirect', e => guard(e, e.url));
  wc.setWindowOpenHandler(({ url: target }) => {
    const d = decideNavigation(target, hubOrigin);
    if (d.kind === 'external') void shell.openExternal(d.url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      e.preventDefault();
      win.close();
    }
  });
  void win.loadURL(url);
}
