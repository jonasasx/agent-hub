import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeersRequest } from '@agent-hub/shared';
import { PeersClient, PeersError } from './client.js';

const SID = '0b3c1b3e-6b0a-4a52-9a4e-1d0a8d6f2f11';
const list: PeersRequest = { op: 'list', sessionId: SID };

afterEach(() => vi.useRealTimers());

describe('PeersClient', () => {
  it('resolves with the result of the reply that carries the request id', async () => {
    const sent: Array<[PeersRequest, string]> = [];
    const c = new PeersClient({ send: (p, id) => (sent.push([p, id]), true) });
    const a = c.request(list);
    const b = c.request({ op: 'get', sessionId: SID, target: SID });
    c.onReply(sent[1]![1], { ok: true, result: 'second' });
    c.onReply(sent[0]![1], { ok: true, result: 'first' });
    expect(await a).toBe('first');
    expect(await b).toBe('second');
    expect(sent[0]![0]).toEqual(list);
  });

  it('an error reply rejects with its code and retry hint', async () => {
    let id = '';
    const c = new PeersClient({ send: (_p, i) => ((id = i), true) });
    const r = c.request(list);
    c.onReply(id, { ok: false, code: 'rate_limited', message: 'много', retryAfterSec: 30 });
    await expect(r).rejects.toMatchObject({ code: 'rate_limited', message: 'много', retryAfterSec: 30 });
    await expect(r).rejects.toBeInstanceOf(PeersError);
  });

  it('a reply of nobody is ignored; a repeated reply too', async () => {
    let id = '';
    const c = new PeersClient({ send: (_p, i) => ((id = i), true) });
    c.onReply('unknown', { ok: true, result: 1 });
    const r = c.request(list);
    c.onReply(id, { ok: true, result: 'a' });
    c.onReply(id, { ok: true, result: 'b' });
    expect(await r).toBe('a');
  });

  it('no connection: hub_offline at once; a lost connection fails the pending ones', async () => {
    await expect(new PeersClient({ send: () => false }).request(list)).rejects.toMatchObject({ code: 'hub_offline' });
    const c = new PeersClient({ send: () => true });
    const r = c.request(list);
    c.failAll('связь потеряна');
    await expect(r).rejects.toMatchObject({ code: 'hub_offline', message: 'связь потеряна' });
  });

  it('a silent hub: timeout', async () => {
    vi.useFakeTimers();
    const c = new PeersClient({ send: () => true, timeoutMs: 1000 });
    const r = c.request(list);
    const check = expect(r).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await check;
  });
});
