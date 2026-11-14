/** Platform differences of the main process (change desktop-platforms, design D7). */
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/** Icon format: .ico on Windows, .png (with @2x variants picked by Electron) elsewhere. */
const ICON_EXT = isWin ? 'ico' : 'png';

export const appIconFile = `app.${ICON_EXT}`;
export const trayIconFile = (name: string): string => `${name}.${ICON_EXT}`;

/** Electron has no login item on Linux. */
export const autostartSupported = !isLinux;

/** electron-updater replaces the app on Windows and the AppImage file on Linux; the unsigned macOS app is not updated. */
export const selfUpdateSupported = isWin || (isLinux && Boolean(process.env.APPIMAGE));
