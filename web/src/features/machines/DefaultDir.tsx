/**
 * session-folder D2: the default folder of a machine — sessions start there unless the project names its own folder
 * under it. Chosen in the enrollment wizard after the agent connects and changed from the machine menu; the picker is
 * not rooted (any folder of the machine), the hub checks it on the machine (PATCH /api/runners/:id {defaultDir}).
 */
import { useState } from 'react';
import type { RunnerView } from '../../api/types';
import { api } from '../../api/client';
import { t, useT } from '../../i18n';
import { useStore } from '../../store';
import { FolderPicker } from '../newSession/FolderPicker';

/** Saves the default folder; the reply goes to the store, a failure becomes a toast with the hub's text. */
export async function saveDefaultDir(runnerId: string, path: string): Promise<boolean> {
  try {
    useStore.getState().upsertRunner(await api.setDefaultDir(runnerId, path));
    return true;
  } catch (error) {
    useStore.getState().pushToast({ title: t('machines.defaultDir.failed'), text: error instanceof Error ? error.message : '' });
    return false;
  }
}

/** The picker of the default folder, opened at the current one. */
export function DefaultDirPicker({ runner, onClose }: { runner: RunnerView; onClose: () => void }) {
  return <FolderPicker runnerId={runner.id} initialPath={runner.defaultDir ?? runner.homeDir ?? ''} onChoose={path => void saveDefaultDir(runner.id, path)} onClose={onClose} />;
}

/**
 * The block of the wizard: the current default folder and «Изменить…». The wizard passes its enrollment snapshot of the
 * machine, the saved folder lands in the store's runners — so the store's copy wins when there is one.
 */
export function DefaultDirField({ runner: snapshot }: { runner: RunnerView }) {
  const tr = useT();
  const [picking, setPicking] = useState(false);
  const runner = useStore(s => s.runners.find(r => r.id === snapshot.id)) ?? snapshot;
  const current = runner.defaultDir ?? runner.homeDir ?? '';
  return (
    <div className="field" data-testid="default-dir">
      <span className="label">{tr('machines.defaultDir.label')}</span>
      <div className="folder-path-row">
        <code className="mono">{current}</code>
        <button type="button" className="btn" disabled={!runner.online} onClick={() => setPicking(true)}>
          {tr('machines.defaultDir.change')}
        </button>
      </div>
      <span className="hint">{tr('machines.defaultDir.hint')}</span>
      {picking && <DefaultDirPicker runner={runner} onClose={() => setPicking(false)} />}
    </div>
  );
}
