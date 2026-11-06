// Assistant text as Markdown (GFM tables and lists). Raw HTML is not rendered: react-markdown escapes it by default.
// Requirement (chat-images): Изображения в ответе ассистента — `![…](C:\…)` / `![…](/home/…)` shows «Показать
// изображение» (the hub fetches the file from the session's machine, D19); `![…](https://…)` is a link and is not
// loaded by the browser.
import { createContext, memo, useContext, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isAbsoluteLocalPath } from '../../api/types';
import { t, useT } from '../../i18n';
import { ApiError, api } from '../../api/client';
import { ImageGroup, picOf } from '../images/ImagePreview';
import type { ImageRef } from '../images/format';

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

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
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
 * Windows paths of images are protected before parsing: a backslash before ASCII punctuation is doubled.
 */
export function protectWindowsImagePaths(text: string): string {
  return text.replace(/(!\[[^\]]*\]\()([A-Za-z]:\\[^)\s]*)(\))/g, (_m, a: string, path: string, b: string) => a + path.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\') + b);
}

/** Local paths of images stay as written (the default transform would drop `C:` as an unknown scheme). */
function urlTransform(url: string, key: string): string {
  if (key === 'src' && isAbsoluteLocalPath(decodePath(url))) return url;
  return defaultUrlTransform(url);
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
      {protectWindowsImagePaths(text)}
    </ReactMarkdown>
  );
});
