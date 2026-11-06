/**
 * The lazy file tree (change tool-windows-file-explorer, task 6.3). Markup and classes follow docs/prototypes/file-explorer.html
 * (`rowHtml`, `treeHtml`), the classes carry the prefix `fx-`.
 * Requirement (file-explorer): Ленивое дерево — one level per request, folders first then by name, hidden files dimmed,
 * «Показаны первые N из M», blocked nodes with a lock and «Нет доступа», `role="tree"`, the keyboard.
 * Requirement: Машина не в сети и ошибки — a failed node does not break the tree.
 */
import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react';
import type { FsEntry } from '@agent-hub/shared';
import { fmt, useT } from '../../i18n';
import { openFileTab } from '../workspace/actions';
import { FileIcon, ICON_CHEV, entryKind } from './fileIcons';
import { listingKey, loadDir, sessionFor, useFiles, type Listing } from './filesStore';
import { isInside, joinPath, pathKey } from './paths';
import type { Source } from './source';

type Row =
  | { type: 'entry'; entry: FsEntry; path: string; depth: number; open: boolean; blocked: boolean }
  | { type: 'more'; depth: number; shown: number; total: number; key: string }
  | { type: 'loading'; depth: number; key: string }
  | { type: 'error'; depth: number; key: string; text: string; path: string };

/** Folders first, then by name. */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  const collator = fmt.collator({ sensitivity: 'base', numeric: true });
  return [...entries].sort((a, b) => {
    const da = a.kind === 'dir' ? 0 : 1;
    const db = b.kind === 'dir' ? 0 : 1;
    return da - db || collator.compare(a.name, b.name);
  });
}

const EMPTY: string[] = [];

interface Props {
  src: Source;
  /** A path to flash (after «Показать в дереве»). */
  flash?: string | null;
}

/** The rows of the tree from the cached listings. */
export function buildRows(src: Source, rootPath: string, listings: Record<string, Listing>, hidden: boolean, expanded: string[]): Row[] {
  const open = new Set(expanded.map(pathKey));
  const rows: Row[] = [];
  const walk = (path: string, depth: number) => {
    const key = listingKey(src.runnerId, sessionFor(src, path), hidden, path);
    const l = listings[key];
    if (!l || l.status === 'loading') {
      rows.push({ type: 'loading', depth, key });
      return;
    }
    if (l.status === 'error') {
      rows.push({ type: 'error', depth, key, text: l.text, path });
      return;
    }
    for (const entry of sortEntries(l.data.entries)) {
      const p = joinPath(path, entry.name);
      // the path of a blocked folder stays in `expanded`, so after the rights change and «Обновить» it opens by itself
      // a folder the agent could not read (permission_denied) is marked like a blocked one, without an error row below
      const sub = listings[listingKey(src.runnerId, sessionFor(src, p), hidden, p)];
      const denied = entry.kind === 'dir' && sub?.status === 'error' && sub.code === 'permission_denied';
      const blocked = !!entry.blocked || denied;
      const isOpen = entry.kind === 'dir' && !blocked && open.has(pathKey(p));
      rows.push({ type: 'entry', entry, path: p, depth, open: isOpen, blocked });
      if (isOpen) walk(p, depth + 1);
    }
    if (l.data.truncated) rows.push({ type: 'more', depth, shown: l.data.entries.length, total: l.data.total, key });
  };
  walk(rootPath, 0);
  return rows;
}

export function FileTree({ src, flash }: Props) {
  const t = useT();
  const uid = useId();
  const hidden = useFiles(s => s.hidden);
  const listings = useFiles(s => s.listings);
  const expanded = useFiles(s => s.expanded[src.key]) ?? EMPTY;
  const selected = useFiles(s => s.selected[src.key]) ?? null;
  const store = useFiles.getState;
  const treeRef = useRef<HTMLDivElement>(null);

  const rootPath = src.root ?? '';
  const rootKey = listingKey(src.runnerId, sessionFor(src, rootPath), hidden, rootPath);
  const rootListing = listings[rootKey];
  // when the machine does not tell its home folder, the answer of the hub names the root
  const rootResolved = src.root ?? (rootListing?.status === 'ok' ? rootListing.data.path : '');

  // load what is missing: the root and the open folders, one level each
  useEffect(() => {
    if (!src.online || !src.supported) return;
    void loadDir(src.runnerId, src.root ?? undefined, sessionFor(src, rootPath));
    for (const p of expanded) {
      if (src.root && !isInside(src.root, p)) continue;
      void loadDir(src.runnerId, p, sessionFor(src, p));
    }
  }, [src, rootPath, expanded, hidden, listings]);

  const rows = useMemo(() => (rootListing?.status === 'ok' ? buildRows(src, rootResolved, listings, hidden, expanded) : []), [src, rootListing, rootResolved, listings, hidden, expanded]);
  const items = rows.flatMap((r, i) => (r.type === 'entry' ? [{ r, i }] : []));
  const selIdx = items.findIndex(x => selected !== null && pathKey(x.r.path) === pathKey(selected));

  useEffect(() => {
    if (selIdx < 0) return;
    const el = treeRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selIdx, selected]);
  useEffect(() => {
    if (!flash) return;
    treeRef.current?.querySelector<HTMLElement>('.fx-tr.flash')?.scrollIntoView?.({ block: 'nearest' });
  }, [flash, rows]);

  const open = (e: Extract<Row, { type: 'entry' }>, pin: boolean) => {
    if (e.blocked || e.entry.kind === 'dir' || e.entry.kind === 'other') return;
    openFileTab(src.runnerId, e.path, { pin, sessionId: sessionFor(src, e.path) });
  };
  const choose = (e: Extract<Row, { type: 'entry' }>) => {
    store().select(src, e.path);
    if (e.blocked) return;
    if (e.entry.kind === 'dir') store().toggleExpanded(src, e.path);
    else open(e, false);
  };

  const move = (to: number) => {
    const it = items[Math.max(0, Math.min(items.length - 1, to))];
    if (it) store().select(src, it.r.path);
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!items.length) return;
    const cur = selIdx >= 0 ? items[selIdx]!.r : null;
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        move(selIdx < 0 ? 0 : selIdx + 1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        move(selIdx < 0 ? 0 : selIdx - 1);
        break;
      case 'ArrowRight':
        if (!cur || cur.entry.kind !== 'dir' || cur.blocked) break;
        ev.preventDefault();
        if (!cur.open) store().toggleExpanded(src, cur.path);
        else if (items[selIdx + 1]?.r.depth === cur.depth + 1) move(selIdx + 1);
        break;
      case 'ArrowLeft': {
        if (!cur) break;
        ev.preventDefault();
        if (cur.entry.kind === 'dir' && cur.open) {
          store().toggleExpanded(src, cur.path);
          break;
        }
        for (let k = selIdx - 1; k >= 0; k--) {
          if (items[k]!.r.depth < cur.depth) {
            move(k);
            break;
          }
        }
        break;
      }
      case 'Enter':
        if (!cur || cur.blocked) break;
        ev.preventDefault();
        if (cur.entry.kind === 'dir') store().toggleExpanded(src, cur.path);
        else open(cur, false);
        break;
      case 'Home':
        ev.preventDefault();
        move(0);
        break;
      case 'End':
        ev.preventDefault();
        move(items.length - 1);
        break;
      default:
    }
  };

  const retry = (path: string) => void loadDir(src.runnerId, path || undefined, sessionFor(src, path), true);
  const activeId = selIdx >= 0 ? `${uid}-${items[selIdx]!.i}` : undefined;

  if (!src.online) return <TreeNote big={t('files.error.runner_offline')} text={t('files.tree.offlineHint', { machine: src.machineName })} />;
  if (!src.supported) return <TreeNote big={t('files.error.capability_unavailable')} text={t('files.tree.outdatedHint', { machine: src.machineName })} />;
  if (!rootListing || rootListing.status === 'loading') return <TreeNote text={t('files.loading')} />;
  if (rootListing.status === 'error') {
    const timeout = rootListing.code === 'agent_timeout';
    return (
      <TreeNote big={rootListing.text} text={timeout ? t('files.tree.agentTimeout') : undefined}>
        <button type="button" className="btn sm" onClick={() => retry(rootPath)}>
          {t('files.retry')}
        </button>
      </TreeNote>
    );
  }
  if (!rows.length) return <TreeNote text={t('files.tree.empty')} />;

  return (
    <div className="fx-tree" role="tree" aria-label={t('files.title')} tabIndex={0} aria-activedescendant={activeId} ref={treeRef} onKeyDown={onKeyDown} data-testid="file-tree">
      {rows.map((r, i) => {
        const pad = { '--d': r.depth } as React.CSSProperties;
        if (r.type === 'loading') {
          return (
            <div key={`l${r.key}`} className="fx-tr fx-note" style={pad} role="none">
              {t('files.loading')}
            </div>
          );
        }
        if (r.type === 'more') {
          return (
            <div key={`m${r.key}`} className="fx-tr fx-note" style={pad} role="none">
              {t('files.tree.more', { shown: r.shown, total: r.total })}
            </div>
          );
        }
        if (r.type === 'error') {
          return (
            <div key={`e${r.key}`} className="fx-tr fx-note fx-err" style={pad} role="none">
              <span className="nm">{r.text}</span>
              <button type="button" className="btn sm ghost" onClick={() => retry(r.path)}>
                {t('files.retry')}
              </button>
            </div>
          );
        }
        const isDir = r.entry.kind === 'dir';
        const isSel = selected !== null && pathKey(r.path) === pathKey(selected);
        const isFlash = !!flash && pathKey(flash) === pathKey(r.path);
        const dim = r.blocked || r.entry.name.startsWith('.');
        return (
          <div
            key={r.path}
            id={`${uid}-${i}`}
            className={`fx-tr${isSel ? ' sel' : ''}${dim ? ' dim' : ''}${isFlash ? ' flash' : ''}`}
            style={pad}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-selected={isSel}
            aria-expanded={isDir && !r.blocked ? r.open : undefined}
            aria-disabled={r.blocked || undefined}
            data-selected={isSel}
            data-path={r.path}
            title={r.blocked ? t('files.error.permission_denied') : r.path}
            aria-label={r.blocked ? t('files.tree.blockedNamed', { name: r.entry.name }) : undefined}
            onClick={() => choose(r)}
            onDoubleClick={() => open(r, true)}
          >
            <span className={`chev${r.open ? ' open' : ''}`}>{isDir && !r.blocked ? ICON_CHEV : null}</span>
            <FileIcon kind={entryKind(r.entry)} open={r.open} blocked={r.blocked} />
            <span className="nm">{r.entry.name}</span>
            {r.blocked ? <span className="meta">{t('files.error.permission_denied')}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function TreeNote({ big, text, children }: { big?: string; text?: string; children?: React.ReactNode }) {
  return (
    <div className="fx-tree">
      <div className="fx-state" role="status">
        {big ? <div className="big">{big}</div> : null}
        {text ? <div className="muted">{text}</div> : null}
        {children ? <div className="act">{children}</div> : null}
      </div>
    </div>
  );
}
