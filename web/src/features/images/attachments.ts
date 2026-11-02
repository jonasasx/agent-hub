/**
 * Images attached to a message in this window (design.md D19 «Пользователь → агент»): thumbnails over the composer,
 * normalisation, upload with progress, at most 10 per message. Kept in memory per session (key `new` — the
 * new-session form): they survive switching tabs, not a reload (D19).
 * Requirement (chat-images): Прикрепление изображений к сообщению; Форматы и размеры изображений пользователя.
 */
import { create } from 'zustand';
import { ApiError, uploadImage, type AttachmentRef } from '../../api/client';
import { MAX_ATTACHMENTS, normalizeImage, type Codec } from './normalize';
import { blobUrl } from './format';

export interface Attachment {
  id: string;
  name: string;
  /** Object URL of the picked file (thumbnail before the upload ends; optimistic preview after sending). */
  url: string;
  status: 'processing' | 'uploading' | 'ready' | 'error';
  progress: number;
  error?: string;
  sha256?: string;
  mime?: string;
  width?: number;
  height?: number;
}

/** A message sent with images whose user line has not come back from the replica yet. */
export interface OptimisticMessage {
  clientUuid: string;
  text: string;
  images: { url: string; width?: number; height?: number; sha256?: string }[];
  /** The last event of the chat when the message was sent: the copy stands right after it, not always at the end. */
  afterEventId?: string | null;
  sentAt?: number;
}

interface State {
  byKey: Record<string, Attachment[]>;
  /** Hint or error under the composer («Не больше 10 изображений…», «Обновите агент…»). */
  note: Record<string, string | undefined>;
  /** «Повторить» next to the note: the same message again (502 attachment_delivery_failed, D19). */
  retry: Record<string, (() => void) | undefined>;
  optimistic: Record<string, OptimisticMessage[]>;
}

export const useAttachments = create<State>()(() => ({ byKey: {}, note: {}, retry: {}, optimistic: {} }));

const st = () => useAttachments.getState();
let seq = 0;

function patch(key: string, id: string, p: Partial<Attachment>) {
  const list = st().byKey[key];
  if (!list) return;
  useAttachments.setState({ byKey: { ...st().byKey, [key]: list.map(a => (a.id === id ? { ...a, ...p } : a)) } });
}

export function setNote(key: string, note: string | undefined, retry?: () => void) {
  useAttachments.setState({ note: { ...st().note, [key]: note }, retry: { ...st().retry, [key]: retry } });
}

// uploads run at most 3 at a time (D19 p. 3)
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 3) await new Promise<void>(r => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function uploadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return 'Файл больше 4 МБ после сжатия';
    if (err.code === 'not_image') return 'Формат не поддерживается: PNG, JPEG, GIF, WebP';
    if (err.code === 'image_too_large') return 'Изображение больше 8000 px';
    if (err.serverMessage) return err.serverMessage;
  }
  return 'Не загрузилось — уберите и прикрепите снова';
}

/** Adds files (paste, drop, «Прикрепить»): images beyond 10 are not added and a hint says so. */
export function addFiles(key: string, files: File[], codec?: Codec): void {
  const list = st().byKey[key] ?? [];
  const room = MAX_ATTACHMENTS - list.length;
  const taken = files.slice(0, Math.max(0, room));
  setNote(key, files.length > taken.length ? `Не больше ${MAX_ATTACHMENTS} изображений в сообщении` : undefined);
  if (!taken.length) return;
  const added: Attachment[] = taken.map(f => ({ id: `a${++seq}`, name: f.name || 'изображение', url: URL.createObjectURL(f), status: 'processing', progress: 0 }));
  useAttachments.setState({ byKey: { ...st().byKey, [key]: [...list, ...added] } });
  taken.forEach((file, i) => void prepare(key, added[i]!.id, file, codec));
}

async function prepare(key: string, id: string, file: File, codec?: Codec) {
  const n = await normalizeImage(file, codec);
  if (!present(key, id)) return;
  if (!n.ok) return patch(key, id, { status: 'error', error: n.error });
  patch(key, id, { status: 'uploading', mime: n.image.mime, width: n.image.width, height: n.image.height });
  try {
    const up = await slot(() => uploadImage(n.image.blob, n.image.mime, f => present(key, id) && patch(key, id, { progress: f })));
    if (present(key, id)) patch(key, id, { status: 'ready', progress: 1, sha256: up.sha256, mime: up.mime, width: up.width, height: up.height });
  } catch (err) {
    if (present(key, id)) patch(key, id, { status: 'error', error: uploadError(err) });
  }
}

const present = (key: string, id: string) => !!st().byKey[key]?.some(a => a.id === id);

export function removeAttachment(key: string, id: string) {
  const list = st().byKey[key] ?? [];
  const a = list.find(x => x.id === id);
  if (a) URL.revokeObjectURL(a.url);
  useAttachments.setState({ byKey: { ...st().byKey, [key]: list.filter(x => x.id !== id) } });
  setNote(key, undefined);
}

export function attachmentsOf(key: string): Attachment[] {
  return st().byKey[key] ?? [];
}

/** Images still being processed or uploaded: the send button waits for them. */
export function busy(key: string): boolean {
  return attachmentsOf(key).some(a => a.status === 'processing' || a.status === 'uploading');
}

/** The uploaded images of the message, in the order they were attached (refused ones are not sent). */
export function readyRefs(key: string): AttachmentRef[] {
  return attachmentsOf(key).flatMap(a => (a.status === 'ready' && a.sha256 ? [{ sha256: a.sha256 }] : []));
}

/** After a message went out: the thumbnails move into an optimistic message until its user line comes back. */
export function sent(key: string, sessionId: string, clientUuid: string, text: string, afterEventId: string | null = null) {
  const list = attachmentsOf(key).filter(a => a.status === 'ready');
  for (const a of attachmentsOf(key)) if (a.status !== 'ready') URL.revokeObjectURL(a.url);
  const byKey = { ...st().byKey };
  delete byKey[key];
  const optimistic = { ...st().optimistic };
  // every message shows «доставляется…» until its user line comes back (M4a preloaders), with or without images
  if (list.length || text)
    optimistic[sessionId] = [
      ...(optimistic[sessionId] ?? []),
      { clientUuid, text, images: list.map(a => ({ url: a.url, width: a.width, height: a.height, sha256: a.sha256 })), afterEventId, sentAt: Date.now() },
    ];
  useAttachments.setState({ byKey, optimistic, note: { ...st().note, [key]: undefined }, retry: { ...st().retry, [key]: undefined } });
}

/**
 * Puts images that already sit on the hub back over the composer (they are not uploaded again): «Повторить» on
 * «Сообщение не доставлено» (M3c contract). Images already attached and those beyond 10 are skipped.
 */
export function restoreAttachments(key: string, refs: { sha256: string; mime?: string; width?: number; height?: number }[]): void {
  const list = attachmentsOf(key);
  const have = new Set(list.flatMap(a => (a.sha256 ? [a.sha256] : [])));
  const add: Attachment[] = refs
    .filter(r => !have.has(r.sha256))
    .slice(0, Math.max(0, MAX_ATTACHMENTS - list.length))
    .map((r, i) => ({
      id: `r${++seq}`,
      name: `Изображение ${list.length + i + 1}`,
      url: blobUrl(r.sha256),
      status: 'ready',
      progress: 1,
      sha256: r.sha256,
      ...(r.mime ? { mime: r.mime } : {}),
      ...(r.width ? { width: r.width } : {}),
      ...(r.height ? { height: r.height } : {}),
    }));
  if (add.length) useAttachments.setState({ byKey: { ...st().byKey, [key]: [...list, ...add] } });
}

/** Drops optimistic messages whose user line (uuid = clientUuid) is in the chat now. */
export function settleOptimistic(sessionId: string, uuids: Set<string>) {
  const list = st().optimistic[sessionId];
  if (!list?.some(m => uuids.has(m.clientUuid))) return;
  for (const m of list) if (uuids.has(m.clientUuid)) for (const i of m.images) URL.revokeObjectURL(i.url);
  useAttachments.setState({ optimistic: { ...st().optimistic, [sessionId]: list.filter(m => !uuids.has(m.clientUuid)) } });
}

/** The files of a paste or drop that may be images (the format is checked by content later). */
export function filesOf(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return [...dt.files];
}

/** Drops the attachments of a composer (the new-session form after the session started). */
export function clearAttachments(key: string) {
  for (const a of attachmentsOf(key)) URL.revokeObjectURL(a.url);
  const byKey = { ...st().byKey };
  delete byKey[key];
  useAttachments.setState({ byKey, note: { ...st().note, [key]: undefined }, retry: { ...st().retry, [key]: undefined } });
}

export function resetAttachments() {
  useAttachments.setState({ byKey: {}, note: {}, retry: {}, optimistic: {} }, true);
}
