// Assistant text as Markdown (GFM tables and lists). Raw HTML is not rendered: react-markdown escapes it by default.
// Requirement (chat-images): Изображения в ответе ассистента — `![…](C:\…)` / `![…](/home/…)` shows «Показать
// изображение» (the hub fetches the file from the session's machine, D19); `![…](https://…)` is a link and is not
// loaded by the browser.
import { createContext, memo, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isAbsoluteLocalPath } from '../../api/types';
import { t, useT } from '../../i18n';
import { ApiError, api } from '../../api/client';
import { ImageGroup, picOf } from '../images/ImagePreview';
import type { ImageRef } from '../images/format';
import { isNameWithLine, type FileLinkResolver } from '../files/links';
import { openFileLink } from '../files/fileActions';
import { useStore } from '../../store';
import { openSession } from '../workspace/actions';
import { remarkSessionRefs, sessionRefOf, useSessionRef } from '../sessions/sessionLinks';

/** The session the text belongs to: «Показать изображение» asks the hub for a file of its machine. */
export interface ImageSource {
  sessionId: string;
  runnerName: string;
  /** Local paths already shown in this session (hub notes kind=image): no request to the machine. */
  known: Record<string, ImageRef>;
}
export const ImageSourceContext = createContext<ImageSource | null>(null);

// images shown in this window, by session and path
const shown = new Map<string, ImageRef>();

function showError(err: unknown, runner: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'file_not_found') return t('chat.md.fileNotFound', { runner });
    if (err.code === 'image_too_large') return t('chat.md.tooLarge');
    if (err.code === 'runner_offline') return t('chat.md.offline', { runner });
    if (err.code === 'agent_outdated') return t('chat.md.outdated', { runner });
    if (err.code === 'not_image') return t('chat.md.notImage');
    if (err.serverMessage) return err.serverMessage;
  }
  return t('chat.md.failed');
}

function LocalImage({ path, alt }: { path: string; alt: string }) {
  const t = useT();
  const src = useContext(ImageSourceContext);
  const key = `${src?.sessionId}:${path}`;
  const [img, setImg] = useState<ImageRef | undefined>(() => src?.known[path] ?? shown.get(key));
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  if (img) return <ImageGroup pics={[picOf(img)]} className="md-img" />;
  if (!src) return <code>{path}</code>;
  const load = async () => {
    setState('loading');
    try {
      const r = await api.showImage(src.sessionId, path);
      const b = r.event.image?.blob;
      if (!b) throw new Error('no image');
      const ref: ImageRef = { sha256: b.$blob, mime: b.mime, size: b.size, ...(b.width && b.height ? { width: b.width, height: b.height } : {}) };
      shown.set(key, ref);
      setImg(ref);
    } catch (err) {
      setError(showError(err, src.runnerName));
      setState('error');
    }
  };
  return (
    <span className="md-local-img">
      <button type="button" className="btn" disabled={state === 'loading'} onClick={() => void load()} title={path}>
        {state === 'loading' ? t('chat.md.loading') : t('chat.md.show')}
      </button>{' '}
      <span className="md-img-path">
        {alt ? `${alt} · ` : ''}
        {path}
      </span>
      {state === 'error' && (
        <span className="md-img-error" role="alert">
          {' '}
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * The file viewer (task 6.5) gives pictures of a Markdown file a resolver: it turns the path written in the document into
 * the URL of the file endpoint, or null for a picture outside the root (then the picture is not loaded).
 */
export const FileImageContext = createContext<((path: string) => string | null) | null>(null);

function MdImg({ src, alt }: { src?: unknown; alt?: string }) {
  const t = useT();
  const resolve = useContext(FileImageContext);
  const url = decodePath(typeof src === 'string' ? src : '');
  if (resolve && !/^https?:\/\//i.test(url)) {
    const href = resolve(url);
    if (href) return <img className="md-file-img" src={href} alt={alt ?? ''} loading="lazy" />;
    return <span className="md-img-blocked">{alt ? `[${alt}]` : `[${t('chat.md.outsideFolder')}]`}</span>;
  }
  if (isAbsoluteLocalPath(url)) return <LocalImage path={url} alt={alt ?? ''} />;
  if (/^https?:\/\//i.test(url))
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" className="md-ext-img">
        {alt || t('chat.md.image')} ({url})
      </a>
    );
  return <span>{alt ? `[${alt}]` : `[${t('chat.md.image')}]`}</span>;
}

/**
 * Links to files of the machine (change chat-file-links): the feed resolves them from the folder of the session, the
 * Markdown viewer from the folder of the document. Without a resolver every link opens as a web address.
 */
export const FileLinkContext = createContext<FileLinkResolver | null>(null);

/**
 * A UUID of the feed that is a session of the user (change session-links, Requirement: Ссылки на сессии): the label is
 * the live title of the session, a click opens its tab. Until the hub answers, or for a foreign UUID, the text stays.
 */
function SessionLink({ id, children }: { id: string; children?: ReactNode }) {
  const ref = useSessionRef(id);
  const title = useStore(st => (ref ? st.sessions[ref.id]?.title : undefined)) ?? ref?.title;
  if (!ref) return <>{children}</>;
  const open = (e: MouseEvent) => {
    e.preventDefault();
    openSession(ref.id);
  };
  return (
    <a href={`/s/${ref.id}`} className="md-session-link" title={ref.runnerName ? `${ref.runnerName} · ${id}` : id} onClick={open}>
      {title || id}
    </a>
  );
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const resolve = useContext(FileLinkContext);
  const sessionRef = sessionRefOf(href);
  if (sessionRef) return <SessionLink id={sessionRef}>{children}</SessionLink>;
  const file = resolve ? resolve(decodePath(href ?? '')) : null;
  if (!file)
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  // a file: a single click is a preview, a double click keeps the tab — as in the tree (Requirement: Файловые вкладки);
  // a folder is revealed in the tree (Requirement: Ссылки на папки)
  const open = (e: MouseEvent, pin: boolean) => {
    e.preventDefault();
    void openFileLink(file, pin);
  };
  return (
    <a href={href} className="md-file-link" title={file.path} onClick={e => open(e, false)} onDoubleClick={e => open(e, true)}>
      {children}
    </a>
  );
}

const components: Components = {
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  img: ({ src, alt }) => <MdImg src={src} alt={alt} />,
};

/** The Markdown parser percent-encodes backslashes of a destination: `C:%5CUsers` → `C:\Users`. */
function decodePath(url: string): string {
  if (!/%5c/i.test(url)) return url;
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * In a Markdown destination `\.` is an escaped dot, so `C:\vault\.tmp\x.png` would lose the backslash before `.tmp`.
 * Windows paths of images and links are protected before parsing: a backslash before ASCII punctuation is doubled.
 */
export function protectWindowsPaths(text: string): string {
  return text.replace(/(!?\[[^\]]*\]\()([A-Za-z]:\\[^)\s]*)(\))/g, (_m, a: string, path: string, b: string) => a + path.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\') + b);
}

/**
 * Local paths of images and links stay as written (the default transform would drop `C:` as an unknown scheme);
 * `file:` links reach the file resolver and are never followed by the browser.
 */
function urlTransform(url: string, key: string): string {
  if ((key === 'src' || key === 'href') && isAbsoluteLocalPath(decodePath(url))) return url;
  if (key === 'href' && (/^file:/i.test(url) || isNameWithLine(url))) return url;
  if (key === 'href' && sessionRefOf(url)) return url;
  return defaultUrlTransform(url);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkSessionRefs]} components={components} urlTransform={urlTransform}>
      {protectWindowsPaths(text)}
    </ReactMarkdown>
  );
});
