/**
 * The column of open windows at a side (docs/prototypes/tool-windows.html dock): the windows one under another, the line
 * between them changes the heights, a slot with several windows shows the active one (the others are switched on the
 * rail). The inner edge is the
 * width handle. A side without an open window has no column.
 */
import { useSyncExternalStore, type PointerEvent, type ReactNode } from 'react';
import { SideResizer } from '../sidebar/SideResizer';
import { fitWidths } from '../sidebar/sideWidth';
import { WIN_TITLE, openSlots, sideOpen, type Side, type WinId } from './dock';
import { beginDrag } from './drag';
import { SlotSplitter } from './SlotSplitter';
import { WindowMenu } from './WindowMenu';
import { WINDOWS } from './windows';
import { useDock } from './useDock';
import { useT } from '../../i18n';

const viewport = () => window.innerWidth;
function onResize(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
export const useViewportWidth = () => useSyncExternalStore(onResize, viewport, () => 1280);

function Header({ id }: { id: WinId }) {
  useT();
  const def = WINDOWS[id];
  const grab = (e: PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('.tw-hbtn')) return;
    beginDrag(id, e);
  };
  return (
    <div className="tw-head" data-drag={id} onPointerDown={grab}>
      <span className="tw-title">{def.title}</span>
      {def.actions().map(a => (
        <button key={a.title} type="button" className="tw-hbtn" title={a.title} aria-label={a.title} onClick={a.run}>
          {a.icon}
        </button>
      ))}
      <WindowMenu id={id} />
    </div>
  );
}

export function Column({ side }: { side: Side }) {
  const t = useT();
  const dock = useDock(s => s.dock);
  const vw = useViewportWidth();
  const open = openSlots(dock, side);
  if (!open.length) return null;
  const width = fitWidths(dock.width, { left: sideOpen(dock, 'left'), right: sideOpen(dock, 'right') }, vw)[side];
  // fit windows take their content, the others share the rest; a slot with a hand-set height keeps it
  const flex = open.map(({ id, slot }) => (slot.h ? { grow: 0, basis: `${slot.h}px` } : WINDOWS[id].fit ? { grow: 0, basis: 'auto' } : { grow: 1, basis: '150px' }));
  if (!flex.some(f => f.grow)) flex[flex.length - 1]!.grow = 1;
  const out: ReactNode[] = [];
  open.forEach(({ id, si, slot }, k) => {
    const prev = open[k - 1];
    if (prev) out.push(<SlotSplitter key={`vs-${si}`} side={side} a={prev.si} b={si} idA={prev.id} idB={id} />);
    const { Body } = WINDOWS[id];
    out.push(
      <section
        key={id}
        className={`tw-pnl${WINDOWS[id].fit ? ' fit' : ''}`}
        data-id={id}
        data-side={side}
        data-si={si}
        role={slot.ids.length > 1 ? 'group' : undefined}
        aria-label={slot.ids.length > 1 ? t('workspace.toolwindows.place', { title: WIN_TITLE[id], all: slot.ids.map(o => WIN_TITLE[o]).join(', ') }) : WIN_TITLE[id]}
        style={{ flex: `${flex[k]!.grow} 1 ${flex[k]!.basis}` }}
      >
        <Header id={id} />
        <div className="tw-body">
          <Body />
        </div>
      </section>,
    );
  });
  return (
    <div className={`tw-col${side === 'right' ? ' right' : ''}`} data-side={side} style={{ width }}>
      {out}
      <SideResizer side={side} />
    </div>
  );
}
