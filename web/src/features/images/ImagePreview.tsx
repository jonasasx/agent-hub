/**
 * Image previews in the chat and the lightbox (design.md D19 «Агент → пользователь»).
 * Requirements (chat-images): Изображения от агента в чате — lazy `<img>` from the hub copy with the place reserved
 * by width/height and the caption «PNG · 1280×720 · 184 КБ», «Изображение недоступно» + «Повторить»;
 * Полный размер изображения — the lightbox: fit / 100 % on the second click, ←/→ and swipe between the images of the
 * message, Esc, a click outside, «Закрыть», «назад» on the phone, «Открыть оригинал».
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useDialog } from '../ui/a11y';
import { blobUrl, imageCaption, type ImageRef } from './format';

/** One picture: a stored image (`sha256`) or a local object URL (an optimistic attachment). */
export interface Pic {
  src: string;
  width?: number;
  height?: number;
  caption?: string;
  /** Link of «Открыть оригинал». */
  original?: string;
}

export const picOf = (img: ImageRef): Pic => ({ src: blobUrl(img.sha256), width: img.width, height: img.height, caption: imageCaption(img), original: blobUrl(img.sha256) });

interface LightboxState {
  pics: Pic[];
  index: number;
  open: boolean;
}
export const useLightbox = create<LightboxState>()(() => ({ pics: [], index: 0, open: false }));
export const openLightbox = (pics: Pic[], index: number) => useLightbox.setState({ pics, index, open: true });
const closeLightbox = () => useLightbox.setState({ open: false });

/** The box of a preview: at most 320×240 and the column width, the ratio of the image (bug from Ivan, M4a). */
export const PREVIEW_MAX_W = 320;
export const PREVIEW_MAX_H = 240;

/** Before an image of unknown size has loaded: a compact frame (review M4a: a 320×240 frame made small pictures large). */
export const PREVIEW_PENDING_W = 160;
export const PREVIEW_PENDING_H = 120;

/**
 * The box of a preview: at most 320×240 and the column width, at the ratio of the image, never larger than the image
 * (a small picture is not stretched). With width/height of the blob the place is exact before the image arrives;
 * without them (a Markdown image, a local file) a compact frame until it loads, then the natural size the same way.
 * The height limit of the CSS (`max-height: min(240px, 60vh)`) is not overridden: the picture keeps its ratio inside it.
 */
export function previewBox(width?: number, height?: number): { frame: CSSProperties; img: CSSProperties } {
  if (!width || !height) return { frame: { width: `${PREVIEW_PENDING_W}px` }, img: { width: '100%', height: `${PREVIEW_PENDING_H}px`, maxWidth: 'none', objectFit: 'contain' } };
  const w = Math.max(1, Math.min(PREVIEW_MAX_W, width, (PREVIEW_MAX_H * width) / height));
  // the width sits on the frame in px (narrowed by its max-width: 100% of the column), the picture fills it at its
  // ratio: a percentage on the picture itself resolves against a shrink-to-fit button and collapses before load
  return { frame: { width: `${Math.round(w)}px` }, img: { width: '100%', height: 'auto', maxWidth: 'none', aspectRatio: `${width} / ${height}`, objectFit: 'contain' } };
}

/** Natural sizes of images that came without width/height, by URL: a preview mounted again (the feed re-rendered)
 * takes its frame at once instead of the compact one, so the feed does not move. */
const naturalSizes = new Map<string, { w: number; h: number }>();

/** A preview with its caption; place is reserved by width/height before the image arrives. */
export function ImagePreview({ pic, onOpen, label }: { pic: Pic; onOpen: () => void; label: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // the natural size of an image the hub gave no size for, once it has loaded
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(() => naturalSizes.get(pic.src) ?? null);
  const img = useRef<HTMLImageElement>(null);
  const known = !!(pic.width && pic.height);
  const ratio = known ? `${pic.width} / ${pic.height}` : undefined;
  const box = known ? previewBox(pic.width, pic.height) : previewBox(natural?.w, natural?.h);
  const onLoaded = useCallback(() => {
    const el = img.current;
    if (!known && el?.naturalWidth && el.naturalHeight) {
      const size = { w: el.naturalWidth, h: el.naturalHeight };
      naturalSizes.set(pic.src, size);
      setNatural(size);
    }
    setLoaded(true);
  }, [known, pic.src]);
  // an image from the cache can be complete before React attaches onLoad: then the shimmer would stay forever
  useEffect(() => {
    if (img.current?.complete && img.current.naturalWidth) onLoaded();
  }, [onLoaded]);
  if (failed)
    return (
      <span className="img-prev failed" role="group" aria-label={label}>
        <span className="img-missing" style={{ aspectRatio: ratio }}>
          <span>Изображение недоступно</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            Повторить
          </button>
        </span>
        {pic.caption && <span className="img-cap">{pic.caption}</span>}
      </span>
    );
  const src = attempt ? `${pic.src}${pic.src.includes('?') ? '&' : '?'}retry=${attempt}` : pic.src;
  return (
    <span className="img-prev" role="group" aria-label={label} style={box.frame}>
      <button type="button" className={`img-open${loaded ? ' loaded' : ''}`} onClick={onOpen} aria-label={`Открыть ${label.toLowerCase()}`} aria-busy={!loaded}>
        <img ref={img} src={src} alt="" loading="lazy" decoding="async" width={pic.width} height={pic.height} style={box.img} onLoad={onLoaded} onError={() => setFailed(true)} />
      </button>
      {pic.caption && <span className="img-cap">{pic.caption}</span>}
    </span>
  );
}

/** The images of one message or tool result; the lightbox steps through this group. */
export function ImageGroup({ pics, className = '' }: { pics: Pic[]; className?: string }) {
  if (!pics.length) return null;
  return (
    // spans: a group may stand inside a Markdown paragraph
    <span className={`img-group ${className}`}>
      {pics.map((p, i) => (
        <ImagePreview key={`${p.src}:${i}`} pic={p} label={pics.length > 1 ? `Изображение ${i + 1} из ${pics.length}` : 'Изображение'} onOpen={() => openLightbox(pics, i)} />
      ))}
    </span>
  );
}

/** Full-size view over the app. On the phone «назад» closes it (a history entry is pushed while it is open). */
export function Lightbox() {
  const { pics, index, open } = useLightbox();
  if (!open || !pics.length) return null;
  return <LightboxDialog pics={pics} index={Math.min(index, pics.length - 1)} />;
}

function LightboxDialog({ pics, index }: { pics: Pic[]; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const pushed = useRef(false);
  const startX = useRef<number | null>(null);
  const pic = pics[index]!;
  const go = (d: number) => {
    const next = index + d;
    if (next < 0 || next >= pics.length) return;
    setZoom(false);
    setFailed(false);
    useLightbox.setState({ index: next });
  };
  const close = () => {
    closeLightbox();
    if (pushed.current) {
      pushed.current = false;
      history.back();
    }
  };
  useDialog(ref, close);

  useEffect(() => {
    // «назад» (phone, browser button) closes the lightbox instead of leaving the page; one entry even when the effect
    // runs twice (StrictMode), otherwise the next «назад» would land on the lightbox entry again
    if (!(history.state as { lightbox?: boolean } | null)?.lightbox) history.pushState({ ...(history.state as object | null), lightbox: true }, '');
    pushed.current = true;
    const onPop = () => {
      pushed.current = false;
      closeLightbox();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const onDown = (e: RPointerEvent) => {
    startX.current = e.clientX;
  };
  const onUp = (e: RPointerEvent) => {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
  };

  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={pics.length > 1 ? `Изображение ${index + 1} из ${pics.length}` : 'Изображение'}
      ref={ref}
      onPointerDown={onDown}
      onPointerUp={onUp}
    >
      <div className="lb-bar">
        <span className="lb-caption">
          {pics.length > 1 && `${index + 1} / ${pics.length} · `}
          {pic.caption}
        </span>
        {pic.original && (
          <a className="btn" href={pic.original} target="_blank" rel="noopener noreferrer">
            Открыть оригинал
          </a>
        )}
        <button type="button" className="btn" onClick={close}>
          Закрыть
        </button>
      </div>
      <div
        className={`lb-stage${zoom ? ' zoom' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget) close();
        }}
      >
        {failed ? (
          <div className="img-missing">Изображение недоступно</div>
        ) : (
          <img
            src={pic.src}
            alt=""
            width={pic.width}
            height={pic.height}
            onError={() => setFailed(true)}
            onClick={e => {
              const im = e.currentTarget;
              // 100 % only makes sense when the picture is bigger than the window
              if (zoom || im.naturalWidth > im.clientWidth + 1 || im.naturalHeight > im.clientHeight + 1) setZoom(!zoom);
            }}
          />
        )}
      </div>
      {pics.length > 1 && (
        <>
          <button type="button" className="icon-btn lb-prev" aria-label="Предыдущее" disabled={index === 0} onClick={() => go(-1)}>
            ←
          </button>
          <button type="button" className="icon-btn lb-next" aria-label="Следующее" disabled={index === pics.length - 1} onClick={() => go(1)}>
            →
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
