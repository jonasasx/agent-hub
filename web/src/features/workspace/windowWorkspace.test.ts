// Task 2.18: the workspace of a browser window (design.md D11 «Рабочая область окна»).
// Requirements (workspace-ui): Независимые окна; Раскладка нового окна и перезагрузка.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { mockFetch, resetStore, session } from '../../test/factories';
import * as L from '../layout/layout';
import { activateTab, dropSplit, dropToPane, loadWorkspace, openSession, openSubagent, setRatio, startLayoutPersistence } from './actions';
import { WINDOW_KEY, resetWindowMirror } from './windowState';

const A = '00000000-0000-4000-8000-00000000aaaa';
const B = '00000000-0000-4000-8000-00000000bbbb';
const C = '00000000-0000-4000-8000-00000000cccc';
const GONE = '00000000-0000-4000-8000-00000000dddd';

const template = (tabs: string[]) => {
  const ws = L.split(L.emptyWorkspace(tabs), tabs.at(-1)!, 'p1', 'right').ws;
  return {
    layout: { layout: ws.layout, panes: ws.panes, focus: ws.focus, seq: ws.seq },
    savedLayout: null,
    openedAt: Object.fromEntries(tabs.map(t => [t, '2026-10-25T10:00:00Z'])),
    updatedAt: '2026-10-25T10:00:00Z',
  };
};

type Call = { url: string; method: string; body: unknown };

describe('window workspace', () => {
  let calls: Call[];
  let stop: () => void = () => undefined;
  let known: string[];

  let putStatus = 200;
  function hub(tpl: unknown = template([A, B])) {
    calls = mockFetch({
      'GET /api/layout': () => ({ status: 200, body: tpl }),
      'PUT /api/layout': () =>
        putStatus === 200 ? { status: 200, body: { updatedAt: '2026-10-25T11:00:00Z' } } : { status: putStatus, body: { error: putStatus === 400 ? 'invalid_request' : 'http_error' } },
      'GET /api/sessions/': (_i, url) => {
        const id = url!.split('/')[3]!.split('?')[0]!;
        if (url!.includes('/events')) return { status: 200, body: { events: [], before: null } };
        return known.includes(id) ? { status: 200, body: session({ id, title: id.slice(-4) }) } : { status: 404, body: { error: 'not_found' } };
      },
    });
  }
  const puts = () => calls.filter(c => c.method === 'PUT');
  const gets = () => calls.filter(c => c.method === 'GET' && c.url.startsWith('/api/layout'));
  const tabsOf = () => L.leaves(useStore.getState().ws.layout).map(p => useStore.getState().ws.panes[p]!.tabs);

  beforeEach(() => {
    resetStore();
    known = [A, B, C];
    putStatus = 200;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    stop = startLayoutPersistence();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('новое окно: no copy in sessionStorage → the template from GET /api/layout; loading it sends nothing', async () => {
    hub();
    await loadWorkspace('desktop');
    expect(gets().map(c => c.url)).toEqual(['/api/layout?device=desktop']);
    expect(tabsOf()).toEqual([[A], [B]]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(puts()).toEqual([]);
    // the window keeps its own copy right away
    expect(JSON.parse(sessionStorage.getItem(WINDOW_KEY)!).desktop.panes.p2.tabs).toEqual([B]);
  });

  it('перезагрузка: the window copy from sessionStorage, no GET /api/layout', async () => {
    hub();
    await loadWorkspace('desktop');
    setRatio('', 0.3);
    // a reload: new page, same sessionStorage; the template on the hub is another window's
    resetStore();
    resetWindowMirror();
    hub(template([C]));
    await loadWorkspace('desktop');
    expect(gets()).toEqual([]);
    expect(tabsOf()).toEqual([[A], [B]]);
    expect(useStore.getState().ws.layout).toMatchObject({ ratio: 0.3 });
  });

  it('a change in this window: sessionStorage at once, PUT after 500 ms with layout, savedLayout and openedAt', async () => {
    hub();
    await loadWorkspace('desktop');
    setRatio('', 0.7);
    expect(JSON.parse(sessionStorage.getItem(WINDOW_KEY)!).desktop.layout.ratio).toBe(0.7);
    await vi.advanceTimersByTimeAsync(400);
    expect(puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(puts()).toHaveLength(1);
    const body = puts()[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['clientTs', 'device', 'layout', 'openedAt', 'savedLayout']);
    // clientTs is the time of the change, not of the request (D10: a late PUT of an older change does not win)
    expect(body.clientTs).toBe(Date.parse('2026-10-25T12:00:00Z'));
    expect(body).toMatchObject({ device: 'desktop', layout: { layout: { ratio: 0.7 }, focus: 'p2' }, savedLayout: null });
    expect(body.openedAt).toEqual({ [A]: '2026-10-25T10:00:00.000Z', [B]: '2026-10-25T10:00:00.000Z' });
  });

  it('pagehide sends an unsent snapshot with keepalive', async () => {
    hub();
    await loadWorkspace('desktop');
    activateTab('p1', A);
    setRatio('', 0.6);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([, i]) => i?.method === 'PUT')![1];
    expect(init.keepalive).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts()).toHaveLength(1);
  });

  it('tabs of sessions the hub no longer has are removed — and that change is saved', async () => {
    known = [A];
    hub(template([A, GONE]));
    await loadWorkspace('desktop');
    await vi.advanceTimersByTimeAsync(0);
    expect(tabsOf()).toEqual([[A]]);
    await vi.advanceTimersByTimeAsync(600);
    expect(puts()).toHaveLength(1);
  });

  it('every PUT is sent with keepalive, so a request in flight survives closing the page', async () => {
    hub();
    await loadWorkspace('desktop');
    setRatio('', 0.4);
    await vi.advanceTimersByTimeAsync(600);
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([, i]) => i?.method === 'PUT')![1];
    expect(init.keepalive).toBe(true);
  });

  it('a 4xx on PUT is logged and not retried; a 5xx is retried on pagehide', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hub();
    await loadWorkspace('desktop');
    putStatus = 400;
    setRatio('', 0.4);
    await vi.advanceTimersByTimeAsync(600);
    expect(puts()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PUT /api/layout refused: 400 invalid_request'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    putStatus = 503;
    setRatio('', 0.45);
    await vi.advanceTimersByTimeAsync(600);
    expect(puts()).toHaveLength(2);
    putStatus = 200;
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(3);
    expect((puts()[2]!.body as { layout: { layout: { ratio: number } } }).layout.layout.ratio).toBe(0.45);
    warn.mockRestore();
  });

  it('a session opened while the template is loading is opened on top of the loaded layout', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => (release = r));
    hub();
    const plain = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/layout') && (init?.method ?? 'GET') === 'GET') await gate;
      return plain(url, init);
    });
    const done = loadWorkspace('desktop');
    openSession(C);
    release();
    await done;
    expect(tabsOf()).toEqual([[A], [B, C]]);
    expect(useStore.getState().ws.panes[useStore.getState().ws.focus]!.active).toBe(C);
    await vi.advanceTimersByTimeAsync(600);
    expect(puts()).toHaveLength(1);
  });

  it('a drop from the left panel while the template is loading becomes an opening after the load', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => (release = r));
    hub();
    const plain = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/layout') && (init?.method ?? 'GET') === 'GET') await gate;
      return plain(url, init);
    });
    const done = loadWorkspace('desktop');
    dropSplit(C, 'p1', 'right');
    dropToPane(C, 'p9', null);
    release();
    await done;
    expect(tabsOf()).toEqual([[A], [B, C]]);
  });

  it('only the latest loadWorkspace applies its result (the window crossed 760 px twice while loading)', async () => {
    const gates: Array<() => void> = [];
    hub();
    const plain = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/layout') && (init?.method ?? 'GET') === 'GET') await new Promise<void>(r => gates.push(r));
      return plain(url, init);
    });
    const first = loadWorkspace('phone');
    const second = loadWorkspace('desktop');
    gates[1]!(); // the desktop answer comes first
    await second;
    expect(useStore.getState().device).toBe('desktop');
    const desktop = useStore.getState().ws;
    gates[0]!(); // the late phone answer is dropped
    await first;
    expect(useStore.getState().device).toBe('desktop');
    expect(useStore.getState().ws).toBe(desktop);
    expect(useStore.getState().layoutLoaded).toBe(true);
    openSession(C); // not queued: loading is over
    expect(L.allTabs(useStore.getState().ws)).toContain(C);
  });

  it('no template → one empty pane', async () => {
    hub({ layout: null, savedLayout: null, openedAt: null, updatedAt: null });
    await loadWorkspace('desktop');
    expect(useStore.getState().ws).toEqual(L.emptyWorkspace());
  });

  it('blocked sessionStorage: the window works in memory and starts from the template', async () => {
    const block = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(block);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(block);
    hub();
    await loadWorkspace('desktop');
    expect(tabsOf()).toEqual([[A], [B]]);
    openSession(C);
    expect(tabsOf()).toEqual([[A], [B, C]]);
    await vi.advanceTimersByTimeAsync(600);
    expect(puts()).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('device class change keeps the window tabs; the layout is the class own; phone has its own template', async () => {
    hub();
    await loadWorkspace('desktop');
    openSession(C);
    // phone template on the hub: one pane with A only
    hub({ layout: { layout: { type: 'leaf', pane: 'p1' }, panes: { p1: { id: 'p1', tabs: [A], active: A } }, focus: 'p1', seq: 1 }, savedLayout: null, openedAt: null });
    await loadWorkspace('phone');
    expect(gets().map(c => c.url)).toEqual(['/api/layout?device=phone']);
    expect(L.allTabs(useStore.getState().ws).sort()).toEqual([A, B, C].sort());
    expect(L.leaves(useStore.getState().ws.layout)).toHaveLength(1);
    const stored = JSON.parse(sessionStorage.getItem(WINDOW_KEY)!);
    expect(stored.desktop).not.toBeNull();
    expect(stored.phone).not.toBeNull();
  });

  // QA M4a: a cold load of /s/<id> hung on «Загрузка сессии…» when the socket opened before the tab was added
  describe('the card of an opened session is fetched by openSession itself', () => {
    const cardGets = (id: string) => calls.filter(c => c.method === 'GET' && c.url === `/api/sessions/${id}`);

    it('after the layout is loaded: one GET of the card, the session is in the store', async () => {
      hub(template([A]));
      await loadWorkspace('desktop');
      openSession(C);
      openSession(C);
      await vi.waitFor(() => expect(useStore.getState().sessions[C]).toBeDefined());
      expect(cardGets(C)).toHaveLength(1);
    });

    it('while the layout is still loading (the socket may already be open): the card comes without waiting for anything else', async () => {
      let release!: () => void;
      calls = [];
      mockFetch({
        'GET /api/layout': () => ({ status: 200, body: template([A]) }),
        'GET /api/sessions/': (_i, url) => ({ status: 200, body: session({ id: url!.split('/')[3]!.split('?')[0]!, title: 'x' }) }),
      });
      const layoutGate = new Promise<void>(r => (release = r));
      const f = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => (url.startsWith('/api/layout') ? layoutGate.then(() => f(url, init)) : f(url, init))),
      );
      const loading = loadWorkspace('desktop');
      openSession(C);
      await vi.waitFor(() => expect(useStore.getState().sessions[C]).toBeDefined());
      release();
      await loading;
      expect(L.allTabs(useStore.getState().ws)).toContain(C);
    });

    it('a session the hub does not know (404) loses its tab', async () => {
      hub(template([A]));
      await loadWorkspace('desktop');
      openSession(GONE);
      await vi.waitFor(() => expect(cardGets(GONE)).toHaveLength(1));
      await vi.waitFor(() => expect(L.allTabs(useStore.getState().ws)).not.toContain(GONE));
    });
  });

  // change `subagents` 5.4: a subagent tab survives a reload (tabKinds + GET /api/subagents/:id), 404 drops it
  it('перезагрузка с вкладкой субагента: restored by GET /api/subagents/:id; gone from the hub → the tab is dropped', async () => {
    const SUB = '00000000-0000-4000-a000-00000000eeee';
    let subKnown = true;
    const routes = () =>
      (calls = mockFetch({
        'GET /api/layout': () => ({ status: 200, body: template([A]) }),
        'PUT /api/layout': () => ({ status: 200, body: { updatedAt: '2026-10-25T11:00:00Z' } }),
        'GET /api/sessions/': (_i, url) =>
          url!.includes('/events') ? { status: 200, body: { events: [], before: null } } : { status: 200, body: session({ id: url!.split('/')[3]!.split('?')[0]!, title: 'S' }) },
        'GET /api/subagents/': (_i, url) =>
          url!.includes('/events')
            ? { status: 200, body: { events: [], before: null } }
            : subKnown
              ? {
                  status: 200,
                  body: {
                    id: SUB,
                    sessionId: A,
                    agentId: 'a1',
                    toolUseId: 't1',
                    parentAgentId: null,
                    parentId: null,
                    kind: 'subagent',
                    description: 'Ревью',
                    agentType: 'reviewer',
                    name: null,
                    model: null,
                    background: true,
                    status: 'completed',
                    startedAt: null,
                    lastEventAt: null,
                    endedAt: null,
                    durationMs: null,
                    totalTokens: null,
                    toolUses: null,
                    eventCount: 0,
                    hasTranscript: true,
                    session: { id: A, title: 'S' },
                  },
                }
              : { status: 404, body: { error: 'not_found' } },
      }));
    routes();
    await loadWorkspace('desktop');
    openSubagent(SUB);
    await vi.waitFor(() => expect(useStore.getState().subagents[SUB]).toBeDefined());
    expect(L.allTabs(useStore.getState().ws)).toContain(SUB);
    const kinds = sessionStorage.getItem('agenthub.tabkinds.v1');
    // a reload: a new page with the same sessionStorage
    resetStore();
    resetWindowMirror();
    sessionStorage.setItem('agenthub.tabkinds.v1', kinds!);
    routes();
    await loadWorkspace('desktop');
    expect(L.allTabs(useStore.getState().ws)).toContain(SUB);
    expect(useStore.getState().tabKinds[SUB]).toBe('subagent');
    expect(useStore.getState().subagents[SUB]?.description).toBe('Ревью');
    expect(calls.some(c => c.url === `/api/subagents/${SUB}`)).toBe(true);
    expect(calls.some(c => c.url === `/api/sessions/${SUB}`)).toBe(false);
    // deleted with its session
    resetStore();
    resetWindowMirror();
    sessionStorage.setItem('agenthub.tabkinds.v1', kinds!);
    subKnown = false;
    routes();
    await loadWorkspace('desktop');
    expect(L.allTabs(useStore.getState().ws)).not.toContain(SUB);
  });
});
