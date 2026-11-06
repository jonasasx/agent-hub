/**
 * The «Файлы» tool window: source chips, the root line and the tree (change tool-windows-file-explorer, tasks 6.2/6.3).
 * Markup after docs/prototypes/file-explorer.html (`filesPanel`). The host registers it under the window id `files`.
 * Requirement (file-explorer): Окно «Файлы» и источники.
 */
import { useEffect, useState } from 'react';
import { FileIcon, ICON_REFRESH, ICON_UP } from './fileIcons';
import { FileTree } from './FileTree';
import { useFiles } from './filesStore';
import { useT } from '../../i18n';
import { ancestorsOf, baseName, isInside, samePath } from './paths';
import { SourceChips } from './SourceChips';
import { useSource } from './useSource';

export function FilesWindow() {
  const t = useT();
  const src = useSource();
  const hidden = useFiles(s => s.hidden);
  const reveal = useFiles(s => s.reveal);
  const [flash, setFlash] = useState<string | null>(null);

  // «Показать в дереве» and the crumbs: open the way to the path, select it, flash it
  useEffect(() => {
    if (!reveal) return;
    const f = useFiles.getState();
    const target = src;
    if (!target || target.runnerId !== reveal.runnerId || !target.root || !isInside(target.root, reveal.path)) {
      f.setChoice({ kind: 'machine', runnerId: reveal.runnerId });
      return;
    }
    const chain = ancestorsOf(target.root, reveal.path);
    f.setExpanded(target, reveal.dir ? [...chain, reveal.path] : chain);
    f.select(target, reveal.path);
    setFlash(reveal.path);
    const timer = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(timer);
    // the effect follows the request and the source it resolves to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, src?.key, src?.root]);

  if (!src) {
    return (
      <div className="fx-panel">
        <div className="fx-fp">
          <SourceChips src={null} />
        </div>
        <div className="fx-tree">
          <div className="fx-state" role="status">
            <div className="big">{t('files.window.noMachines')}</div>
            <div className="muted">{t('files.window.noMachinesHint')}</div>
          </div>
        </div>
      </div>
    );
  }

  const atHome = !!src.root && !!src.home && samePath(src.root, src.home);
  const name = !src.root || atHome ? t('files.window.homeNamed', { machine: src.machineName }) : baseName(src.root);
  return (
    <div className="fx-panel">
      <div className="fx-fp">
        <SourceChips src={src} />
        <div className="fx-root">
          <FileIcon kind="dir" open />
          <div className="grow">
            <span className="rname">{name}</span>
            <span className="rsub" title={src.root ?? ''}>
              &lrm;{src.root ?? ''}&lrm;
            </span>
          </div>
          <button
            type="button"
            className="btn sm ghost"
            title={src.up ? t('files.window.upTitle', { path: src.up }) : t('files.window.upDisabled')}
            aria-label={t('files.window.upLabel')}
            disabled={!src.up}
            aria-disabled={!src.up}
            onClick={() => src.up && useFiles.getState().liftRoot(src)}
          >
            {ICON_UP} {t('files.window.up')}
          </button>
          <button
            type="button"
            className={`btn sm ghost icon fx-hid${hidden ? ' on' : ''}`}
            aria-pressed={hidden}
            title={t('files.window.hidden')}
            aria-label={t('files.window.hidden')}
            onClick={() => useFiles.getState().setHidden(!hidden)}
          >
            .*
          </button>
          <button type="button" className="btn sm ghost icon" title={t('files.window.refresh')} aria-label={t('files.window.refresh')} onClick={() => useFiles.getState().refresh(src)}>
            {ICON_REFRESH}
          </button>
        </div>
      </div>
      <FileTree src={src} flash={flash} />
    </div>
  );
}
