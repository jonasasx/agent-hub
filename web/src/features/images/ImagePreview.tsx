/**
 * Image previews in the chat and the lightbox (design.md D19 «Агент → пользователь»).
 * Requirements (chat-images): Изображения от агента в чате — lazy `<img>` from the hub copy with the place reserved
 * by width/height and the caption «PNG · 1280×720 · 184 КБ», «Изображение недоступно» + «Повторить»;
 * Полный размер изображения — the lightbox: Esc, a click outside, «Закрыть», «назад» on the phone, «Открыть оригинал».
 * Change image-viewer: Масштаб в лайтбоксе (zoom.ts), Перемещение увеличенной картинки, Листание картинок сессии (D3).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useT } from '../../i18n';
import { useDialog } from '../ui/a11y';
import { blobUrl, imageCaption, type ImageRef } from './format';
import { MAX_SCALE, canPan, clampOffset, clampScale, fitScale, stepScale, wheelFactor, zoomAt, type Offset, type Size } from './zoom';

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

/** The picture of each preview button in the feed: the lightbox steps through all of them in the session (design D3). */
const picByButton = new WeakMap<HTMLElement, Pic>();

/**
 * All pictures of the chat the button stands in, in the order of the feed, and the place of the button among them.
 * A nested chat (a subagent) is a chat of its own. Null outside a chat or for an unregistered button.
 */
export function sessionPics(el: HTMLElement): { pics: Pic[]; index: number } | null {
  const chat = el.closest('section.chat');
  if (!chat) return null;
  const pics: Pic[] = [];
  let index = -1;
  for (const button of chat.querySelectorAll<HTMLElement>('.img-open')) {
    if (button.closest('section.chat') !== chat) continue;
    const pic = picByButton.get(button);
    if (!pic) continue;
    if (button === el) index = pics.length;
    pics.push(pic);
  }
  return index < 0 ? null : { pics, index };
}

/** A preview with its caption; place is reserved by width/height before the image arrives. */
export function ImagePreview({ pic, onOpen, label }: { pic: Pic; onOpen: (el: HTMLElement) => void; label: string }) {
  const t = useT();
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
          <span>{t('chat.images.unavailable')}</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            {t('chat.images.retry')}
          </button>
        </span>
        {pic.caption && <span className="img-cap">{pic.caption}</span>}
      </span>
    );
  const src = attempt ? `${pic.src}${pic.src.includes('?') ? '&' : '?'}retry=${attempt}` : pic.src;
  return (
    <span className="img-prev" role="group" aria-label={label} style={box.frame}>
      <button
        type="button"
        ref={el => {
          if (el) picByButton.set(el, pic);
        }}
        className={`img-open${loaded ? ' loaded' : ''}`}
        onClick={e => onOpen(e.currentTarget)}
        aria-label={t('chat.images.open', { label: label.toLowerCase() })}
        aria-busy={!loaded}
      >
        <img ref={img} src={src} alt="" loading="lazy" decoding="async" width={pic.width} height={pic.height} style={box.img} onLoad={onLoaded} onError={() => setFailed(true)} />
      </button>
      {pic.caption && <span className="img-cap">{pic.caption}</span>}
    </span>
  );
}

/** The images of one message or tool result; the lightbox steps through all images of the session, this group outside a chat. */
export function ImageGroup({ pics, className = '' }: { pics: Pic[]; className?: string }) {
  const t = useT();
  if (!pics.length) return null;
  return (
    // spans: a group may stand inside a Markdown paragraph
    <span className={`img-group ${className}`}>
      {pics.map((p, i) => (
        <ImagePreview
          key={`${p.src}:${i}`}
          pic={p}
          label={pics.length > 1 ? t('chat.images.labelOf', { n: i + 1, total: pics.length }) : t('chat.images.label')}
          onOpen={el => {
            const session = sessionPics(el);
            if (session) openLightbox(session.pics, session.index);
            else openLightbox(pics, i);
          }}
        />
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

interface View {
  scale: number;
  offset: Offset;
}

/** A gesture of the pointers on the stage (design D2). */
interface Gesture {
  kind: 'pan' | 'swipe' | 'pinch';
  start: Offset;
  view: View;
  /** Pinch: the distance between the fingers and their midpoint (from the centre of the stage) at the start. */
  dist?: number;
  mid?: Offset;
}

/** A move longer than this is a drag: the click after it neither closes the lightbox nor toggles the scale. */
const DRAG_PX = 4;
/** A horizontal swipe longer than this steps to the next picture. */
const SWIPE_PX = 50;
const EPS = 1e-6;

function LightboxDialog({ pics, index }: { pics: Pic[]; index: number }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const pic = pics[index]!;
  // the natural size: from the hub at once, from the picture itself once it has loaded
  const [natural, setNatural] = useState<Size>({ w: pic.width ?? 0, h: pic.height ?? 0 });
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  // null — «Вписать», follows the size of the window
  const [zoom, setZoom] = useState<View | null>(null);
  const pushed = useRef(false);
  const pointers = useRef(new Map<number, Offset>());
  const gesture = useRef<Gesture | null>(null);
  const dragged = useRef(false);

  const known = natural.w > 0 && natural.h > 0 && stage.w > 0 && stage.h > 0;
  const fit = fitScale(natural, stage);
  const scale = zoom ? clampScale(zoom.scale, fit) : fit;
  const offset = zoom ? clampOffset(zoom.offset, natural, stage, scale) : { x: 0, y: 0 };
  const view: View = { scale, offset };
  const pannable = known && canPan(natural, stage, scale);
  // handlers registered outside React (the wheel) and the gestures read the current state through this
  const live = useRef({ view, natural, stage, known, pannable });
  live.current = { view, natural, stage, known, pannable };

  const setView = (next: View) => {
    const s = live.current;
    setZoom({ scale: next.scale, offset: clampOffset(next.offset, s.natural, s.stage, next.scale) });
  };
  const zoomTo = (next: number, at: Offset = { x: 0, y: 0 }) => {
    const s = live.current;
    setZoom(zoomAt(s.view, next, at, s.natural, s.stage));
  };
  const go = (d: number) => {
    const next = index + d;
    if (next < 0 || next >= pics.length) return;
    setZoom(null);
    setFailed(false);
    setNatural({ w: pics[next]!.width ?? 0, h: pics[next]!.height ?? 0 });
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

  // the size of the stage: «Вписать» follows the window
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the wheel zooms at the cursor; React's onWheel is passive and cannot keep the page from scrolling
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = live.current;
      if (!s.known) return;
      const next = s.view.scale * wheelFactor(e.deltaY, e.deltaMode);
      setZoom(zoomAt(s.view, next, pointAt(el, e.clientX, e.clientY), s.natural, s.stage));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = live.current;
      const fitNow = fitScale(s.natural, s.stage);
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      } else if (s.known && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        zoomTo(stepScale(s.view.scale, 1, fitNow));
      } else if (s.known && e.key === '-') {
        e.preventDefault();
        zoomTo(stepScale(s.view.scale, -1, fitNow));
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom(null);
      } else if (s.pannable && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const dy = (e.key === 'ArrowDown' ? -0.2 : 0.2) * s.stage.h;
        setView({ scale: s.view.scale, offset: { x: s.view.offset.x, y: s.view.offset.y + dy } });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const startGesture = () => {
    const pts = [...pointers.current.values()];
    const s = live.current;
    if (pts.length >= 2 && frame.current) {
      const [a, b] = pts as [Offset, Offset];
      const mid = pointAt(frame.current, (a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.current = { kind: 'pinch', start: mid, view: s.view, dist: Math.hypot(a.x - b.x, a.y - b.y), mid };
    } else if (pts.length === 1) {
      gesture.current = { kind: s.pannable ? 'pan' : 'swipe', start: pts[0]!, view: s.view };
    } else {
      gesture.current = null;
    }
  };
  // the capture is taken once a press turns into a drag: Chromium sends the click of a captured pointer to the stage,
  // and a plain click must reach the picture (fit ↔ 100 %) or the background (close)
  const capture = (e: RPointerEvent<HTMLDivElement>) => {
    try {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom, or the pointer is already gone
    }
  };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // the arrows keep their own clicks
    if (e.target instanceof Element && e.target.closest('button, a')) return;
    if (!pointers.current.size) dragged.current = false;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
    // a pinch follows both fingers even off the stage
    if (pointers.current.size > 1) capture(e);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && frame.current && g.mid) {
      const [a, b] = [...pointers.current.values()] as [Offset, Offset];
      const mid = pointAt(frame.current, (a.x + b.x) / 2, (a.y + b.y) / 2);
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / (g.dist || 1);
      const s = live.current;
      const z = zoomAt(g.view, g.view.scale * ratio, g.mid, s.natural, s.stage);
      dragged.current = true;
      setView({ scale: z.scale, offset: { x: z.offset.x + mid.x - g.mid.x, y: z.offset.y + mid.y - g.mid.y } });
      return;
    }
    const dx = e.clientX - g.start.x;
    const dy = e.clientY - g.start.y;
    if (Math.abs(dx) > DRAG_PX || Math.abs(dy) > DRAG_PX) {
      dragged.current = true;
      capture(e);
    }
    if (g.kind === 'pan') setView({ scale: g.view.scale, offset: { x: g.view.offset.x + dx, y: g.view.offset.y + dy } });
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g?.kind === 'swipe' && !pointers.current.size) {
      const dx = e.clientX - g.start.x;
      const dy = e.clientY - g.start.y;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    }
    // the finger left after a pinch moves the picture on from where it is now
    startGesture();
  };
  const onCancel = (e: RPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    startGesture();
  };

  const imgStyle: CSSProperties | undefined = known
    ? { width: `${natural.w}px`, height: `${natural.h}px`, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})` }
    : undefined;
  const zoomed = scale > fit + EPS;

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={pics.length > 1 ? t('chat.images.labelOf', { n: index + 1, total: pics.length }) : t('chat.images.label')} ref={ref}>
      <div className="lb-bar">
        <span className="lb-caption">
          {pics.length > 1 && `${index + 1} / ${pics.length} · `}
          {pic.caption}
        </span>
        {known && !failed && (
          <span className="lb-zoom" role="group" aria-label={t('chat.images.zoom')}>
            <button type="button" className="btn" aria-label={t('chat.images.zoomOut')} disabled={!zoomed} onClick={() => zoomTo(stepScale(scale, -1, fit))}>
              −
            </button>
            <output className="lb-pct" aria-live="polite">
              {Math.round(scale * 100)}%
            </output>
            <button type="button" className="btn" aria-label={t('chat.images.zoomIn')} disabled={scale >= Math.max(MAX_SCALE, fit) - EPS} onClick={() => zoomTo(stepScale(scale, 1, fit))}>
              +
            </button>
            <button type="button" className="btn" disabled={!zoom || !zoomed} onClick={() => setZoom(null)}>
              {t('chat.images.fit')}
            </button>
            <button type="button" className="btn" disabled={Math.abs(scale - 1) < EPS} onClick={() => zoomTo(1)}>
              100%
            </button>
          </span>
        )}
        {pic.original && (
          <a className="btn" href={pic.original} target="_blank" rel="noopener noreferrer">
            {t('chat.images.openOriginal')}
          </a>
        )}
        <button type="button" className="btn" onClick={close}>
          {t('chat.images.close')}
        </button>
      </div>
      <div className="lb-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
        <div
          ref={frame}
          className={`lb-frame${known ? ' sized' : ''}${pannable ? ' pannable' : ''}`}
          onClick={e => {
            if (dragged.current) return;
            if (e.target === e.currentTarget) close();
          }}
        >
          {failed ? (
            <div className="img-missing">{t('chat.images.unavailable')}</div>
          ) : (
            <img
              key={pic.src}
              src={pic.src}
              alt=""
              draggable={false}
              width={pic.width}
              height={pic.height}
              style={imgStyle}
              className={fit < 1 - EPS ? (zoomed ? 'zoomed' : 'zoomable') : undefined}
              onLoad={e => {
                const im = e.currentTarget;
                if (!im.naturalWidth || !im.naturalHeight) return;
                if (im.naturalWidth !== natural.w || im.naturalHeight !== natural.h) setNatural({ w: im.naturalWidth, h: im.naturalHeight });
              }}
              onError={() => setFailed(true)}
              onClick={e => {
                if (dragged.current || !known || !frame.current) return;
                // «вписать ↔ 100 %» at the clicked point; a picture smaller than the window stays as it is
                if (zoomed) setZoom(null);
                else if (fit < 1 - EPS) zoomTo(1, pointAt(frame.current, e.clientX, e.clientY));
              }}
            />
          )}
        </div>
        {pics.length > 1 && (
          <>
            <button type="button" className="icon-btn lb-prev" aria-label={t('chat.images.prev')} disabled={index === 0} onClick={() => go(-1)}>
              ←
            </button>
            <button type="button" className="icon-btn lb-next" aria-label={t('chat.images.next')} disabled={index === pics.length - 1} onClick={() => go(1)}>
              →
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A client point measured from the centre of the stage. */
function pointAt(el: HTMLElement, clientX: number, clientY: number): Offset {
  const r = el.getBoundingClientRect();
  return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
}
