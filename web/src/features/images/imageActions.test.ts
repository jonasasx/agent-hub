import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { copyImage, downloadImage, imageFileName } from './imageActions';

const SHA = 'a'.repeat(64);

describe('imageActions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names a file by the blob address and the type', () => {
    expect(imageFileName(`/api/blobs/${SHA}`, 'image/jpeg')).toBe('image-aaaaaaaa.jpg');
    expect(imageFileName(`/api/blobs/${SHA}?retry=1`, 'image/png')).toBe('image-aaaaaaaa.png');
  });

  it('downloads through a hidden link with the file name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { headers: { 'content-type': 'image/webp' } })));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    let name = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    await downloadImage(`/api/blobs/${SHA}`);
    expect(click).toHaveBeenCalled();
    expect(name).toBe('image-aaaaaaaa.webp');
    click.mockRestore();
  });

  it('puts a PNG on the clipboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { headers: { 'content-type': 'image/png' } })));
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public items: Record<string, unknown>) {}
      },
    );
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    await copyImage(`/api/blobs/${SHA}`);
    expect(write).toHaveBeenCalledTimes(1);
    expect(Object.keys((write.mock.calls[0]![0][0] as { items: object }).items)).toEqual(['image/png']);
  });

  it('reports a failed copy with a toast', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const before = useStore.getState().toasts?.length ?? 0;
    await copyImage(`/api/blobs/${SHA}`);
    expect(useStore.getState().toasts?.length ?? 0).toBeGreaterThan(before);
  });
});
