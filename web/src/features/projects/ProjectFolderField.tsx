import { useState } from 'react';
import { normalizeProjectFolder, platformOfHome, projectDir, relativeFolder } from '@agent-hub/shared';
import type { RunnerView } from '../../api/types';
import { useT } from '../../i18n';
import { FolderPicker } from '../newSession/FolderPicker';

/** The start folder of a session on `runner`: its default folder plus the project folder; null — unknown or invalid. */
export function startFolder(runner: RunnerView | undefined, folder: string | null | undefined): string | null {
  const base = runner?.defaultDir ?? runner?.homeDir;
  if (!base) return null;
  try {
    return projectDir(base, normalizeProjectFolder(folder ?? ''), platformOfHome(base) === 'windows');
  } catch {
    return null;
  }
}

/** The project folder is invalid: absolute, with «.» or «..», a forbidden character (shared/src/folders.ts). */
export function folderInvalid(folder: string): boolean {
  try {
    normalizeProjectFolder(folder);
    return false;
  } catch {
    return true;
  }
}

/**
 * session-folder D7: the folder of a project relative to the default folder of a machine. The picker opens on `runner`
 * rooted at its default folder and returns the relative path; the hint shows where a session starts on that machine.
 */
export function ProjectFolderField({ id, value, runner, error, onChange }: { id: string; value: string; runner: RunnerView | undefined; error?: string; onChange: (folder: string) => void }) {
  const tr = useT();
  const [picking, setPicking] = useState(false);
  const root = runner?.defaultDir ?? runner?.homeDir ?? '';
  const windows = platformOfHome(root) === 'windows';
  const invalid = folderInvalid(value);
  const start = invalid ? null : startFolder(runner, value);
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{tr('projects.folder.label')}</label>
      <div className="folder-path-row">
        <input
          id={id}
          className="input mono"
          value={value}
          placeholder={tr('projects.folder.placeholder')}
          aria-invalid={invalid || !!error}
          aria-describedby={hintId}
          onChange={event => onChange(event.target.value)}
        />
        <button type="button" className="btn" disabled={!runner?.online || !root} onClick={() => setPicking(true)}>
          {tr('projects.folder.choose')}
        </button>
        {value && (
          <button type="button" className="btn" onClick={() => onChange('')}>
            {tr('projects.folder.reset')}
          </button>
        )}
      </div>
      {invalid || error ? (
        <span className="field-error" id={hintId} role="alert">
          {error ?? tr('projects.folder.invalid')}
        </span>
      ) : (
        <span className="hint" id={hintId}>
          {runner && start ? tr('projects.folder.startsIn', { machine: runner.name, path: start }) : tr('projects.folder.noMachine')}
        </span>
      )}
      {picking && runner && root && (
        <FolderPicker runnerId={runner.id} root={root} initialPath={start ?? root} onChoose={path => onChange(relativeFolder(root, path, windows) ?? '')} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}
