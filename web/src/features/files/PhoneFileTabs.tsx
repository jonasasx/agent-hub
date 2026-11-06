/**
 * The group «Файлы» of the phone list «Сессии» (change tool-windows-file-explorer, task 7.2): the open file tabs next to
 * the sessions; a tap opens the file full screen (the title of the top bar is the file name, «←» goes back).
 * The «Сессии» window mounts it under its own groups; it renders nothing when no file is open.
 * Requirements: tool-windows «Узкое окно и телефон»; file-explorer «Файлы на телефоне».
 */
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { isFileTab, parseFileTabId } from '../layout/layout';
import { activateTab, closeTab } from '../workspace/actions';
import { FileIcon, nameKind } from './fileIcons';
import { useFiles } from './filesStore';
import { baseName, parentOf } from './paths';

export function PhoneFileTabs() {
  const t = useT();
  const ws = useStore(s => s.ws);
  const runners = useStore(s => s.runners);
  const pinned = useFiles(s => s.pinned);
  const rows: Array<{ id: string; pane: string; runnerId: string; path: string }> = [];
  for (const pane of Object.values(ws.panes)) {
    for (const id of pane.tabs) {
      const ref = isFileTab(id) ? parseFileTabId(id) : null;
      if (ref) rows.push({ id, pane: pane.id, ...ref });
    }
  }
  if (!rows.length) return null;
  return (
    <section className="fx-ph-files" aria-label={t('files.title')}>
      <h4>
        <span>{t('files.title')}</span>
        <span className="cnt">{rows.length}</span>
      </h4>
      {rows.map(r => {
        const machine = runners.find(x => x.id === r.runnerId)?.name ?? r.runnerId;
        const folder = baseName(parentOf(r.path) ?? '');
        return (
          <div key={r.id} className="fx-ph-row">
            <button type="button" className={`fx-ph-open${pinned.includes(r.id) ? '' : ' preview'}`} onClick={() => activateTab(r.pane, r.id)}>
              <FileIcon kind={nameKind(baseName(r.path))} />
              <span className="tx">
                <span className="nm">{baseName(r.path)}</span>
                <small>{folder ? `${machine} · ${folder}` : machine}</small>
              </span>
            </button>
            <button type="button" className="fx-ph-x" aria-label={t('files.phone.close', { name: baseName(r.path) })} onClick={() => closeTab(r.id)}>
              ×
            </button>
          </div>
        );
      })}
    </section>
  );
}
