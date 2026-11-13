// Change session-links: UUIDs of the feed that are sessions of the user. Requirement (session-links): Ссылки на сессии.
// D1 — the remark plugin turns UUIDs into `session:` links; D2 — the hub resolves them in batches, the answer is cached.
import { useSyncExternalStore } from 'react';
import type { SessionRefView } from '@agent-hub/shared';
import { api } from '../../api/client';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_ONLY = new RegExp(`^${UUID}$`);
// a UUID not glued to other letters, digits or dashes (a longer hex token is not a UUID)
const UUID_IN_TEXT = new RegExp(`(?<![0-9A-Za-z-])${UUID}(?![0-9A-Za-z-])`, 'g');

export const SESSION_SCHEME = 'session:';

/** The UUID a link points to: `session:<uuid>` or a bare `<uuid>`; null for any other address. */
export function sessionRefOf(href: string | undefined): string | null {
  if (!href) return null;
  const v = href.startsWith(SESSION_SCHEME) ? href.slice(SESSION_SCHEME.length) : href;
  return UUID_ONLY.test(v) ? v.toLowerCase() : null;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

function link(ref: string, child: MdNode): MdNode {
  return { type: 'link', url: SESSION_SCHEME + ref.toLowerCase(), children: [child] };
}

/** Splits a text node at the UUIDs it contains; null when there are none. */
function splitText(value: string): MdNode[] | null {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(UUID_IN_TEXT)) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push(link(m[0], { type: 'text', value: m[0] }));
    last = m.index + m[0].length;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: MdNode): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference' || node.type === 'code') return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value) {
      const parts = splitText(child.value);
      if (parts) {
        next.push(...parts);
        continue;
      }
    }
    if (child.type === 'inlineCode' && child.value && UUID_ONLY.test(child.value.trim())) {
      next.push(link(child.value.trim(), child));
      continue;
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

/** D1: UUIDs in text and in inline code become `session:` links; code blocks and existing links stay as they are. */
export function remarkSessionRefs() {
  return (tree: MdNode) => walk(tree);
}

// ---------- D2: resolving ----------

const NOT_FOUND_TTL_MS = 60_000;
const BATCH_MS = 30;
const MAX_BATCH = 100;

type Entry = { state: 'pending' } | { state: 'found'; ref: SessionRefView } | { state: 'missing'; at: number };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let queued: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const l of listeners) l();
}

async function flush() {
  timer = null;
  const ids = queued;
  queued = [];
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const chunk = ids.slice(i, i + MAX_BATCH);
    let found: SessionRefView[] = [];
    try {
      found = (await api.resolveSessions(chunk)).sessions;
    } catch {
      // the hub is unreachable: the UUIDs stay text and are asked again after the TTL
    }
    const at = Date.now();
    for (const id of chunk) {
      const ref = found.find(r => r.ref === id);
      cache.set(id, ref ? { state: 'found', ref } : { state: 'missing', at });
    }
  }
  notify();
}

function request(id: string) {
  const e = cache.get(id);
  if (e && (e.state !== 'missing' || Date.now() - e.at < NOT_FOUND_TTL_MS)) return;
  cache.set(id, { state: 'pending' });
  queued.push(id);
  timer ??= setTimeout(() => void flush(), BATCH_MS);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The session behind a UUID of the feed; undefined while unknown or not a session of the user. */
export function useSessionRef(id: string): SessionRefView | undefined {
  request(id);
  return useSyncExternalStore(subscribe, () => {
    const e = cache.get(id);
    return e?.state === 'found' ? e.ref : undefined;
  });
}

/** Tests: forget the cache. */
export function resetSessionRefs() {
  cache.clear();
  queued = [];
  if (timer) clearTimeout(timer);
  timer = null;
}
