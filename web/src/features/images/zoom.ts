/**
 * Geometry of the lightbox view (change image-viewer, design D1). The picture stands in the centre of the stage at its
 * natural size; the view is `translate(x, y) scale(s)`, the offset measured from the centre of the stage.
 * Requirements (image-viewer): Масштаб в лайтбоксе; Перемещение увеличенной картинки.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Offset {
  x: number;
  y: number;
}

/** 800 % of the natural size. */
export const MAX_SCALE = 8;
/** One press of «+» / «−». */
export const STEP = 1.25;

/** «Вписать»: the whole picture in the stage, a small one at its natural size (never stretched). */
export function fitScale(natural: Size, stage: Size): number {
  if (!natural.w || !natural.h || !stage.w || !stage.h) return 1;
  return Math.min(1, stage.w / natural.w, stage.h / natural.h);
}

/** The scale kept within «вписать» … 800 %. */
export function clampScale(scale: number, fit: number): number {
  return Math.min(Math.max(scale, fit), Math.max(MAX_SCALE, fit));
}

/** No edge of the picture moves inside the stage; along a side shorter than the stage it stays centred. */
export function clampOffset(offset: Offset, natural: Size, stage: Size, scale: number): Offset {
  const maxX = Math.max(0, (natural.w * scale - stage.w) / 2);
  const maxY = Math.max(0, (natural.h * scale - stage.h) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

/** The picture is larger than the stage along at least one side (it can be moved). */
export function canPan(natural: Size, stage: Size, scale: number): boolean {
  return natural.w * scale > stage.w + 0.5 || natural.h * scale > stage.h + 0.5;
}

/**
 * A new scale with the point `at` (from the centre of the stage) staying where it is: the wheel at the cursor, a pinch
 * between the fingers. The result is clamped.
 */
export function zoomAt(view: { scale: number; offset: Offset }, next: number, at: Offset, natural: Size, stage: Size): { scale: number; offset: Offset } {
  const fit = fitScale(natural, stage);
  const scale = clampScale(next, fit);
  const k = scale / view.scale;
  const offset = {
    x: at.x - (at.x - view.offset.x) * k,
    y: at.y - (at.y - view.offset.y) * k,
  };
  return { scale, offset: clampOffset(offset, natural, stage, scale) };
}

/** «+» / «−»: one step from the current scale. */
export function stepScale(scale: number, dir: 1 | -1, fit: number): number {
  return clampScale(dir > 0 ? scale * STEP : scale / STEP, fit);
}

/** The wheel: pixels of `deltaY` (lines and pages turned into pixels) into a scale factor. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * 0.002);
}
