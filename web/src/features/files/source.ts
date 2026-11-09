/**
 * The source of the «Файлы» window and its root (change tool-windows-file-explorer). Pure functions: the store and the
 * components pass the state in.
 * Requirement (file-explorer): Окно «Файлы» и источники — the «Сессия · <проект>» chip follows the active session and
 * its root is the `cwd`; a machine chip has the home folder (`homeDir`) as the root; «↑» lifts the session root one
 * level but never above the home folder, and is off at the home folder and in the machine mode.
 * Requirement: Совместимость со старым агентом — a machine without `fs.browse` is shown with «Обновите агента»; without
 * `fs.download` (change file-download) the «Скачать» buttons are dimmed.
 */
import type { RunnerView, SessionView } from '../../api/types';
import { hubText } from '../../i18n';
import { usableRunner } from '../../store';
import { isInside, parentOf, samePath } from './paths';

export type SourceChoice = { kind: 'session' } | { kind: 'machine'; runnerId: string };

/** The first protocol version with the capability `fs.browse` (shared FILES_PROTOCOL). */
export const FILES_PROTOCOL_MINOR = 14;

/**
 * A machine that can list files. The hub decides by the capability; the web gets no capability list in RunnerView, so
 * it takes the protocol version of the last hello as a hint until the hub answers `capability_unavailable`
 * (`outdated` holds such machines). A machine whose version is unknown is tried.
 */
export function runnerSupportsFiles(r: Pick<RunnerView, 'id' | 'protocolVersion'>, outdated: Record<string, boolean> = {}): boolean {
  if (outdated[r.id]) return false;
  const m = /^(\d+)\.(\d+)/.exec(r.protocolVersion ?? '');
  if (!m) return true;
  const major = Number(m[1]);
  return major > 1 || (major === 1 && Number(m[2]) >= FILES_PROTOCOL_MINOR);
}

/** The first protocol version with the capability `fs.download` (shared DOWNLOAD_PROTOCOL, change file-download). */
export const DOWNLOAD_PROTOCOL_MINOR = 16;

/** A machine that can give a file for download; the same hint by version as `runnerSupportsFiles`. */
export function runnerSupportsDownload(r: Pick<RunnerView, 'id' | 'protocolVersion'>, outdated: Record<string, boolean> = {}): boolean {
  if (!runnerSupportsFiles(r, outdated)) return false;
  const m = /^(\d+)\.(\d+)/.exec(r.protocolVersion ?? '');
  if (!m) return true;
  const major = Number(m[1]);
  return major > 1 || (major === 1 && Number(m[2]) >= DOWNLOAD_PROTOCOL_MINOR);
}

export interface Source {
  /** Expanded folders, the selection and the lifted root are kept by this key. */
  key: string;
  mode: 'session' | 'machine';
  runnerId: string;
  sessionId?: string;
  machineName: string;
  /** The project name for the chip «Сессия · <проект>». */
  projectName?: string;
  /** Home folder of the machine. */
  home: string | null;
  /** The root before «↑»: the cwd of the session or the home folder. */
  base: string | null;
  /** The root of the tree. */
  root: string | null;
  /** Where «↑» goes; null — «↑» is off. */
  up: string | null;
  online: boolean;
  supported: boolean;
  /** The agent can give files for download (`fs.download`). */
  download: boolean;
}

export interface SourceInput {
  choice: SourceChoice;
  /** The last active session of the window; null — none. */
  sessionId: string | null;
  sessions: Record<string, SessionView>;
  runners: RunnerView[];
  /** Roots lifted by «↑», by source key. */
  rootUp: Record<string, string>;
  outdated: Record<string, boolean>;
}

export const sessionSourceKey = (sessionId: string) => `session:${sessionId}`;
export const machineSourceKey = (runnerId: string) => `machine:${runnerId}`;

export function projectNameOf(s: SessionView): string {
  return s.catalogProject?.name ?? hubText(s.project.title, s.project.i18n);
}

/** The machine chip to select when there is no session: the first online machine that can show files, else the first. */
export function defaultMachine(runners: RunnerView[], outdated: Record<string, boolean>): RunnerView | null {
  const list = runners.filter(usableRunner);
  return list.find(r => r.online && runnerSupportsFiles(r, outdated)) ?? list.find(r => r.online) ?? list[0] ?? null;
}

function machineSource(r: RunnerView, outdated: Record<string, boolean>): Source {
  const home = r.homeDir ?? null;
  return {
    key: machineSourceKey(r.id),
    mode: 'machine',
    runnerId: r.id,
    machineName: r.name,
    home,
    base: home,
    root: home,
    up: null,
    online: r.online,
    supported: runnerSupportsFiles(r, outdated),
    download: runnerSupportsDownload(r, outdated),
  };
}

/** Where «↑» leads from `root`: one level up, never above the home folder; null at the home folder and outside it. */
export function upFrom(root: string | null, home: string | null): string | null {
  if (!root || !home) return null;
  if (!isInside(home, root) || samePath(root, home)) return null;
  return parentOf(root);
}

export function resolveSource(input: SourceInput): Source | null {
  const { choice, sessionId, sessions, runners, rootUp, outdated } = input;
  const byId = (id: string) => runners.find(r => r.id === id);
  if (choice.kind === 'session') {
    const s = sessionId ? sessions[sessionId] : undefined;
    const r = s ? byId(s.runnerId) : undefined;
    if (s && r) {
      const key = sessionSourceKey(s.id);
      const home = r.homeDir ?? null;
      const base = s.cwd ?? null;
      const root = rootUp[key] ?? base;
      return {
        key,
        mode: 'session',
        runnerId: r.id,
        sessionId: s.id,
        machineName: r.name,
        projectName: projectNameOf(s),
        home,
        base,
        root,
        up: upFrom(root, home),
        online: r.online,
        supported: runnerSupportsFiles(r, outdated),
        download: runnerSupportsDownload(r, outdated),
      };
    }
  } else {
    const r = byId(choice.runnerId);
    if (r) return machineSource(r, outdated);
  }
  // no active session (or the chosen machine is gone): the first available machine
  const fallback = defaultMachine(runners, outdated);
  return fallback ? machineSource(fallback, outdated) : null;
}
