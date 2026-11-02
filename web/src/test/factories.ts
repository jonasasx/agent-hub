// Test data builders for component tests.
import { vi } from 'vitest';
import type { RunnerView, SessionView } from '../api/types';
import { useStore } from '../store';
import { resetWindowMirror } from '../features/workspace/windowState';
import { resetAttachments } from '../features/images/attachments';
import { cancelSidebarRefresh } from '../features/workspace/actions';
import { useLightbox } from '../features/images/ImagePreview';

export const runner = (over: Partial<RunnerView> = {}): RunnerView => ({
  id: 'x1',
  name: 'X1',
  kind: 'machine',
  os: 'Windows 11 Pro',
  online: true,
  lastSeenAt: new Date().toISOString(),
  agentVersion: '0.2.0',
  claudeVersion: '2.1.296',
  protocolVersion: '1.0',
  incompatible: false,
  vaultRoot: 'C:\\Users\\alice\\vault',
  homeDir: 'C:\\Users\\alice',
  ...over,
});

export const RUNNERS = [
  runner(),
  runner({ id: 'hp', name: 'HP', online: false, lastSeenAt: '2026-10-25T06:41:00Z' }),
  runner({ id: 'vm', name: 'ВМ .3', os: 'Ubuntu 24.04', vaultRoot: '/home/ubuntu/vault', homeDir: '/home/ubuntu' }),
];

let n = 0;
export const session = (over: Partial<SessionView> = {}): SessionView => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title: `Сессия ${n}`,
    runnerId: 'x1',
    cwd: 'C:\\Users\\alice\\vault',
    status: 'waiting',
    unread: false,
    processAlive: true,
    source: 'hub',
    isHubManaged: true,
    isCron: false,
    remoteControl: false,
    originSource: over.source ?? 'hub',
    readOnlyReason: null,
    project: { id: null, title: 'Без проекта', colorKey: 'none', path: '' },
    projectSource: 'none',
    projectEvidence: null,
    forkOf: null,
    permissionMode: 'bypassPermissions',
    model: 'opus',
    idleTimeoutMin: null,
    effectiveIdleTimeoutMin: 30,
    sleepsAt: null,
    lastInputAt: null,
    lastTurnEndAt: null,
    sleptAt: null,
    lastEventAt: new Date(Date.now() - n * 60_000).toISOString(),
    lastExternalWriteAt: null,
    createdAt: new Date(Date.now() - n * 60_000 - 1000).toISOString(),
    ...over,
  };
};

export type Route = (init?: RequestInit, url?: string) => { status: number; body?: unknown };

/** Stubs fetch with routes matched by `METHOD path-prefix` or `path-prefix`; returns the recorded calls. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = Object.keys(routes)
        .filter(k => {
          const [m, p] = k.includes(' ') ? k.split(' ') : [null, k];
          return (!m || m === method) && url.startsWith(p!);
        })
        .sort((a, b) => b.length - a.length)[0];
      const r = key ? routes[key]!(init, url) : { status: 404, body: { error: 'not_found' } };
      return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

export function resetStore() {
  useStore.setState(useStore.getInitialState(), true);
  resetWindowMirror();
  sessionStorage.removeItem('agenthub.tabkinds.v1');
  resetAttachments();
  cancelSidebarRefresh();
  useLightbox.setState({ pics: [], index: 0, open: false });
}
