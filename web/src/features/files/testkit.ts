// Helpers of the file explorer tests: a stub of the file routes of the hub.
import { vi } from 'vitest';

export interface FsStub {
  /** Listings by path ('' is the root). */
  list: Record<string, unknown>;
  /** Files by path: kind, body, status; `download` — the answer of the download probe when it is not a success. */
  files: Record<string, { kind?: string; body?: BodyInit; status?: number; json?: unknown; mime?: string; download?: { status: number; json: unknown } }>;
}

export function stubFs(stub: FsStub) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const u = new URL(url, 'http://x');
      const path = u.searchParams.get('path') ?? '';
      if (u.pathname.endsWith('/fs/list')) {
        const r = stub.list[path];
        if (r === undefined) return Response.json({ error: 'not_found' }, { status: 404 });
        if (r && typeof r === 'object' && 'error' in r) return Response.json(r, { status: (r as { status?: number }).status ?? 500 });
        return Response.json(r);
      }
      const f = stub.files[path];
      if (!f) return Response.json({ error: 'not_found' }, { status: 404 });
      if (u.pathname.endsWith('/fs/download')) {
        if (f.download) return Response.json(f.download.json, { status: f.download.status });
        return Response.json({ name: path.split('/').pop(), size: typeof f.body === 'string' ? f.body.length : 10, mtimeMs: 1 });
      }
      if (f.json) return Response.json(f.json, { status: f.status ?? 500 });
      const body = f.body ?? '';
      return new Response(body, {
        status: f.status ?? 200,
        headers: { 'content-type': f.mime ?? 'text/plain', 'x-file-kind': f.kind ?? 'text', 'x-file-size': String(typeof body === 'string' ? body.length : 10) },
      });
    }),
  );
  return calls;
}

export const dir = (path: string, names: Array<string | { name: string; kind?: string; blocked?: boolean }>, extra: object = {}) => ({
  path,
  entries: names.map(n => (typeof n === 'string' ? { name: n, kind: n.includes('.') ? 'file' : 'dir' } : { kind: 'file', ...n })),
  truncated: false,
  total: names.length,
  ...extra,
});
