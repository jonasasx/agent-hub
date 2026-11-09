/**
 * Multi-user routes over MockHub (change `multi-user`, shared/src/api.ts): /api/me with a role, «Машины»,
 * «Пользователи», «Безопасность», «Подключить машину» with WS `runner.enroll`. Registered after MockHub.install, so
 * these routes win over the hub's. The live hub is checked by QA (tasks 6.1–6.5).
 */
import type { Page, Route } from '@playwright/test';
import { MockHub, RUNNERS } from './hub.js';

type Json = Record<string, unknown>;

export interface MultiUserOptions {
  role?: 'admin' | 'user';
  /** No machines and no sessions: the welcome screen. */
  empty?: boolean;
}

const now = Date.now();
const iso = (ms: number) => new Date(now + ms).toISOString();

export const MACHINES = [
  { ...RUNNERS[0], state: 'active', claudeLogin: 'ok', protectedDirsOk: null, outdated: false, update: null },
  { ...RUNNERS[1], state: 'active', claudeLogin: 'missing', protectedDirsOk: null, outdated: true, update: null },
  { ...RUNNERS[2], state: 'active', claudeLogin: 'ok', protectedDirsOk: null, outdated: false, update: { version: '0.3.0', status: 'failed', error: 'sha_mismatch', at: iso(-60_000) } },
  {
    id: 'r-mac',
    name: 'MacBook Кати с очень длинным именем',
    kind: 'machine',
    os: 'macOS 15.1',
    online: true,
    lastSeenAt: iso(0),
    agentVersion: '0.3.0',
    claudeVersion: '2.1.310',
    protocolVersion: '1.5',
    incompatible: false,
    vaultRoot: null,
    homeDir: '/Users/bob',
    state: 'active',
    claudeLogin: 'ok',
    protectedDirsOk: false,
    outdated: false,
    update: null,
  },
  {
    id: 'r-old',
    name: 'Старый сервер',
    kind: 'machine',
    os: 'Debian 12',
    online: false,
    lastSeenAt: iso(-86_400_000 * 5),
    agentVersion: '0.1.0',
    claudeVersion: null,
    protocolVersion: '1.3',
    incompatible: false,
    vaultRoot: null,
    homeDir: '/home/old',
    state: 'disabled',
    claudeLogin: null,
    protectedDirsOk: null,
    outdated: true,
    update: null,
  },
];

const USERS = [
  {
    id: 'u1',
    email: 'alice@example.com',
    name: 'Алиса Смит',
    provider: 'google',
    role: 'admin',
    status: 'active',
    invitedAt: null,
    lastLoginAt: iso(-3_600_000),
    createdAt: iso(-86_400_000 * 30),
    machines: { total: 3, online: 2 },
  },
  {
    id: 'u2',
    email: 'bob.longname.long.address@example.com',
    name: 'Борис Смит',
    provider: 'google',
    role: 'user',
    status: 'active',
    invitedAt: iso(-86_400_000),
    lastLoginAt: iso(-7_200_000),
    createdAt: iso(-86_400_000),
    machines: { total: 2, online: 1 },
  },
  {
    id: 'u3',
    email: 'colleague@example.com',
    name: null,
    provider: 'keycloak',
    role: 'user',
    status: 'disabled',
    invitedAt: iso(-86_400_000 * 3),
    lastLoginAt: null,
    createdAt: iso(-86_400_000 * 3),
    machines: { total: 0, online: 0 },
  },
];

const INVITES = [
  { id: 'i1', email: 'new.colleague@example.com', provider: 'keycloak', status: 'active', createdAt: iso(-3_600_000), expiresAt: iso(86_400_000 * 6.9), usedAt: null, revokedAt: null },
  {
    id: 'i2',
    email: 'bob.longname.long.address@example.com',
    provider: 'google',
    status: 'used',
    createdAt: iso(-86_400_000),
    expiresAt: iso(86_400_000 * 6),
    usedAt: iso(-80_000_000),
    revokedAt: null,
  },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SECURITY = {
  events: [
    { id: 'e1', kind: 'runner_connected', at: iso(-600_000), ip: '203.0.113.7', userAgent: null, provider: null, runner: { id: 'r-mac', name: 'MacBook Кати с очень длинным именем' } },
    { id: 'e2', kind: 'enroll_code_used', at: iso(-610_000), ip: '203.0.113.7', userAgent: null, provider: null, runner: { id: 'r-mac', name: 'MacBook Кати с очень длинным именем' } },
    { id: 'e3', kind: 'login', at: iso(-3_600_000), ip: '2001:db8:85a3::8a2e:370:7334', userAgent: UA, provider: 'google', runner: null },
    { id: 'e4', kind: 'login_denied', at: iso(-7_200_000), ip: '198.51.100.9', userAgent: UA, provider: 'keycloak', runner: null },
  ],
  sessions: [
    { id: 'aaaa', createdAt: iso(-3_600_000), expiresAt: iso(86_400_000 * 29), userAgent: UA, current: true },
    {
      id: 'bbbb',
      createdAt: iso(-86_400_000),
      expiresAt: iso(86_400_000 * 28),
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
      current: false,
    },
  ],
};

const PENDING = {
  id: 'r-new',
  name: 'Моя машина',
  kind: 'machine',
  os: null,
  online: false,
  lastSeenAt: null,
  agentVersion: null,
  claudeVersion: null,
  protocolVersion: null,
  incompatible: false,
  vaultRoot: null,
  homeDir: null,
  state: 'pending',
  claudeLogin: null,
};
const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const enrollCode = (runner: Json) => ({
  runner,
  code: CODE,
  expiresAt: iso(15 * 60_000),
  commands: { unix: `curl -fsSL https://hub.example.com/install.sh | bash -s -- ${CODE}`, windows: `irm https://hub.example.com/install.ps1 | iex; Install-AgentHub ${CODE}` },
});

export async function installMultiUser(page: Page, hub: MockHub, opts: MultiUserOptions = {}) {
  const role = opts.role ?? 'admin';
  const ok = (route: Route, b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/me', r =>
    ok(r, {
      user:
        role === 'admin'
          ? { id: 'u1', email: 'alice@example.com', role, name: 'Алиса Смит', provider: 'google' }
          : { id: 'u2', email: 'bob@example.com', role, name: 'Борис Смит', provider: 'google' },
      vapidPublicKey: null,
    }),
  );
  if (opts.empty) await page.route('**/api/sidebar*', r => ok(r, { now: [], projects: [], runners: [] }));
  await page.route(/\/api\/runners(\/.*)?$/, r => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/runners' && req.method() === 'GET') return ok(r, { runners: MACHINES, agentVersion: '0.3.0' });
    if (path === '/api/runners' && req.method() === 'POST') return ok(r, enrollCode({ ...PENDING, name: (req.postDataJSON() as Json).name ?? 'Моя машина' }), 201);
    if (/\/enroll-code$/.test(path)) return ok(r, enrollCode(MACHINES.find(m => path.includes(`/${m.id}/`)) ?? PENDING));
    const m = MACHINES.find(x => path === `/api/runners/${x.id}`);
    if (m) return ok(r, { ...m, hostname: m.id, createdAt: iso(-86_400_000), enroll: null, uninstallCommand: { unix: '~/.agent-hub/uninstall.sh', windows: 'Uninstall-AgentHub' } });
    return ok(r, { error: 'not_found' }, 404);
  });
  await page.route('**/api/admin/users', r => (role === 'admin' ? ok(r, { users: USERS }) : ok(r, { error: 'forbidden' }, 403)));
  await page.route('**/api/admin/invites', r => {
    if (role !== 'admin') return ok(r, { error: 'forbidden' }, 403);
    if (r.request().method() === 'POST') {
      const b = r.request().postDataJSON() as Json;
      return ok(
        r,
        {
          invite: { id: 'i9', email: b.email, provider: b.provider, status: 'active', createdAt: iso(0), expiresAt: iso(7 * 86_400_000), usedAt: null, revokedAt: null },
          url: 'https://hub.example.com/invite/k3j5h6g7f8d9s0a1q2w3e4r5t6y7u8i9o0p1a2s3d4f5',
        },
        201,
      );
    }
    return ok(r, { invites: INVITES });
  });
  await page.route('**/api/security', r => ok(r, SECURITY));
}

/** Plays the stages of «Подключить машину» over /ws/ui. */
export function playEnroll(hub: MockHub, stages: string[], over: Json = {}) {
  for (const stage of stages) {
    const active = stage !== 'waiting' && stage !== 'code_used';
    const runner = {
      ...PENDING,
      state: active ? 'active' : 'pending',
      online: active,
      os: 'macOS 15.1',
      homeDir: '/Users/bob',
      agentVersion: '0.3.0',
      claudeLogin: 'ok',
      protectedDirsOk: false,
      ...over,
    };
    hub.push({ type: 'runner.enroll', runnerId: 'r-new', stage, runner });
  }
}
