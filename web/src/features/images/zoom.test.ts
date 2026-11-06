// Unit tests of the lightbox geometry (change image-viewer, task 1.1).
// Requirements (image-viewer): Масштаб в лайтбоксе; Перемещение увеличенной картинки.
import { describe, expect, it } from 'vitest';
import { MAX_SCALE, canPan, clampOffset, clampScale, fitScale, stepScale, wheelFactor, zoomAt } from './zoom';

const pic = { w: 2560, h: 1440 };
const stage = { w: 1280, h: 720 };

describe('zoom geometry', () => {
  it('fitScale: the whole picture in the stage, a small one never stretched', () => {
    expect(fitScale(pic, stage)).toBe(0.5);
    expect(fitScale({ w: 400, h: 300 }, stage)).toBe(1);
    expect(fitScale({ w: 1000, h: 2000 }, stage)).toBe(0.36);
    expect(fitScale({ w: 0, h: 0 }, stage)).toBe(1);
  });

  it('stepScale: ×1,25 a step, within «вписать» … 800 %', () => {
    expect(stepScale(0.5, 1, 0.5)).toBe(0.625);
    expect(Math.round(stepScale(0.625, 1, 0.5) * 100)).toBe(78);
    expect(stepScale(0.5, -1, 0.5)).toBe(0.5);
    expect(stepScale(7, 1, 0.5)).toBe(MAX_SCALE);
    expect(clampScale(20, 0.5)).toBe(MAX_SCALE);
  });

  it('clampOffset: no edge moves inside the stage, a short side stays centred', () => {
    expect(clampOffset({ x: 5000, y: -5000 }, pic, stage, 1)).toEqual({ x: 640, y: -360 });
    expect(clampOffset({ x: 100, y: 100 }, pic, stage, 0.5)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: 100, y: 100 }, { w: 2560, h: 400 }, stage, 1)).toEqual({ x: 100, y: 0 });
  });

  it('canPan: only a picture larger than the stage', () => {
    expect(canPan(pic, stage, 0.5)).toBe(false);
    expect(canPan(pic, stage, 0.6)).toBe(true);
  });

  it('zoomAt: the point under the cursor stays where it is', () => {
    const at = { x: 200, y: -100 };
    const view = { scale: 0.5, offset: { x: 0, y: 0 } };
    const next = zoomAt(view, 1, at, pic, stage);
    expect(next.scale).toBe(1);
    // the picture point under the cursor: (at − offset) / scale is the same before and after
    expect((at.x - next.offset.x) / next.scale).toBeCloseTo((at.x - view.offset.x) / view.scale);
    expect((at.y - next.offset.y) / next.scale).toBeCloseTo((at.y - view.offset.y) / view.scale);
    // back to «вписать»: centred again
    expect(zoomAt(next, 0.1, at, pic, stage)).toEqual({ scale: 0.5, offset: { x: 0, y: 0 } });
  });

  it('wheelFactor: up enlarges, down shrinks, lines and pages in pixels', () => {
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0)).toBeLessThan(1);
    expect(wheelFactor(1, 1)).toBeCloseTo(wheelFactor(16, 0));
    expect(wheelFactor(1, 2)).toBeCloseTo(wheelFactor(400, 0));
  });
});
