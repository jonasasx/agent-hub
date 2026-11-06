/**
 * The viewer of a file tab (change tool-windows-file-explorer, tasks 6.5/6.6/6.8). Markup after
 * docs/prototypes/file-explorer.html (`fileView`): breadcrumbs, the meta, the tools of the class, «В дереве», «@ В сообщение»,
 * copy, «только чтение». The file is shown by its class: picture, PDF (a lazy chunk), Markdown, text; the binary class,
 * a file over the limit, an offline machine and the errors have their own states.
 * Requirement (file-explorer): Просмотрщик; Крошки и действия над файлом; Машина не в сети и ошибки.
 */
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
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

const ZOOMS: Array<[ImageZoom, string]> = [
  ['fit', 'Вписать'],
  ['1', '100%'],
  ['2', '200%'],
];
const PDF_STEP = 0.2;

export function FileViewer({ tabId }: { tabId: string }) {
  const ref = parseFileTabId(tabId);
  if (!ref) return <ViewerEmpty big="Файл не найден" />;
  return <Viewer tabId={tabId} runnerId={ref.runnerId} path={ref.path} />;
}

function Viewer({ tabId, runnerId, path }: { tabId: string; runnerId: string; path: string }) {
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
    if (state.status === 'pdf') return `${pages ? `${pages} стр. · ` : ''}${formatBytes(state.size)}`;
    if (state.status === 'text') return `${formatBytes(state.size)} · ${state.kind === 'markdown' ? 'Markdown' : 'текст'}`;
    return '';
  }, [state, natural, pages]);

  const tools: React.ReactNode[] = [];
  if (state.status === 'text' && state.kind === 'markdown') {
    tools.push(
      <span key="md" className="fx-mini-seg">
        <button type="button" className={md === 'r' ? 'on' : ''} aria-pressed={md === 'r'} onClick={() => setMd('r')}>
          Просмотр
        </button>
        <button type="button" className={md === 's' ? 'on' : ''} aria-pressed={md === 's'} onClick={() => setMd('s')}>
          Исходник
        </button>
      </span>,
    );
  }
  if (state.status === 'image') {
    tools.push(
      <span key="img" className="fx-mini-seg">
        {ZOOMS.map(([z, t]) => (
          <button key={z} type="button" className={zoom === z ? 'on' : ''} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
            {t}
          </button>
        ))}
      </span>,
    );
  }
  if (state.status === 'pdf') {
    tools.push(
      <button key="m" type="button" className="btn sm icon ghost" title="Мельче" aria-label="Мельче" disabled={pz <= 0.6} onClick={() => setPz(Math.max(0.6, +(pz - PDF_STEP).toFixed(1)))}>
        −
      </button>,
      <span key="p" className="fx-pg-ind" aria-live="polite">
        {page} / {pages || '…'}
      </span>,
      <button key="p+" type="button" className="btn sm icon ghost" title="Крупнее" aria-label="Крупнее" disabled={pz >= 2} onClick={() => setPz(Math.min(2, +(pz + PDF_STEP).toFixed(1)))}>
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
          <button type="button" className="btn sm ghost opt" title="Показать в дереве" aria-label="Показать в дереве" onClick={() => revealInTree(runnerId, path, sessionId)}>
            {ICON_FOLDER_BTN}
            {phone ? '' : ' В дереве'}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={noSession}
            title={noSession ? 'нет активной сессии' : `Вставить путь в поле ввода сессии «${target ?? ''}»`}
            aria-label="В сообщение"
            onClick={() => insertMention(path)}
          >
            @{phone ? '' : ' В сообщение'}
          </button>
          <button type="button" className="btn sm icon ghost opt" title="Копировать путь" aria-label="Копировать путь" onClick={() => void copyPath(path)}>
            {ICON_COPY}
          </button>
          {phone ? null : <span className="ro-note opt">только чтение</span>}
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
        return <div className="fx-note-center">Загрузка…</div>;
      case 'offline':
        return <ViewerEmpty big="Машина не в сети">{machineName}: файл откроется, когда машина подключится</ViewerEmpty>;
      case 'unsupported':
        return <Unsupported name={name} size={state.size} mime={state.mime} />;
      case 'toolarge':
        return <TooLarge size={state.size} limit={state.limit} />;
      case 'error':
        return (
          <ViewerEmpty
            big={state.code === 'agent_timeout' ? 'Машина не отвечает' : state.text}
            action={
              <button type="button" className="btn sm" onClick={reload}>
                Повторить
              </button>
            }
          />
        );
      case 'image':
        return <ImageView runnerId={runnerId} path={path} sessionId={sessionId} name={name} zoom={zoom} natural={natural} onNatural={setNatural} onError={imageFailed} />;
      case 'pdf':
        return (
          <Suspense fallback={<div className="fx-note-center">Загрузка…</div>}>
            <PdfView data={state.data} zoom={pz} onPages={onPages} onPage={onPage} />
          </Suspense>
        );
      case 'text':
        return state.kind === 'markdown' ? <MarkdownView text={state.text} mode={md} runnerId={runnerId} path={path} sessionId={sessionId} root={root} /> : <TextView text={state.text} />;
    }
  }
}
