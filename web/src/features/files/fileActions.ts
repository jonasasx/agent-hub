/**
 * Actions over an open file: «Показать в дереве», «@ В сообщение», copy the path (change tool-windows-file-explorer, task 6.6),
 * «Скачать» (change file-download), a link of the feed to a file or a folder (change chat-folder-links).
 * Requirement (file-explorer): Крошки и действия над файлом; Скачивание файла; Ссылки на папки.
 */
import { t } from '../../i18n';
import { useStore } from '../../store';
import { activateTab, openFileTab } from '../workspace/actions';
import { FsError, fsDownloadProbe, fsDownloadUrl, fsList } from './filesApi';
import type { FileLink } from './links';
import { lastActiveSession, useFiles } from './filesStore';
import { baseName, mentionText } from './paths';
import { openFilesWindow } from './toolWindowBridge';

/** «Показать в дереве»: the window comes back if hidden, expands the way to the path, selects and flashes it. */
export function revealInTree(runnerId: string, path: string, sessionId?: string, dir = false): void {
  useFiles.getState().requestReveal({ runnerId, sessionId, path, dir });
  openFilesWindow();
}

/** How long the answer «a folder or a file» of a link is kept: a double click reuses the probe of the first click. */
export const LINK_PROBE_TTL_MS = 30_000;

const probes = new Map<string, Promise<boolean>>();

/** Whether the path is a folder: a listing of one level answers; any error (not a folder, missing, offline) is «a file». */
function isFolder(link: FileLink): Promise<boolean> {
  const key = `${link.runnerId}\n${link.path}`;
  const known = probes.get(key);
  if (known) return known;
  const probe = fsList(link.runnerId, { path: link.path, ...(link.sessionId ? { sessionId: link.sessionId } : {}) }).then(
    () => true,
    () => false,
  );
  probes.set(key, probe);
  setTimeout(() => probes.delete(key), LINK_PROBE_TTL_MS);
  return probe;
}

/** Forgets the probes of links (tests). */
export function resetLinkProbes(): void {
  probes.clear();
}

/**
 * A click on a link of the feed or a document: a folder is revealed in the tree as «В дереве», a file opens in the
 * viewer (a single click is a preview, a double click keeps the tab). A link that looks like neither asks the machine.
 */
export async function openFileLink(link: FileLink, pin: boolean): Promise<void> {
  const folder = link.kind === 'dir' || (link.kind === 'unknown' && (await isFolder(link)));
  if (folder) {
    revealInTree(link.runnerId, link.path, link.sessionId, true);
    return;
  }
  openFileTab(link.runnerId, link.path, { pin, ...(link.sessionId ? { sessionId: link.sessionId } : {}), ...(link.beside ? { beside: link.beside } : {}) });
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

/**
 * «Скачать»: asks the hub first (a refusal is a toast with its text — a navigation to a 4xx shows only «Сбой» in the
 * browser), then hands the download to the browser by a hidden link: it saves the file under its name.
 */
export async function downloadFile(runnerId: string, path: string, sessionId?: string): Promise<boolean> {
  try {
    const probe = await fsDownloadProbe(runnerId, path, sessionId);
    const a = document.createElement('a');
    a.href = fsDownloadUrl(runnerId, path, sessionId);
    a.download = probe.name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (e) {
    const err = e instanceof FsError ? e : new FsError('network');
    if (err.code === 'aborted') return false;
    useStore.getState().pushToast({ title: t('files.action.downloadFailed', { name: baseName(path) }), text: err.text('file'), color: 'var(--bad)' });
    return false;
  }
}
