/**
 * «Скачать» and «Копировать» of the open picture in the lightbox. The picture is read from the hub copy (or a local object URL)
 * once; the download hands it to the browser by a hidden link, the copy puts it on the clipboard as PNG (the only image type
 * every browser accepts there), re-drawing a JPEG/GIF/WebP through a canvas.
 */
import { t } from '../../i18n';
import { useStore } from '../../store';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

async function readBlob(src: string): Promise<Blob> {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** The file name of a picture: `image-<tail of the address>.<extension by the type>`. */
export function imageFileName(src: string, mime: string): string {
  const tail = src.split('?')[0]!.split('/').pop() ?? '';
  const id = /^[0-9a-f]{64}$/i.test(tail) ? tail.slice(0, 8) : String(Date.now());
  return `image-${id}.${EXT[mime] ?? 'png'}`;
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
  } finally {
    bitmap.close();
  }
}

function toast(title: string, bad = false): void {
  useStore.getState().pushToast({ title, text: '', color: bad ? 'var(--bad)' : 'var(--accent)' });
}

export async function downloadImage(src: string): Promise<void> {
  try {
    const blob = await readBlob(src);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = imageFileName(src, blob.type);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    toast(t('chat.images.downloadFailed'), true);
  }
}

export async function copyImage(src: string): Promise<void> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('clipboard unavailable');
    // the item takes a promise: the write is started inside the click, before the picture is read (Safari requires it)
    const png = readBlob(src).then(toPng);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(t('chat.images.copied'));
  } catch {
    toast(t('chat.images.copyFailed'), true);
  }
}
