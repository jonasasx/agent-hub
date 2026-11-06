import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { t, useT } from '../../i18n';
import { useDialog } from '../ui/a11y';

type Listing = Awaited<ReturnType<typeof api.runnerDirectories>>;

export function directoryBreadcrumbs(path: string): { label: string; target: string }[] {
  const win = /^([A-Za-z]:)[\\/](.*)$/.exec(path);
  const root = win ? `${win[1]}\\` : '/';
  const parts = win ? win[2]!.split(/[\\/]+/).filter(Boolean) : path.split('/').filter(Boolean);
  const result = [{ label: win ? win[1]! : '/', target: root }];
  const accumulated: string[] = [];
  for (const part of parts) {
    accumulated.push(part);
    result.push({ label: part, target: win ? `${root}${accumulated.join('\\')}` : `/${accumulated.join('/')}` });
  }
  return result;
}

export function FolderPicker({ runnerId, initialPath, onChoose, onClose }: { runnerId: string; initialPath: string; onChoose: (path: string) => void; onClose: () => void }) {
  const tr = useT();
  const [listing, setListing] = useState<Listing | null>(null);
  const [path, setPath] = useState(initialPath);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  useDialog(dialog, onClose, firstAction);
  const load = useCallback(
    async (nextPath?: string, hidden = showHidden) => {
      setBusy(true);
      setError('');
      try {
        const result = await api.runnerDirectories(runnerId, nextPath, hidden);
        setListing(result);
        setPath(result.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : t('newSession.picker.openFailed'));
      } finally {
        setBusy(false);
      }
    },
    [runnerId, showHidden],
  );
  useEffect(() => {
    void load(initialPath || undefined, false);
    // The initial browse follows only the selected runner/path; navigation and hidden-toggle refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath, runnerId]);
  return createPortal(
    <div
      className="scrim"
      role="presentation"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section ref={dialog} data-own-escape className="modal folder-picker" role="dialog" aria-modal="true" aria-label={tr('newSession.picker.title')} onMouseDown={e => e.stopPropagation()}>
        <header className="modal-head">
          <b>{tr('newSession.picker.title')}</b>
          <button ref={firstAction} type="button" className="icon-btn" aria-label={tr('newSession.picker.close')} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <nav className="folder-crumbs" aria-label={tr('newSession.picker.path')}>
            {listing &&
              directoryBreadcrumbs(listing.path).map(({ label, target }, i) => {
                return (
                  <button type="button" key={`${label}-${i}`} onClick={() => void load(target)}>
                    {label}
                  </button>
                );
              })}
          </nav>
          <label className="folder-hidden">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={e => {
                setShowHidden(e.target.checked);
                void load(path || undefined, e.target.checked);
              }}
            />{' '}
            {tr('newSession.picker.hidden')}
          </label>
          {error && (
            <div className="banner" role="alert">
              {tr('newSession.picker.manual', { error })}
            </div>
          )}
          <div className="folder-list" aria-busy={busy}>
            {busy ? (
              <span>{tr('newSession.picker.loading')}</span>
            ) : listing?.directories.length ? (
              listing.directories.map(dir => (
                <button type="button" className="folder-entry" key={dir.path} title={dir.path} onClick={() => void load(dir.path)}>
                  <span aria-hidden="true">📁</span>
                  {dir.name}
                </button>
              ))
            ) : !error ? (
              <span>{tr('newSession.picker.empty')}</span>
            ) : null}
          </div>
          <div className="folder-current">
            <span title={listing?.path ?? path}>{(listing?.path ?? path) || tr('newSession.picker.home')}</span>
            <button type="button" className="btn" disabled={!listing?.parent} onClick={() => listing?.parent && void load(listing.parent)}>
              {tr('newSession.picker.up')}
            </button>
          </div>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {tr('newSession.picker.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!listing || busy}
            onClick={() => {
              onChoose(listing!.path);
              onClose();
            }}
          >
            {tr('newSession.picker.chooseThis')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
