/**
 * Actions over an open file: «Показать в дереве», «@ В сообщение», copy the path (change tool-windows-file-explorer, task 6.6).
 * Requirement (file-explorer): Крошки и действия над файлом.
 */
import { t } from '../../i18n';
import { useStore } from '../../store';
import { activateTab } from '../workspace/actions';
import { lastActiveSession, useFiles } from './filesStore';
import { mentionText } from './paths';
import { openFilesWindow } from './toolWindowBridge';

/** «Показать в дереве»: the window comes back if hidden, expands the way to the path, selects and flashes it. */
export function revealInTree(runnerId: string, path: string, sessionId?: string, dir = false): void {
  useFiles.getState().requestReveal({ runnerId, sessionId, path, dir });
  openFilesWindow();
}

/** The session that «@ В сообщение» writes to: the last active session of the window; null — there is none. */
export function mentionTarget(): string | null {
  const st = useStore.getState();
  return lastActiveSession(st.ws, st.openedAt, st.tabKinds, st.sessions);
}

/**
 * «@ В сообщение»: appends `@<path below the cwd of the session>` (an absolute path outside it) to the draft of the last
 * active session with a space and does not send. Returns the inserted text; null when there is no session.
 */
export function insertMention(path: string): string | null {
  const sid = mentionTarget();
  if (!sid) return null;
  const st = useStore.getState();
  const session = st.sessions[sid];
  if (!session) return null;
  const text = mentionText(session.cwd ?? null, path);
  const cur = st.drafts[sid] ?? '';
  useStore.setState({ drafts: { ...st.drafts, [sid]: `${cur ? `${cur.trimEnd()} ` : ''}${text} ` } });
  const pane = Object.values(st.ws.panes).find(p => p.tabs.includes(sid));
  if (pane && !(st.ws.focus === pane.id && pane.active === sid)) activateTab(pane.id, sid);
  st.pushToast({ title: t('files.action.toMessage', { title: session.title }), text, color: 'var(--accent)' });
  return text;
}

export async function copyPath(path: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(path);
    useStore.getState().pushToast({ title: t('files.action.pathCopied'), text: path, color: 'var(--accent)' });
    return true;
  } catch {
    return false;
  }
}
