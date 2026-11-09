/**
 * The views of the file viewer by class (change tool-windows-file-explorer, task 6.5). Markup after
 * docs/prototypes/file-explorer.html (`fileView`): `.v-img`, `.md-body`, `.src`, `.v-empty`.
 * Requirement (file-explorer): Просмотрщик — pictures, Markdown (a source toggle, pictures only inside the root),
 * text with line numbers, «Нельзя показать» for the binary class and «Файл слишком большой», both with «Скачать»
 * (change file-download).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { FileImageContext, FileLinkContext, Markdown } from '../chat/Markdown';
import { useT } from '../../i18n';
import { clampScale } from '../images/zoom';
import { formatBytes } from '../images/format';
import { openLightbox } from '../images/ImagePreview';
import { downloadFile } from './fileActions';
import { ICON_DOWNLOAD } from './fileIcons';
import { fsFileUrl } from './filesApi';
import { fileLinkResolver } from './links';
import { baseName, isInside, parentOf, resolveRelative } from './paths';

export type ImageZoom = 'fit' | '1' | '2';

interface ImageProps {
  runnerId: string;
  path: string;
  sessionId?: string;
  name: string;
  zoom: ImageZoom;
  natural: { w: number; h: number } | null;
  onNatural: (n: { w: number; h: number }) => void;
  onError: () => void;
}

/** A picture on the checkerboard: «Вписать» fits the pane, 100% and 200% show the pixels (a click opens the full-size view). */
export function ImageView({ runnerId, path, sessionId, name, zoom, natural, onNatural, onError }: ImageProps) {
  const src = fsFileUrl(runnerId, path, sessionId);
  const scale = zoom === 'fit' ? 0 : clampScale(Number(zoom), 0);
  const width = scale && natural ? Math.round(natural.w * scale) : undefined;
  return (
    <div className={`fx-img${zoom === 'fit' ? ' fit' : ''}`}>
      <img
        src={src}
        alt={name}
        width={width}
        onClick={() => openLightbox([{ src, original: src, caption: name, width: natural?.w, height: natural?.h }], 0)}
        onLoad={e => onNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onError={onError}
      />
    </div>
  );
}

/** Line numbers by a counter in CSS, as in the prototype (`.src span::before`). */
export function TextView({ text }: { text: string }) {
  const lines = useMemo(() => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'), [text]);
  return (
    <pre className="fx-src" data-testid="text-view">
      {lines.map((l, i) => (
        <span key={i}>{l || ' '}</span>
      ))}
    </pre>
  );
}

interface MdProps {
  text: string;
  mode: 'r' | 's';
  runnerId: string;
  path: string;
  sessionId?: string;
  /** The folder a picture of the document may come from: the cwd of the session or the home folder. */
  root: string | null;
}

/** Pictures of the document load only from inside the root; relative paths are resolved from the folder of the file. */
export function MarkdownView({ text, mode, runnerId, path, sessionId, root }: MdProps) {
  const resolve = useMemo(() => {
    const dir = parentOf(path) ?? path;
    return (ref: string) => {
      const abs = resolveRelative(dir, ref);
      if (!abs || !root || !isInside(root, abs)) return null;
      return fsFileUrl(runnerId, abs, sessionId);
    };
  }, [runnerId, path, sessionId, root]);
  // links of the document open in the viewer too, relative ones from its folder; the session root only inside its cwd
  const links = useMemo(() => fileLinkResolver({ runnerId, base: parentOf(path) ?? path, cwd: sessionId ? root : null, ...(sessionId ? { sessionId } : {}) }), [runnerId, path, sessionId, root]);
  if (mode === 's') return <TextView text={text} />;
  return (
    <div className="fx-md md-body" data-testid="md-view">
      <FileImageContext.Provider value={resolve}>
        <FileLinkContext.Provider value={links}>
          <Markdown text={text} />
        </FileLinkContext.Provider>
      </FileImageContext.Provider>
    </div>
  );
}

export function ViewerEmpty({ big, children, action }: { big: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="fx-empty" role="status">
      <div>
        <div className="big">{big}</div>
        {children ? <div className="muted">{children}</div> : null}
        {action ? <div className="act">{action}</div> : null}
      </div>
    </div>
  );
}

/** «5 МБ»: whole megabytes without «,0». */
export function megabytes(n: number): string {
  return formatBytes(n).replace(/[.,]0 /, ' ');
}

export interface DownloadTarget {
  runnerId: string;
  path: string;
  sessionId?: string;
  machineName: string;
  /** The agent declared `fs.download`; otherwise the button is dimmed with «Обновите агента». */
  supported: boolean;
}

interface DownloadButtonProps extends DownloadTarget {
  className?: string;
  /** Shows the word next to the icon. */
  label?: boolean;
  /** -1 in a tree row: the tree keeps one stop of Tab. */
  tabIndex?: number;
}

/** «Скачать»: one request at a time; the check and the toast are in `downloadFile`. */
export function DownloadButton({ runnerId, path, sessionId, machineName, supported, className = 'btn sm', label = true, tabIndex }: DownloadButtonProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const title = supported ? t('files.action.downloadNamed', { name: baseName(path) }) : t('files.action.downloadOutdated', { machine: machineName });
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await downloadFile(runnerId, path, sessionId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={className}
      tabIndex={tabIndex}
      title={title}
      aria-label={title}
      aria-disabled={!supported || busy || undefined}
      disabled={!supported}
      data-testid="file-download"
      onClick={e => void onClick(e)}
      onDoubleClick={e => e.stopPropagation()}
    >
      {ICON_DOWNLOAD}
      {label ? ` ${t('files.action.download')}` : null}
    </button>
  );
}

export function TooLarge({ size, limit, download }: { size: number | null; limit: number; download: DownloadTarget }) {
  const t = useT();
  return (
    <ViewerEmpty
      big={size ? t('files.viewer.tooLarge', { size: megabytes(size), limit: megabytes(limit) }) : t('files.viewer.tooLargeLimit', { limit: megabytes(limit) })}
      action={<DownloadButton {...download} />}
    />
  );
}

/** The binary class: the size, the type and «Скачать»; the bytes reach the browser only after the click. */
export function Unsupported({ name, size, mime, download }: { name: string; size: number; mime: string; download: DownloadTarget }) {
  const t = useT();
  return (
    <ViewerEmpty big={t('files.error.unsupported')} action={<DownloadButton {...download} />}>
      {name} · {formatBytes(size)} · {mime}
    </ViewerEmpty>
  );
}
