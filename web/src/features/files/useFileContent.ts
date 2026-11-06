/**
 * Loads the file of a tab for the viewer (change tool-windows-file-explorer, tasks 6.5/6.8).
 * - a picture by its name is shown by the `<img>` itself (one request); a failure of the `<img>` is probed with a read;
 * - the other files are read through `fsOpenFile` (text, Markdown, PDF) and the class of the machine decides how to show;
 * - the viewer reloads when the machine comes online (`connectNonce`) and on «Повторить».
 * Requirement (file-explorer): Просмотрщик; Машина не в сети и ошибки.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FS_MEDIA_MAX, FS_TEXT_MAX } from '@agent-hub/shared';
import { FsError, fsList, fsOpenFile, isUnsupported } from './filesApi';
import { nameKind } from './fileIcons';
import { useFiles } from './filesStore';
import { baseName, parentOf, samePath } from './paths';

export type Loaded =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'text'; kind: 'text' | 'markdown'; text: string; size: number }
  | { status: 'image'; size: number | null }
  | { status: 'pdf'; data: ArrayBuffer; size: number }
  | { status: 'unsupported'; size: number; mime: string }
  | { status: 'toolarge'; size: number | null; limit: number }
  | { status: 'error'; code: FsError['code']; text: string };

/** The limit that applies to a file by its name: pictures and PDF take the media limit, the rest the text one. */
export function limitByName(name: string): number {
  const k = nameKind(name);
  return k === 'img' || k === 'pdf' ? FS_MEDIA_MAX : FS_TEXT_MAX;
}

async function sizeFromListing(runnerId: string, path: string, sessionId: string | undefined, signal: AbortSignal): Promise<number | null> {
  const dir = parentOf(path);
  if (!dir) return null;
  try {
    const l = await fsList(runnerId, { path: dir, sessionId, hidden: true }, signal);
    const name = baseName(path);
    return l.entries.find(e => e.name === name || samePath(e.name, name))?.size ?? null;
  } catch {
    return null;
  }
}

export interface Content {
  state: Loaded;
  reload: () => void;
  /** The `<img>` could not show the picture: find out why. */
  imageFailed: () => void;
}

export function useFileContent(runnerId: string, path: string, sessionId: string | undefined, online: boolean): Content {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const probe = useRef(false);
  const nonce = useFiles(s => s.connectNonce);

  useEffect(() => {
    probe.current = false;
  }, [runnerId, path, sessionId]);

  useEffect(() => {
    if (!online) {
      setState({ status: 'offline' });
      return;
    }
    const ctl = new AbortController();
    if (nameKind(path) === 'img' && !probe.current) {
      setState({ status: 'image', size: null });
      // the size for the meta comes from the listing of the folder, the picture itself loads by the `<img>`
      void sizeFromListing(runnerId, path, sessionId, ctl.signal).then(size => {
        if (!ctl.signal.aborted && size !== null) setState(cur => (cur.status === 'image' ? { status: 'image', size } : cur));
      });
      return () => ctl.abort();
    }
    setState({ status: 'loading' });
    const run = async () => {
      try {
        const f = await fsOpenFile(runnerId, path, sessionId, ctl.signal);
        if (isUnsupported(f)) return setState({ status: 'unsupported', size: f.size, mime: f.mime });
        if (f.kind !== 'text' && f.kind !== 'markdown' && f.kind !== 'pdf') void f.response.body?.cancel();
        if (f.kind === 'text' || f.kind === 'markdown') return setState({ status: 'text', kind: f.kind, text: await f.response.text(), size: f.size });
        if (f.kind === 'pdf') return setState({ status: 'pdf', data: await f.response.arrayBuffer(), size: f.size });
        if (f.kind === 'image') return setState({ status: 'image', size: f.size });
        return setState({ status: 'unsupported', size: f.size, mime: f.mime });
      } catch (err) {
        if (ctl.signal.aborted) return;
        const e = err instanceof FsError ? err : new FsError('network');
        if (e.code === 'too_large') {
          const size = await sizeFromListing(runnerId, path, sessionId, ctl.signal);
          if (!ctl.signal.aborted) setState({ status: 'toolarge', size, limit: limitByName(path) });
          return;
        }
        setState({ status: 'error', code: e.code, text: e.text('file') });
      }
    };
    void run();
    return () => ctl.abort();
  }, [runnerId, path, sessionId, online, tick, nonce]);

  const reload = useCallback(() => {
    probe.current = false;
    setTick(t => t + 1);
  }, []);
  const imageFailed = useCallback(() => {
    if (probe.current) {
      // the probe already ran and the `<img>` still cannot show the picture: stop, no more requests until «Повторить»
      setState({ status: 'error', code: 'bad_response', text: 'Не удалось показать изображение' });
      return;
    }
    probe.current = true;
    setTick(t => t + 1);
  }, []);
  return { state, reload, imageFailed };
}
