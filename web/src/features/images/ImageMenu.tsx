/**
 * The context menu of a picture (right click, long press on the phone): «Копировать», «Скачать», «Открыть оригинал».
 * Stands over the lightbox, which is why it is a portal of its own with a z-index above it.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import { useMenu } from '../ui/a11y';
import { copyImage, downloadImage } from './imageActions';
import type { Pic } from './ImagePreview';

const EDGE = 8;

export function ImageMenu({ pic, x, y, onClose }: { pic: Pic; x: number; y: number; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  useMenu(true, ref, onClose);
  // keep the menu inside the window: it opens at the pointer, shifted left/up when it would not fit
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({ x: Math.max(EDGE, Math.min(x, window.innerWidth - r.width - EDGE)), y: Math.max(EDGE, Math.min(y, window.innerHeight - r.height - EDGE)) });
  }, [x, y]);
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return createPortal(
    <div ref={ref} className="menu img-menu" role="menu" aria-label={t('chat.images.label')} style={{ left: at.x, top: at.y, zIndex: 1000, minWidth: 200 }} onContextMenu={e => e.preventDefault()}>
      <button type="button" role="menuitem" onClick={run(() => void copyImage(pic.src))}>
        {t('chat.images.copy')}
      </button>
      <button type="button" role="menuitem" onClick={run(() => void downloadImage(pic.src))}>
        {t('chat.images.download')}
      </button>
      {pic.original && (
        <button type="button" role="menuitem" onClick={run(() => window.open(pic.original, '_blank', 'noopener,noreferrer'))}>
          {t('chat.images.openOriginal')}
        </button>
      )}
    </div>,
    document.body,
  );
}
