/**
 * The viewer of a file tab (change tool-windows-file-explorer, tasks 6.5/6.6/6.8). Markup after
 * docs/prototypes/file-explorer.html (`fileView`): breadcrumbs, the meta, the tools of the class, «В дереве», «@ В сообщение»,
 * copy, «только чтение». The file is shown by its class: picture, PDF (a lazy chunk), Markdown, text; the binary class,
 * a file over the limit, an offline machine and the errors have their own states.
 * Requirement (file-explorer): Просмотрщик; Крошки и действия над файлом; Машина не в сети и ошибки.
 */
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { formatBytes } from '../images/format';
import { parseFileTabId } from '../layout/layout';
import { Breadcrumbs } from './Breadcrumbs';
import { copyPath, insertMention, revealInTree } from './fileActions';
import { ICON_COPY, ICON_FOLDER_BTN } from './fileIcons';
import { ImageView, MarkdownView, TextView, TooLarge, Unsupported, ViewerEmpty, type ImageZoom } from './fileViews';
import { useFiles } from './filesStore';
import { baseName } from './paths';
import { useFileContent } from './useFileContent';
import { useLastSessionId } from './useSource';

const PdfView = lazy(() => import('./PdfView'));

const ZOOMS: Array<[ImageZoom, 'files.viewer.fit' | 'files.viewer.zoom100' | 'files.viewer.zoom200']> = [
  ['fit', 'files.viewer.fit'],
  ['1', 'files.viewer.zoom100'],
  ['2', 'files.viewer.zoom200'],
];
const PDF_STEP = 0.2;

export function FileViewer({ tabId }: { tabId: string }) {
  const t = useT();
  const ref = parseFileTabId(tabId);
  if (!ref) return <ViewerEmpty big={t('files.error.fileNotFound')} />;
  return <Viewer tabId={tabId} runnerId={ref.runnerId} path={ref.path} />;
}

function Viewer({ tabId, runnerId, path }: { tabId: string; runnerId: string; path: string }) {
  const t = useT();
  const runner = useStore(s => s.runners.find(r => r.id === runnerId));
  const phone = useStore(s => s.device === 'phone');
  const sessionId = useFiles(s => s.tabSession[tabId]);
  const session = useStore(s => (sessionId ? s.sessions[sessionId] : undefined));
  const lastSession = useLastSessionId();
  const target = useStore(st => (lastSession ? st.sessions[lastSession]?.title : undefined));
  const online = !!runner?.online;
  const { state, reload, imageFailed } = useFileContent(runnerId, path, sessionId, online);
  const [md, setMd] = useState<'r' | 's'>('r');
  const [zoom, setZoom] = useState<ImageZoom>('fit');
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [pz, setPz] = useState(1);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const name = baseName(path);
  const home = runner?.homeDir ?? null;
  // pictures of a document come from the folder of its session, else from the home folder of the machine
  const root = (sessionId ? session?.cwd : null) ?? home;
  const machineName = runner?.name ?? runnerId;
  const onPages = useCallback((n: number) => setPages(n), []);
  const onPage = useCallback((n: number) => setPage(n), []);

  const meta = useMemo(() => {
    if (state.status === 'image') return [natural ? `${natural.w}×${natural.h}` : null, state.size ? formatBytes(state.size) : null].filter(Boolean).join(' · ');
    if (state.status === 'pdf') return `${pages ? `${t('files.viewer.pages', { count: pages })} · ` : ''}${formatBytes(state.size)}`;
    if (state.status === 'text') return `${formatBytes(state.size)} · ${state.kind === 'markdown' ? 'Markdown' : t('files.viewer.text')}`;
    return '';
  }, [state, natural, pages, t]);

  const tools: React.ReactNode[] = [];
  if (state.status === 'text' && state.kind === 'markdown') {
    tools.push(
      <span key="md" className="fx-mini-seg">
        <button type="button" className={md === 'r' ? 'on' : ''} aria-pressed={md === 'r'} onClick={() => setMd('r')}>
          {t('files.viewer.rendered')}
        </button>
        <button type="button" className={md === 's' ? 'on' : ''} aria-pressed={md === 's'} onClick={() => setMd('s')}>
          {t('files.viewer.source')}
        </button>
      </span>,
    );
  }
  if (state.status === 'image') {
    tools.push(
      <span key="img" className="fx-mini-seg">
        {ZOOMS.map(([z, label]) => (
          <button key={z} type="button" className={zoom === z ? 'on' : ''} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
            {t(label)}
          </button>
        ))}
      </span>,
    );
  }
  if (state.status === 'pdf') {
    tools.push(
      <button
        key="m"
        type="button"
        className="btn sm icon ghost"
        title={t('files.viewer.smaller')}
        aria-label={t('files.viewer.smaller')}
        disabled={pz <= 0.6}
        onClick={() => setPz(Math.max(0.6, +(pz - PDF_STEP).toFixed(1)))}
      >
        −
      </button>,
      <span key="p" className="fx-pg-ind" aria-live="polite">
        {page} / {pages || '…'}
      </span>,
      <button
        key="p+"
        type="button"
        className="btn sm icon ghost"
        title={t('files.viewer.larger')}
        aria-label={t('files.viewer.larger')}
        disabled={pz >= 2}
        onClick={() => setPz(Math.min(2, +(pz + PDF_STEP).toFixed(1)))}
      >
        +
      </button>,
    );
  }

  const noSession = !lastSession;
  return (
    <div className="fx-viewer" data-testid="file-viewer">
      <div className="fx-vhead">
        <Breadcrumbs runnerId={runnerId} machineName={machineName} path={path} home={home} sessionId={sessionId} />
        {meta ? <span className="meta">{meta}</span> : null}
        <div className="fx-vtools">
          {tools}
          {tools.length ? <span className="sepv" /> : null}
          <button type="button" className="btn sm ghost opt" title={t('files.action.reveal')} aria-label={t('files.action.reveal')} onClick={() => revealInTree(runnerId, path, sessionId)}>
            {ICON_FOLDER_BTN}
            {phone ? '' : ` ${t('files.action.inTree')}`}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={noSession}
            title={noSession ? t('files.action.noSession') : t('files.action.mentionTitle', { title: target ?? '' })}
            aria-label={t('files.action.mention')}
            onClick={() => insertMention(path)}
          >
            @{phone ? '' : ` ${t('files.action.mention')}`}
          </button>
          <button type="button" className="btn sm icon ghost opt" title={t('files.action.copyPath')} aria-label={t('files.action.copyPath')} onClick={() => void copyPath(path)}>
            {ICON_COPY}
          </button>
          {phone ? null : <span className="ro-note opt">{t('files.viewer.readOnly')}</span>}
        </div>
      </div>
      <div className="fx-vbody" data-keep={`v:${tabId}`}>
        {renderBody()}
      </div>
    </div>
  );

  function renderBody() {
    switch (state.status) {
      case 'loading':
        return <div className="fx-note-center">{t('files.loading')}</div>;
      case 'offline':
        return <ViewerEmpty big={t('files.error.runner_offline')}>{t('files.viewer.offlineHint', { machine: machineName })}</ViewerEmpty>;
      case 'unsupported':
        return <Unsupported name={name} size={state.size} mime={state.mime} />;
      case 'toolarge':
        return <TooLarge size={state.size} limit={state.limit} />;
      case 'error':
        return (
          <ViewerEmpty
            big={state.code === 'agent_timeout' ? t('files.error.agent_timeout') : state.text}
            action={
              <button type="button" className="btn sm" onClick={reload}>
                {t('files.retry')}
              </button>
            }
          />
        );
      case 'image':
        return <ImageView runnerId={runnerId} path={path} sessionId={sessionId} name={name} zoom={zoom} natural={natural} onNatural={setNatural} onError={imageFailed} />;
      case 'pdf':
        return (
          <Suspense fallback={<div className="fx-note-center">{t('files.loading')}</div>}>
            <PdfView data={state.data} zoom={pz} onPages={onPages} onPage={onPage} />
          </Suspense>
        );
      case 'text':
        return state.kind === 'markdown' ? <MarkdownView text={state.text} mode={md} runnerId={runnerId} path={path} sessionId={sessionId} root={root} /> : <TextView text={state.text} />;
    }
  }
}
