/**
 * The subscriptions registry of the in-memory hub (change claude-subscriptions, design P8): GET/POST/PATCH
 * /api/subscriptions, PUT …/:id/token, PUT …/order, GET …/usage, POST /api/sessions/:id/subscription. Tokens are kept
 * only to answer with `tokenHint`; every answer and WS message carries the hint, never the token.
 */
type Json = Record<string, unknown>;

export interface MockSub {
  id: string;
  name: string;
  position: number;
  autoSwitch: boolean;
  retired: boolean;
  token: string;
  tokenUpdatedAt: string;
  limitResetsAt: string | null;
  limitKind: string | null;
  tokenRejected: boolean;
}

export const subId = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;

export class MockSubscriptions {
  list: MockSub[] = [];
  lastChoiceId: string | null = null;
  enabled = true;
  connectorsHint = true;
  /** Bodies of POST /api/sessions/:id/subscription, in order. */
  switches: Json[] = [];
  private seq = 100;

  add(name: string, over: Partial<MockSub> = {}): MockSub {
    const s: MockSub = {
      id: subId(++this.seq),
      name,
      position: this.list.filter(x => !x.retired).length,
      autoSwitch: false,
      retired: false,
      token: `sk-ant-oat01-mock-${name.length}-${this.seq}-abcd`,
      tokenUpdatedAt: new Date().toISOString(),
      limitResetsAt: null,
      limitKind: null,
      tokenRejected: false,
      ...over,
    };
    this.list.push(s);
    return s;
  }

  view(s: MockSub): Json {
    const { token, ...rest } = s;
    return { ...rest, tokenHint: token.slice(-4) };
  }

  active(): MockSub[] {
    return this.list.filter(s => !s.retired).sort((a, b) => a.position - b.position);
  }

  defaultId(): string | null {
    const a = this.active();
    return a.some(s => s.id === this.lastChoiceId) ? this.lastChoiceId : (a[0]?.id ?? null);
  }

  response(): Json {
    return {
      enabled: this.enabled,
      subscriptions: [...this.active(), ...this.list.filter(s => s.retired)].map(s => this.view(s)),
      lastChoiceId: this.lastChoiceId,
      defaultId: this.defaultId(),
      connectorsHint: this.connectorsHint,
    };
  }

  ref(id: string | null | undefined): { id: string; name: string } | null {
    const s = this.list.find(x => x.id === id);
    return s ? { id: s.id, name: s.name } : null;
  }
}

const TOKEN = /^\S{20,4096}$/;

/**
 * Answers a /api/subscriptions request; null — not a subscriptions path. `changed` broadcasts subscriptions.changed.
 */
export function handleSubscriptions(reg: MockSubscriptions, path: string, method: string, body: Json, query: URLSearchParams, changed: () => void): { status: number; body: unknown } | null {
  const ok = (b: unknown, status = 200) => ({ status, body: b });
  const err = (status: number, error: string) => ({ status, body: { error } });
  if (path === '/api/subscriptions' && method === 'GET') return ok(reg.response());
  if (path === '/api/subscriptions' && method === 'POST') {
    if (!reg.enabled) return err(503, 'subscriptions_disabled');
    const name = String(body.name ?? '').trim();
    if (!TOKEN.test(String(body.token ?? ''))) return err(422, 'bad_token');
    if (reg.active().some(s => s.name.toLowerCase() === name.toLowerCase())) return err(409, 'name_taken');
    const s = reg.add(name, { token: String(body.token), autoSwitch: body.autoSwitch === true });
    changed();
    return ok(reg.view(s), 201);
  }
  if (path === '/api/subscriptions/order' && method === 'PUT') {
    const ids = (body.ids as string[]) ?? [];
    const active = reg.active().map(s => s.id);
    if (ids.length !== active.length || !active.every(id => ids.includes(id))) return err(422, 'bad_order');
    ids.forEach((id, i) => (reg.list.find(s => s.id === id)!.position = i));
    changed();
    return ok(reg.response());
  }
  if (path === '/api/subscriptions/usage' && method === 'GET') {
    const rows = reg.list.map((s, i) => ({
      subscriptionId: s.id,
      name: s.name,
      turns: 10 - i,
      inputTokens: 1200 * (i + 1),
      outputTokens: 340,
      cacheReadTokens: 90_000,
      cacheCreationTokens: 5000,
      limitHits: i === 0 ? 1 : 0,
    }));
    return ok({
      from: query.get('from'),
      to: query.get('to'),
      rows: [...rows, { subscriptionId: null, name: 'Вход машины', turns: 3, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, limitHits: 0 }],
    });
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/subscriptions\/([^/]+)\/token$/.exec(path)) && method === 'PUT') {
    const s = reg.list.find(x => x.id === m![1]);
    if (!s) return err(404, 'not_found');
    if (!reg.enabled) return err(503, 'subscriptions_disabled');
    if (!TOKEN.test(String(body.token ?? ''))) return err(422, 'bad_token');
    Object.assign(s, { token: String(body.token), tokenRejected: false, tokenUpdatedAt: new Date().toISOString() });
    changed();
    return ok(reg.view(s));
  }
  if ((m = /^\/api\/subscriptions\/([^/]+)$/.exec(path)) && method === 'PATCH') {
    const s = reg.list.find(x => x.id === m![1]);
    if (!s) return err(404, 'not_found');
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (reg.active().some(x => x.id !== s.id && x.name.toLowerCase() === name.toLowerCase())) return err(409, 'name_taken');
      s.name = name;
    }
    if (typeof body.autoSwitch === 'boolean') s.autoSwitch = body.autoSwitch;
    if (typeof body.retired === 'boolean') {
      s.retired = body.retired;
      if (!s.retired) s.position = reg.active().length;
      reg.active().forEach((x, i) => (x.position = i));
    }
    changed();
    return ok(reg.view(s));
  }
  return null;
}
