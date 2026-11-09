/**
 * Work area: split tree, panes with tab strips, drag & drop, dividers, phone top bar
 * (docs/prototype.html nodeHtml(), leafHtml(), mbar(), bind()).
 * Requirements (workspace-ui): Мои вкладки (incl. «Закрытие вкладки колёсиком»); Сплит перетаскиванием; Место
 * вставки на полосе вкладок; Разделитель и закрытие панели; Одно окно и Вернуть разделение; Телефонный режим.
 */
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useStore } from '../../store';
import { Chat, SubagentChat, ModeModelMenu } from '../chat/Chat';
import { SessionTitle } from '../chat/SessionTitle';
import { Glyph } from '../sessions/Glyph';
import { colorVar, displayStatus, runnerIndex, statusText, tabNeedsGlyph } from '../sessions/status';
import { insertSlot, isFileTab, leaves, parseFileTabId, slotTarget, topRight, zoneBox, zoneHint, zoneOf, type InsertSlot, type LayoutNode, type Zone } from '../layout/layout';
import { FileIcon, nameKind } from '../files/fileIcons';
import { FileViewer } from '../files/FileViewer';
import { useFiles } from '../files/filesStore';
import { activateTab, closePane, closeTab, dropSplit, dropToPane, focusPane, pinFileTab, setRatio, toggleSingle } from './actions';
import { backToList } from './phoneHistory';
import { useTabTitle } from './tabTitle';
import { baseName } from '../files/paths';
import { StripThumb, TabList, useTabStrip } from './TabList';
import { SUBAGENT_STATUS_LABEL, subStatus, subTitle } from '../subagents/model';
import { SubStatusDot } from '../subagents/SubagentViews';
import { hubText, useT } from '../../i18n';
import { ProviderIcon } from '../chat/ProviderIcon';
import { PROVIDER_LABELS } from '@agent-hub/shared';

const ICON_SINGLE = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
  </svg>
);
/** A pane frame with a cross: closes the pane, not a tab (UI review M7). */
const ICON_PANE_CLOSE = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M6 6l4 4M10 6l-4 4" />
  </svg>
);
const ICON_SPLIT = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M8 2.5v11" />
  </svg>
);

function startTabDrag(e: DragEvent, sid: string) {
  useStore.setState({ dragSid: sid });
  e.dataTransfer.setData('text/plain', sid);
  e.dataTransfer.effectAllowed = 'move';
}

function Tab({ sid, paneId, index, active, keyed, dropCls }: { sid: string; paneId: string; index: number; active: boolean; keyed: boolean; dropCls: string }) {
  const t = useT();
  const s = useStore(st => st.sessions[sid]);
  const sub = useStore(st => (st.tabKinds[sid] ? st.subagents[sid] : undefined));
  // a subagent tab takes its parent's project colour and shows the subagent's own status while it works
  const parent = useStore(st => (sub ? st.sessions[sub.sessionId] : undefined));
  const subSt = sub ? subStatus(sub, parent) : null;
  const subGlyph = subSt === 'running';
  const runners = useStore(st => st.runners);
  const idx = runnerIndex(runners);
  const st = s ? displayStatus(s, idx) : null;
  // a subagent's tab (change `subagents` S9): «Субагент · <описание>»
  // a file tab (change tool-windows-file-explorer): the file name, italic while it is a preview
  const file = parseFileTabId(sid);
  const preview = useFiles(f => !!file && !f.pinned.includes(sid));
  const fileMachine = useStore(st => (file ? st.runners.find(r => r.id === file.runnerId)?.name : undefined));
  const { title, fileHint } = useTabTitle(sid);
  const close = (e: MouseEvent) => {
    e.stopPropagation();
    closeTab(sid);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateTab(paneId, sid);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      closeTab(sid);
    }
  };
  return (
    <div
      className={`tab${active ? ' active' : ''}${s?.spawnedBy ? ' hub-child' : ''}${file ? ' file' : ''}${file && preview ? ' preview' : ''}${dropCls}`}
      role="tab"
      tabIndex={0}
      aria-selected={active}
      // the name is the title (and the status when the tab shows a status icon), not the icon and the close button
      aria-label={s && st && tabNeedsGlyph(s, idx) ? `${title}, ${statusText(s, st)}` : subGlyph && subSt ? `${title}, ${SUBAGENT_STATUS_LABEL[subSt]}` : title}
      data-sid={sid}
      draggable
      onDragStart={e => startTabDrag(e, sid)}
      onDragEnd={() => useStore.setState({ dragSid: null })}
      style={{ '--gc': colorVar((s ?? parent)?.project.colorKey) } as CSSProperties}
      title={
        file
          ? `${fileMachine ?? file.runnerId} · ${file.path}${preview ? ` — ${t('workspace.panes.previewHint')}` : ''}`
          : s && st
            ? `${s.title} · ${hubText(s.project.title, s.project.i18n)} · ${statusText(s, st)}${s.spawnedBy ? ` · ${t('workspace.panes.subagentOf', { title: s.spawnedBy.title })}` : ''}`
            : title
      }
      onClick={() => activateTab(paneId, sid)}
      onDoubleClick={file ? () => pinFileTab(sid) : undefined}
      onKeyDown={onKey}
      // Requirement: Мои вкладки — scenario «Закрытие вкладки колёсиком»: no autoscroll, the session is not opened.
      onMouseDown={e => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={e => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        closeTab(sid);
      }}
    >
      {s && st && tabNeedsGlyph(s, idx) && <Glyph status={st} unread={s.unread} label={statusText(s, st)} />}
      {subGlyph && subSt && <SubStatusDot status={subSt} />}
      {file ? <FileIcon kind={nameKind(file.path)} /> : <span className="pdot" />}
      <span className="t-title">
        {title}
        {fileHint ? <span className="fx-tab-hint"> {fileHint}</span> : null}
      </span>
      {keyed && index < 8 && <span className="t-key">{index + 1}</span>}
      <button type="button" className="t-close" aria-label={t('workspace.panes.removeTab', { title })} tabIndex={-1} onClick={close}>
        ×
      </button>
    </div>
  );
}

/** A stable empty list for a pane that is gone (the hooks run before the early return). */
const NO_TABS: readonly string[] = [];

function TabBar({ paneId, multi }: { paneId: string; multi: boolean }) {
  const t = useT();
  const pane = useStore(st => st.ws.panes[paneId]);
  const focus = useStore(st => st.ws.focus);
  const layout = useStore(st => st.ws.layout);
  const saved = useStore(st => st.ws.saved);
  const dragSid = useStore(st => st.dragSid);
  const [slot, setSlot] = useState<InsertSlot | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const edge = useTabStrip(tabsRef, pane?.tabs ?? NO_TABS, pane?.active ?? null);
  useEffect(() => {
    if (!dragSid) setSlot(null);
  }, [dragSid]);
  if (!pane) return null;

  const measure = (x: number) => {
    const els = [...(tabsRef.current?.querySelectorAll<HTMLElement>('[data-sid]') ?? [])];
    return insertSlot(
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { sessionId: el.dataset.sid!, left: r.left, width: r.width };
      }),
      x,
      dragSid,
    );
  };
  const onDragOver = (e: DragEvent) => {
    if (!dragSid) return;
    e.preventDefault();
    e.stopPropagation();
    setSlot(measure(e.clientX));
  };
  const onDrop = (e: DragEvent) => {
    if (!dragSid) return;
    e.preventDefault();
    e.stopPropagation();
    const sid = dragSid;
    const target = slotTarget(measure(e.clientX));
    useStore.setState({ dragSid: null });
    setSlot(null);
    dropToPane(sid, paneId, target);
  };
  const cls = (sid: string) => (slot && slot.kind !== 'empty' && slot.sessionId === sid ? (slot.kind === 'before' ? ' drop-before' : ' drop-after') : '');

  return (
    <div className="tabbar" data-tabbar={paneId} onDragOver={onDragOver} onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setSlot(null)} onDrop={onDrop}>
      <div className="tabs-wrap">
        <div className={`tabs${slot?.kind === 'empty' ? ' drop-empty' : ''}`} role="tablist" aria-label={t('workspace.panes.tabList')} ref={tabsRef}>
          {pane.tabs.length ? (
            pane.tabs.map((sid, i) => <Tab key={sid} sid={sid} paneId={paneId} index={i} active={sid === pane.active} keyed={paneId === focus} dropCls={cls(sid)} />)
          ) : (
            <span className="hint" style={{ padding: '0 8px 10px' }}>
              {t('workspace.panes.tabsEmpty')}
            </span>
          )}
        </div>
        {edge.left && <span className="tab-fade l" aria-hidden="true" />}
        {edge.right && <span className="tab-fade r" aria-hidden="true" />}
        <StripThumb strip={tabsRef} edge={edge} />
      </div>
      {(edge.left || edge.right) && <TabList paneId={paneId} tabs={pane.tabs} active={pane.active} strip={tabsRef} />}
      {multi && paneId === topRight(layout) && (
        <button type="button" className="icon-btn layout-btn" title={t('workspace.panes.singleTitle')} aria-label={t('workspace.panes.singleLabel')} onClick={toggleSingle}>
          {ICON_SINGLE}
        </button>
      )}
      {!multi && saved && (
        <button type="button" className="icon-btn layout-btn" title={t('workspace.panes.restoreTitle')} aria-label={t('workspace.panes.restoreLabel')} onClick={toggleSingle}>
          {ICON_SPLIT}
        </button>
      )}
      {multi && (
        <button type="button" className="icon-btn pane-close" title={t('workspace.panes.closePaneTitle')} aria-label={t('workspace.panes.closePaneLabel')} onClick={() => closePane(paneId)}>
          {ICON_PANE_CLOSE}
        </button>
      )}
    </div>
  );
}

function Leaf({ paneId, multi, phone }: { paneId: string; multi: boolean; phone: boolean }) {
  const t = useT();
  const pane = useStore(st => st.ws.panes[paneId]);
  const focused = useStore(st => st.ws.focus === paneId);
  const session = useStore(st => (pane?.active && !st.tabKinds[pane.active] ? st.sessions[pane.active] : undefined));
  const fileId = pane?.active && isFileTab(pane.active) ? pane.active : null;
  const subId = useStore(st => (pane?.active && st.tabKinds[pane.active] === 'subagent' ? pane.active : null));
  const dragSid = useStore(st => st.dragSid);
  const paneCount = useStore(st => leaves(st.ws.layout).length);
  const [zone, setZone] = useState<Zone | null>(null);
  useEffect(() => {
    if (!dragSid) setZone(null);
  }, [dragSid]);
  if (!pane) return null;

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!dragSid || phone) return;
    e.preventDefault();
    setZone(zoneOf(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY));
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!dragSid || phone) return;
    e.preventDefault();
    const z = zoneOf(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    const sid = dragSid;
    useStore.setState({ dragSid: null });
    setZone(null);
    if (z === 'center') dropToPane(sid, paneId, null);
    else dropSplit(sid, paneId, z);
  };
  const box = zone ? zoneBox(zone) : null;

  return (
    <section
      className={`leaf${focused ? ' focused' : ''}${multi ? ' multi' : ''}${zone ? ' dragging-over' : ''}`}
      data-pane={paneId}
      aria-label={t('workspace.panes.pane')}
      onPointerDownCapture={() => focusPane(paneId)}
      onDragOver={onDragOver}
      onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setZone(null)}
      onDrop={onDrop}
    >
      {!phone && <TabBar paneId={paneId} multi={multi} />}
      {fileId ? (
        <FileViewer key={fileId} tabId={fileId} />
      ) : subId ? (
        <SubagentChat key={subId} id={subId} />
      ) : session ? (
        <Chat key={session.id} session={session} paneId={paneId} />
      ) : pane.active ? (
        <div className="empty">{t('workspace.panes.sessionLoading')}</div>
      ) : (
        <div className="empty">{t('workspace.panes.pickSession')}</div>
      )}
      {zone && box && (
        <>
          <div className="dropzone" style={{ left: `${box[0]}%`, top: `${box[1]}%`, width: `${box[2]}%`, height: `${box[3]}%` }} />
          <div className="drop-hint" role="status">
            {zoneHint(zone, paneCount)}
          </div>
        </>
      )}
    </section>
  );
}

function Divider({ path, dir }: { path: string; dir: 'row' | 'col' }) {
  const t = useT();
  const [drag, setDrag] = useState(false);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDrag(true);
    const box = el.parentElement!;
    const move = (ev: globalThis.PointerEvent) => {
      const r = box.getBoundingClientRect();
      setRatio(path, dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(false);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -0.05 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 0.05 : 0;
    if (!step) return;
    e.preventDefault();
    let n: LayoutNode = useStore.getState().ws.layout;
    for (const s of path) if (n.type === 'split') n = s === 'a' ? n.a : n.b;
    if (n.type === 'split') setRatio(path, n.ratio + step);
  };
  return (
    <div
      className={`divider${drag ? ' drag' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      aria-label={t('workspace.panes.resize')}
      onPointerDown={onDown}
      onKeyDown={onKey}
    />
  );
}

function Node({ node, path, multi }: { node: LayoutNode; path: string; multi: boolean }) {
  if (node.type === 'leaf') return <Leaf paneId={node.pane} multi={multi} phone={false} />;
  return (
    <div className={`split ${node.dir}`}>
      <div className="cell" style={{ flex: `${node.ratio} 1 0` }}>
        <Node node={node.a} path={`${path}a`} multi={multi} />
      </div>
      <Divider path={path} dir={node.dir} />
      <div className="cell" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <Node node={node.b} path={`${path}b`} multi={multi} />
      </div>
    </div>
  );
}

/** Phone top bar: back to the left panel, title, fork. */
function PhoneBar() {
  const t = useT();
  const s = useStore(st => {
    const a = st.ws.panes[st.ws.focus]?.active;
    return a && !st.tabKinds[a] ? st.sessions[a] : undefined;
  });
  // a subagent's chat over the parent's (change `subagents`, spec «Субагенты на телефоне»): its title, no «⋯»
  const sub = useStore(st => {
    const a = st.ws.panes[st.ws.focus]?.active;
    return a && st.tabKinds[a] ? st.subagents[a] : undefined;
  });
  const runners = useStore(st => st.runners);
  const st = s ? displayStatus(s, runnerIndex(runners)) : null;
  // a file over the list (task 7.2): the file name, the machine under it
  const activeId = useStore(st => st.ws.panes[st.ws.focus]?.active);
  const file = activeId ? parseFileTabId(activeId) : null;
  // UI review M10: status as a glyph next to the title, mode and model behind «⋯»; the fork button comes with M4
  return (
    <div className="mbar">
      <button type="button" className="icon-btn" aria-label={t('workspace.panes.toList')} onClick={backToList}>
        ←
      </button>
      <span className="mt">
        {s && st && <Glyph status={st} unread={s.unread} />}
        {file ? (
          <>
            <FileIcon kind={nameKind(file.path)} />
            <span className="fx-mt-file">
              <span className="nm">{baseName(file.path)}</span>
              <small>
                {runners.find(r => r.id === file.runnerId)?.name ?? file.runnerId} · {t('workspace.panes.readOnly')}
              </small>
            </span>
          </>
        ) : s && !sub ? (
          <>
            <SessionTitle sessionId={s.id} title={s.title} />
            {/* the phone has no chat head: a session of another vendor than the default Claude shows its mark here */}
            {s.provider && s.provider !== 'claude' && (
              <span className="provider-badge" title={t('chat.head.providerBadge', { provider: PROVIDER_LABELS[s.provider] })}>
                <ProviderIcon provider={s.provider} size={16} />
              </span>
            )}
          </>
        ) : (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub ? t('workspace.panes.subagentTitle', { title: subTitle(sub) }) : ''}</span>
        )}
      </span>
      {s && !sub && <ModeModelMenu s={s} />}
    </div>
  );
}

export function Workspace() {
  const layout = useStore(st => st.ws.layout);
  const focus = useStore(st => st.ws.focus);
  const phone = useStore(st => st.device === 'phone');
  const multi = leaves(layout).length > 1;
  return (
    <main className="pane">
      <PhoneBar />
      <div className="layout">{phone ? <Leaf paneId={focus} multi={false} phone /> : <Node node={layout} path="" multi={multi} />}</div>
    </main>
  );
}
