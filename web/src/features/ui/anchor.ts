/**
 * The place of a desktop popover under the button that opened it (change pane-anchored-popovers): with several panes
 * the button of the session's own pane, not the window's corner or another pane's button. The popover sits in a
 * `.scrim.sub-scrim` (`place-items: start end`), so its place is the scrim's padding: the top under the button, the right
 * edge under the button's right edge, shifted left only as far as needed to keep the whole popover in the window.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const EDGE = 12;
const GAP = 6;

/** The scrim padding for a popover `width` wide under `r`. */
export function anchorBelow(r: DOMRect, width: number): CSSProperties {
  const right = Math.round(window.innerWidth - r.right);
  const fit = Math.round(window.innerWidth - width - EDGE);
  return { paddingTop: Math.round(r.bottom + GAP), paddingRight: Math.max(EDGE, Math.min(right, fit)) };
}

/** The first shown element of `sel` in `scope` (a hidden copy, e.g. the other layout of a narrow pane, is skipped). */
export function shownRect(scope: ParentNode, sel: string): DOMRect | undefined {
  return Array.from(scope.querySelectorAll<HTMLElement>(sel))
    .map(b => b.getBoundingClientRect())
    .find(r => r.width > 0);
}

/**
 * The scrim style while `on`: `place()` gives the scrim padding (e.g. `anchorBelow` of the opener) or undefined for the
 * place by CSS; it is computed again on resize.
 */
export function useScrimAnchor(on: boolean, place: () => CSSProperties | undefined): CSSProperties | undefined {
  const [pos, setPos] = useState<CSSProperties | undefined>(undefined);
  const placeRef = useRef(place);
  placeRef.current = place;
  useLayoutEffect(() => {
    if (!on) {
      setPos(undefined);
      return;
    }
    const update = () => setPos(placeRef.current());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [on]);
  return pos;
}
