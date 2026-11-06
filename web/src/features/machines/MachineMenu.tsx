/**
 * A machine chip of the «Машины» window and its menu (docs/prototypes/tool-windows.html: .mch, machMenu): the name, the
 * dot of the state and a short note; a click opens the menu with the machine's actions. An offline machine keeps the
 * entries that need it dimmed (aria-disabled), the other ones work.
 */
import { useState } from 'react';
import type { RunnerView } from '../../api/types';
import { useStore } from '../../store';
import { menuIcon, type MachineMenuIcon } from '../toolwindows/icons';
import { menuKeys, usePopupMenu } from '../toolwindows/useFlipMenu';
import { openToolWindow } from '../toolwindows/open';
import { openFilesForMachine } from '../files/open';
import { openMachineSettings } from './actions';
import { useMachineFilter } from './machineFilter';
import { MARK_TEXT, agentMark, runnerStatusText, runnerTooltip } from './runnerInfo';

export const dotOf = (r: RunnerView): 'ok' | 'warn' | 'bad' => (r.online ? 'ok' : r.incompatible ? 'warn' : 'bad');

/** What the chip says after the name: «не в сети», «агент устарел», «обновляется»; empty — nothing. */
export function chipNote(r: RunnerView): { text: string; upd: boolean } | null {
  if (!r.online) return { text: runnerStatusText(r), upd: false };
  const mark = agentMark(r);
  return mark ? { text: MARK_TEXT[mark], upd: mark === 'updating' } : null;
}

function info(r: RunnerView): string {
  const tip = runnerTooltip(r);
  const mark = agentMark(r);
  return r.online ? `в сети · ${tip}${mark ? ` · ${MARK_TEXT[mark]}` : ''}` : tip;
}

interface Item {
  icon: MachineMenuIcon;
  text: string;
  needsOnline: boolean;
  run: (r: RunnerView) => void;
}

const ITEMS: Item[] = [
  { icon: 'new', text: 'Новая сессия', needsOnline: true, run: r => useStore.setState({ modal: { type: 'new', runnerId: r.id } }) },
  { icon: 'files', text: 'Файлы машины', needsOnline: true, run: r => openFilesForMachine(r.id) },
  { icon: 'mcp', text: 'MCP-серверы', needsOnline: true, run: r => openMachineSettings(r.id) },
  {
    icon: 'sess',
    text: 'Сессии машины',
    needsOnline: false,
    run: r => {
      useMachineFilter.getState().set(r.id);
      openToolWindow('sessions');
    },
  },
];

export function MachineChip({ r }: { r: RunnerView }) {
  const [open, setOpen] = useState(false);
  const { box, trigger, menu } = usePopupMenu(open, () => setOpen(false));
  const note = chipNote(r);
  const dot = dotOf(r);
  const act = (item: Pick<Item, 'needsOnline' | 'run'>) => {
    if (item.needsOnline && !r.online) return;
    setOpen(false);
    item.run(r);
  };
  const entry = (item: Item) => {
    const dis = item.needsOnline && !r.online;
    return (
      <button key={item.icon} type="button" role="menuitem" className={dis ? 'dis' : undefined} aria-disabled={dis || undefined} onClick={() => act(item)}>
        <span className="tw-mi">{menuIcon(item.icon)}</span>
        {item.text}
      </button>
    );
  };
  return (
    <span ref={box} className="tw-pop">
      <button
        ref={trigger}
        type="button"
        className={`tw-mch${open ? ' on' : ''}${r.online ? '' : ' off'}`}
        title={runnerTooltip(r)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${r.name}${note ? `: ${note.text}` : ''}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`tw-st ${dot}`} aria-hidden="true" />
        {r.name}
        {note && <span className={`tw-nt${note.upd ? ' upd' : ''}`}> · {note.text}</span>}
      </button>
      {open && (
        <div ref={menu} className="tw-menu" role="menu" aria-label={`Машина ${r.name}`} onKeyDown={menuKeys}>
          <div className="tw-mh">
            <b>{r.name}</b>
            {info(r)}
          </div>
          {ITEMS.map(entry)}
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              act({
                needsOnline: false,
                run: x => openMachineSettings(x.id),
              })
            }
          >
            <span className="tw-mi">{menuIcon('cfg')}</span>
            Настройки машины
          </button>
        </div>
      )}
    </span>
  );
}
