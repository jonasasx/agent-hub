// Large tool output (design D4 «Большой вывод»): Claude Code keeps it in `<session>/tool-results/<name>` and puts
// `<persisted-output>… saved to: <path> … Preview (first 2KB)` into the tool_result. The agent copies the file to S3
// `side/<runner>/<session>/tool-results/<name>`; the event gets a link to that copy, which the hub serves as text.
// Requirement: Большой вывод команды → Показать полностью.
import type { SideFileRef } from '@agent-hub/shared';

const SAVED = /saved to:\s*(.+?)[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]tool-results[\\/]([A-Za-z0-9._-]{1,200})/gi;

/** Names of side files a transcript line points to, with the session id from the path. */
export function persistedOutputs(line: unknown): Array<{ sid: string; name: string }> {
  const out = new Map<string, { sid: string; name: string }>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (!v.includes('<persisted-output>')) return;
      for (const m of v.matchAll(SAVED)) {
        const sid = m[2]!.toLowerCase();
        const name = m[3]!;
        if (name.includes('..')) continue;
        out.set(`${sid}/${name}`, { sid, name });
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(line);
  return [...out.values()];
}

/** Links of the line's side files for `GET /api/sessions/:id/tool-results/:name?sid=`; none → undefined. */
export function sideFileRefs(hubSessionId: string, line: unknown): SideFileRef[] | undefined {
  const files = persistedOutputs(line);
  if (!files.length) return undefined;
  return files.map(f => ({ name: f.name, url: `/api/sessions/${hubSessionId}/tool-results/${encodeURIComponent(f.name)}?sid=${f.sid}` }));
}
