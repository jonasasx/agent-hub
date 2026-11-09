/**
 * The scrolling tab strip of a pane and the list of all its tabs (spec tab-strip: Прокрутка полосы вкладок; Список всех
 * вкладок панели). The strip scrolls natively; the mouse wheel scrolls it sideways, the edges fade where tabs are hidden,
 * the active tab is scrolled into view. «▾ N» opens the list of the pane's tabs with a search, hidden ones first.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { parseFileTabId } from '../layout/layout';
import { FileIcon, nameKind } from '../files/fileIcons';
import { colorVar } from '../sessions/status';
import { menuKeys, usePopupMenu } from '../toolwindows/useFlipMenu';
import { activateTab } from './actions';
import { tabFileHint, tabTitle, useTabTitle } from './tabTitle';
import { useStore } from '../../store';
import { useT } from '../../i18n';

/** Room kept beside a tab scrolled into view, so it does not end under the fade of the edge. */
const EDGE_PAD = 24;
/** A wheel step in lines (Firefox `deltaMode` 1) is this many pixels. */
const LINE_PX = 40;

export type TabSide = 'left' | 'right' | null;

/** The tab elements of a strip by id. */
function tabEls(strip: HTMLElement): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>('[data-sid]')];
}

/** Where a tab is relative to the visible part of the strip: hidden (in part) behind the left or right edge, or on screen. */
export function tabSide(strip: HTMLElement, tab: HTMLElement): TabSide {
  const b = strip.getBoundingClientRect();
  const r = tab.getBoundingClientRect();
  if (r.left < b.left - 1) return 'left';
  if (r.right > b.right + 1) return 'right';
  return null;
}

/** Scrolls the strip just enough to show the whole tab. */
function reveal(strip: HTMLElement, tab: HTMLElement) {
  const side = tabSide(strip, tab);
  if (!side) return;
  const b = strip.getBoundingClientRect();
  const r = tab.getBoundingClientRect();
  if (side === 'left') strip.scrollLeft -= b.left - r.left + EDGE_PAD;
  else strip.scrollLeft += r.right - b.right + EDGE_PAD;
}

/** The visible part of the strip as fractions of its full width — the thumb of the custom scrollbar. */
export type StripEdge = { left: boolean; right: boolean; start: number; size: number };

const NO_EDGE: StripEdge = { left: false, right: false, start: 0, size: 1 };

/**
 * Scrolling of a pane's strip: `left`/`right` — tabs are hidden behind that edge (the fades and the «▾ N» button
 * follow them), `start`/`size` — the thumb. The wheel listener is native and not passive: React's `onWheel` is passive
 * and cannot stop the page.
 */
export function useTabStrip(strip: RefObject<HTMLDivElement | null>, tabs: readonly string[], active: string | null): StripEdge {
  const [edge, setEdge] = useState(NO_EDGE);
  const shown = tabs.length > 0;
  const update = useRef(() => {});
  update.current = () => {
    const el = strip.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next: StripEdge = {
      left: el.scrollLeft > 1,
      right: el.scrollLeft < max - 1,
      start: el.scrollWidth ? el.scrollLeft / el.scrollWidth : 0,
      size: el.scrollWidth ? Math.min(1, el.clientWidth / el.scrollWidth) : 1,
    };
    setEdge(e => (e.left === next.left && e.right === next.right && e.start === next.start && e.size === next.size ? e : next));
  };
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onScroll = () => update.current();
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaY;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      ro?.disconnect();
    };
  }, [strip, shown]);
  const key = tabs.join('\n');
  // a tab that became active (opened, clicked, Ctrl+1…8, chosen from the list) is scrolled into view
  useLayoutEffect(() => {
    const el = strip.current;
    const tab = el && active ? tabEls(el).find(t => t.dataset.sid === active) : undefined;
    if (el && tab) reveal(el, tab);
    update.current();
  }, [strip, active, key]);
  return edge;
}

/** The thin scrollbar of the strip over its top edge, visible on hover; dragging it scrolls the strip. */
export function StripThumb({ strip, edge }: { strip: RefObject<HTMLDivElement | null>; edge: StripEdge }) {
  const drag = useRef<{ x: number; scroll: number } | null>(null);
  if (edge.size >= 1) return null;
  const onDown = (e: PointerEvent<HTMLSpanElement>) => {
    const el = strip.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, scroll: el.scrollLeft };
  };
  const onMove = (e: PointerEvent<HTMLSpanElement>) => {
    const el = strip.current;
    if (!el || !drag.current) return;
    el.scrollLeft = drag.current.scroll + ((e.clientX - drag.current.x) * el.scrollWidth) / el.clientWidth;
  };
  const onUp = () => {
    drag.current = null;
  };
  const style = { left: `${edge.start * 100}%`, width: `${edge.size * 100}%` };
  return <span className="tab-thumb" style={style} aria-hidden="true" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />;
}

function Item({ sid, side, current, onPick }: { sid: string; side: TabSide; current: boolean; onPick: (sid: string) => void }) {
  const t = useT();
  const { title, fileHint, colorKey } = useTabTitle(sid);
  const file = parseFileTabId(sid);
  const mark = current ? t('workspace.tabList.current') : side === 'left' ? '‹' : side === 'right' ? '›' : '';
  return (
    <button
      type="button"
      role="menuitem"
      className={`tl-item${side ? '' : ' on-screen'}${current ? ' current' : ''}`}
      style={{ '--gc': colorVar(colorKey) } as CSSProperties}
      data-tab={sid}
      onClick={() => onPick(sid)}
    >
      {file ? <FileIcon kind={nameKind(file.path)} /> : <span className="pdot" />}
      <span className="tl-title">
        {title}
        {fileHint ? <span className="fx-tab-hint"> {fileHint}</span> : null}
      </span>
      {mark ? <small className="tl-mark">{mark}</small> : null}
    </button>
  );
}

/** «▾ N»: shown only when the tabs do not fit; the list of all tabs of the pane with a search. */
export function TabList({ paneId, tabs, active, strip }: { paneId: string; tabs: readonly string[]; active: string | null; strip: RefObject<HTMLDivElement | null> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sides, setSides] = useState<Record<string, TabSide>>({});
  const input = useRef<HTMLInputElement>(null);
  const { box, trigger, menu } = usePopupMenu(open, () => setOpen(false));
  // after `usePopupMenu`, which puts the focus on the first item: the search field takes it
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const toggle = () => {
    if (open) return setOpen(false);
    const el = strip.current;
    setSides(el ? Object.fromEntries(tabEls(el).map(tab => [tab.dataset.sid!, tabSide(el, tab)])) : {});
    setQuery('');
    setOpen(true);
  };
  const pick = (sid: string) => {
    setOpen(false);
    activateTab(paneId, sid);
    trigger.current?.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Home/End and the letters stay with the search field; ↑/↓ move between the items
    if (e.target === input.current && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    menuKeys(e);
  };
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.click();
  };
  // the tabs whose title (or the folder of a same-named file) has the query; a string, so the selector is stable
  const q = query.trim().toLocaleLowerCase();
  const hits = useStore(st => {
    const found = q ? tabs.filter(sid => `${tabTitle(st, sid, t)} ${tabFileHint(st, sid)}`.toLocaleLowerCase().includes(q)) : tabs;
    return found.join('\n');
  });
  const shown = new Set(hits ? hits.split('\n') : []);
  const hidden = tabs.filter(sid => sides[sid] && shown.has(sid));
  const visible = tabs.filter(sid => !sides[sid] && shown.has(sid));
  const group = (ids: string[], name: string) => {
    if (!ids.length) return null;
    return (
      <div role="group" aria-label={name}>
        <h6>{name}</h6>
        {ids.map(sid => (
          <Item key={sid} sid={sid} side={sides[sid] ?? null} current={sid === active} onPick={pick} />
        ))}
      </div>
    );
  };
  return (
    <span ref={box} className="tw-pop">
      <button
        ref={trigger}
        type="button"
        className="tab-more"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('workspace.tabList.title', { count: tabs.length })}
        aria-label={t('workspace.tabList.title', { count: tabs.length })}
        onClick={toggle}
      >
        <span aria-hidden="true">▾</span> {tabs.length}
      </button>
      {open && (
        <div ref={menu} className="tw-menu tab-list" onKeyDown={onKey}>
          <input
            ref={input}
            className="tl-search"
            type="search"
            value={query}
            placeholder={t('workspace.tabList.search')}
            aria-label={t('workspace.tabList.search')}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onInputKey}
          />
          <div role="menu" aria-label={t('workspace.tabList.title', { count: tabs.length })}>
            {group(hidden, t('workspace.tabList.hidden'))}
            {group(visible, t('workspace.tabList.onScreen'))}
          </div>
          {!shown.size && <p className="tl-empty">{t('workspace.tabList.empty')}</p>}
        </div>
      )}
    </span>
  );
}
