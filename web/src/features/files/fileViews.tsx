/**
 * The views of the file viewer by class (change tool-windows-file-explorer, task 6.5). Markup after
 * docs/prototypes/file-explorer.html (`fileView`): `.v-img`, `.md-body`, `.src`, `.v-empty`.
 * Requirement (file-explorer): Просмотрщик — pictures, Markdown (a source toggle, pictures only inside the root),
 * text with line numbers, «Нельзя показать» without a download for the binary class, «Файл слишком большой».
 */
import { useMemo, type ReactNode } from 'react';
import { FileImageContext, Markdown } from '../chat/Markdown';
import { clampScale } from '../images/zoom';
import { formatBytes } from '../images/format';
import { openLightbox } from '../images/ImagePreview';
import { fsFileUrl } from './filesApi';
import { isInside, parentOf, resolveRelative } from './paths';

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
  if (mode === 's') return <TextView text={text} />;
  return (
    <div className="fx-md md-body" data-testid="md-view">
      <FileImageContext.Provider value={resolve}>
        <Markdown text={text} />
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
  return formatBytes(n).replace(',0 ', ' ');
}

export function TooLarge({ size, limit }: { size: number | null; limit: number }) {
  return <ViewerEmpty big={size ? `Файл слишком большой (${megabytes(size)} из ${megabytes(limit)})` : `Файл слишком большой (лимит ${megabytes(limit)})`} />;
}

/** The binary class: no download (read-only). */
export function Unsupported({ name, size, mime }: { name: string; size: number; mime: string }) {
  return (
    <ViewerEmpty big="Нельзя показать">
      {name} · {formatBytes(size)} · {mime}
    </ViewerEmpty>
  );
}
