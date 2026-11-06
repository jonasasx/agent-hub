/**
 * One-click entry into the file explorer (change tool-windows-file-explorer, task 6.7).
 * Requirement (file-explorer): Окно «Файлы» и источники — the path in the chat header and the machine row open the
 * window on the right source; a hidden window comes back.
 */
import { useStore } from '../../store';
import { activateTab } from '../workspace/actions';
import { useFiles } from './filesStore';
import { sessionSourceKey } from './source';
import { openFilesWindow } from './toolWindowBridge';

/** The machine's home folder in the window. */
export function openFilesForMachine(runnerId: string): void {
  useFiles.getState().setChoice({ kind: 'machine', runnerId });
  openFilesWindow();
}

/** The folder of a session: the session chip, rooted at its `cwd`. The session becomes the active one of its pane. */
export function openFilesForSession(sessionId: string): void {
  const { ws } = useStore.getState();
  const pane = Object.values(ws.panes).find(p => p.tabs.includes(sessionId));
  if (pane && !(ws.focus === pane.id && pane.active === sessionId)) activateTab(pane.id, sessionId);
  // rooted at the folder of the session again, not at a root lifted earlier by «↑»
  const rootUp = { ...useFiles.getState().rootUp };
  delete rootUp[sessionSourceKey(sessionId)];
  useFiles.setState({ rootUp, choice: { kind: 'session' } });
  openFilesWindow();
}
