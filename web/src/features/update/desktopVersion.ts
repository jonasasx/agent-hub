/**
 * Version of the desktop app from the page's user-agent (design D7, fact of task 1.1): Electron writes
 * `AgentHub/<version>` before `Chrome/`. No `Electron/` or no token — not the app: no «Приложение» row.
 */
export function desktopVersion(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string | null {
  if (!/\bElectron\//.test(ua)) return null;
  const m = /\bAgentHub\/(\d+\.\d+\.\d+)\b/.exec(ua);
  return m ? m[1]! : null;
}
