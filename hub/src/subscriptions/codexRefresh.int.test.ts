// codex-credential-sync: a write-back of rotated Codex tokens is compare-and-swap by the CLI's last_refresh.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/db.js';
import { SubscriptionService } from './service.js';
import { decryptToken, tokenKey } from './crypto.js';

const KEY = randomBytes(32).toString('base64');
const auth = (at: string, account = 'acc-1111', n = 1) => JSON.stringify({ last_refresh: at, n, tokens: { account_id: account } });
const T10 = '2026-10-31T10:00:00Z';
const T11 = '2026-10-31T11:00:00Z';
const T12 = '2026-10-31T12:00:00Z';

describe('SubscriptionService.refreshCodex', () => {
  let t: TestDb;
  let svc: SubscriptionService;
  let userId: string;
  beforeAll(async () => {
    t = await createTestDb();
    userId = (await t.pool.query(`INSERT INTO users (email) VALUES ('cx@x.y') RETURNING id`)).rows[0].id as string;
    const ui = { broadcast: () => undefined } as never;
    svc = new SubscriptionService({ db: t.db, ui, log: { info: () => undefined, warn: () => undefined }, key: KEY, connectorsHint: false });
  });
  afterAll(() => t.drop());

  const stored = async (id: string) => {
    const r = await t.pool.query(`SELECT token_enc FROM subscriptions WHERE id = $1`, [id]);
    return decryptToken(tokenKey(KEY), id, r.rows[0].token_enc);
  };

  it('takes a newer rotation; refuses an older or equal one, another account, a retired subscription', async () => {
    const id = (await svc.createCodex(userId, 'Codex 1', auth(T11))).id;
    await svc.refreshCodex(id, auth(T12, 'acc-1111', 2));
    expect(JSON.parse(await stored(id)).n).toBe(2);
    await svc.refreshCodex(id, auth(T10, 'acc-1111', 3)); // stale write-back of an old process
    await svc.refreshCodex(id, auth(T12, 'acc-1111', 4)); // equal
    await svc.refreshCodex(id, auth(T12 + '', 'acc-2222', 5).replace('2026-10-31T12:00:00Z', '2026-10-31T13:00:00Z')); // another ChatGPT account
    await svc.refreshCodex(id, JSON.stringify({ tokens: { account_id: 'acc-1111' }, n: 6 })); // no last_refresh
    expect(JSON.parse(await stored(id)).n).toBe(2);
    await svc.patch(userId, id, { retired: true });
    await svc.refreshCodex(id, auth('2026-10-31T14:00:00Z', 'acc-1111', 7));
    expect(JSON.parse(await stored(id)).n).toBe(2);
  });
});
