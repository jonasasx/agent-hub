import { describe, expect, it } from 'vitest';

// Requirement (chat-images): Изображения от агента в чате — the place is reserved by width/height.
describe('previewBox (the place of a preview, bug from Ivan M4a)', () => {
  it('fits 320×240 at the ratio of the image, never wider than the image; a compact frame without the size', async () => {
    const { previewBox } = await import('./ImagePreview');
    expect(previewBox(560, 560)!.frame.width).toBe('240px');
    expect(previewBox(1280, 720)!.frame.width).toBe('320px');
    expect(previewBox(100, 50)!.frame.width).toBe('100px');
    expect(previewBox(400, 2000)!.frame.width).toBe('48px');
    expect(previewBox(560, 560)!.img.aspectRatio).toBe('560 / 560');
    expect(previewBox(undefined, 10)).toEqual({ frame: { width: '160px' }, img: expect.objectContaining({ height: '120px', objectFit: 'contain' }) });
    // the CSS height limit min(240px, 60vh) is not overridden inline
    expect(previewBox(560, 560).img).not.toHaveProperty('maxHeight');
    expect(previewBox(undefined, undefined).img).not.toHaveProperty('maxHeight');
  });
});

describe('ImagePreview without the size (review M4a)', () => {
  it('compact until it loads, then min(natural, 320×240): a small picture is not stretched, a big one fits', async () => {
    const { render, fireEvent } = await import('@testing-library/react');
    const { ImagePreview } = await import('./ImagePreview');
    const frameOf = async (w: number, h: number) => {
      const r = render(<ImagePreview pic={{ src: `blob:x-${w}` }} label="Изображение" onOpen={() => undefined} />);
      const frame = r.container.querySelector<HTMLElement>('.img-prev')!;
      const img = r.container.querySelector('img')!;
      const pending = frame.style.width;
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h });
      fireEvent.load(img);
      const after = frame.style.width;
      r.unmount();
      return [pending, after];
    };
    expect(await frameOf(100, 80)).toEqual(['160px', '100px']);
    expect(await frameOf(1600, 900)).toEqual(['160px', '320px']);
    expect(await frameOf(300, 600)).toEqual(['160px', '120px']);
  });
});
