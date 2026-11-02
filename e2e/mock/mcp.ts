/**
 * MCP management over MockHub (change mcp-management, design M8, tasks 5.1/5.5): GET/POST /api/sessions/:id/mcp*,
 * GET/POST /api/runners/:id/mcp*, WS session.mcp / mcp.auth / runner.mcp; and the screens of the change at one
 * viewport and theme — the head with «MCP 2», the panel with every status, the sign-in (hub and the paste fallback),
 * a sleeping session, an outdated agent, the tree mark, the block on «Машины». No horizontal scroll; screenshots when
 * SHOTS_DIR is set (UI review 7.1 compares them with docs/prototype.html).
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { MockHub } from './hub.js';
import { installMultiUser } from './multiuser.js';

type Json = Record<string, unknown>;
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

const srv = (over: Json): Json => ({ status: 'connected', transport: 'stdio', scope: 'user', toolCount: 0, persistence: 'project', canAuth: false, ...over });

export const MCP_SERVERS: Json[] = [
  srv({ name: 'vaultwarden', target: 'node C:/Users/alice/mcp/vaultwarden/dist/index.js --session •••', serverInfo: { name: 'vaultwarden-mcp', version: '1.4.0' }, toolCount: 12 }),
  srv({
    name: 'scanner-fleet',
    status: 'failed',
    transport: 'http',
    target: 'https://scanners.example.com/mcp',
    scope: 'project',
    canAuth: true,
    error: 'MCP error -32000: Connection closed: connect ECONNREFUSED 10.3.16.20:443',
  }),
  srv({ name: 'notion', status: 'needs-auth', transport: 'http', target: 'https://mcp.notion.com/mcp', canAuth: true }),
  srv({ name: 'krisp', status: 'pending', transport: 'http', target: 'https://mcp.krisp.ai/mcp', canAuth: true }),
  srv({ name: 'playwright', status: 'disabled', target: 'npx @playwright/mcp@latest --user-data-dir C:/Users/alice/.playwright-mcp', scope: 'local' }),
  srv({ name: 'codegraph', status: 'unknown', transport: 'other', scope: 'managed' }),
];

export class MockMcp {
  views = new Map<string, Json>();
  machines = new Map<string, Json>();
  requests: { method: string; path: string; body: unknown }[] = [];
  constructor(private hub: MockHub) {}

  view(sessionId: string, over: Json = {}): Json {
    const v = { available: true, live: true, observedAt: at(-2), servers: MCP_SERVERS, authFlows: [], waking: false, ...(this.views.get(sessionId) ?? {}), ...over };
    this.views.set(sessionId, v);
    return v;
  }

  /** A new view of a session: stored and sent as session.mcp. */
  set(sessionId: string, over: Json) {
    this.hub.push({ type: 'session.mcp', sessionId, mcp: this.view(sessionId, over) });
  }

  machine(runnerId: string, over: Json = {}): Json {
    const v = {
      available: true,
      observedAt: at(-6),
      source: 'probe',
      servers: MCP_SERVERS.filter(s => s.scope === 'user'),
      probeAt: at(-6),
      probeAvailableAt: null,
      probing: false,
      probeError: null,
      online: true,
      ...(this.machines.get(runnerId) ?? {}),
      ...over,
    };
    this.machines.set(runnerId, v);
    return v;
  }

  async install(page: Page) {
    const ok = (r: Route, b: unknown, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    await page.route(/\/api\/sessions\/[^/]+\/mcp(\/.*)?$/, r => {
      const req = r.request();
      const path = new URL(req.url()).pathname;
      const id = path.split('/')[3]!;
      const body = req.method() === 'POST' ? (req.postDataJSON() as Json) : undefined;
      this.requests.push({ method: req.method(), path, body });
      if (req.method() === 'GET') return ok(r, this.view(id));
      if (path.endsWith('/mcp/auth/callback')) {
        const url = String(body?.callbackUrl ?? '');
        if (!url.includes('state=s-local')) return ok(r, { error: 'bad_callback_url', message: 'Адрес не от этой попытки входа или без кода — вставьте адрес со страницы этой попытки' }, 400);
        return ok(r, this.view(id), 202);
      }
      if (path.endsWith('/mcp/auth')) {
        const v = this.view(id, { servers: (this.view(id).servers as Json[]).map(s => (s.name === body?.server ? { ...s, pendingAction: 'auth' } : s)) });
        setTimeout(() => {
          const flow = { server: body?.server, authUrl: 'https://mcp.notion.com/authorize?response_type=code&client_id=agent-hub&state=s-hub', redirect: 'hub', expiresAt: at(10) };
          this.set(id, { servers: MCP_SERVERS, authFlows: [flow] });
          this.hub.push({ type: 'mcp.auth', sessionId: id, server: body?.server, flow });
        }, 300);
        return ok(r, v, 202);
      }
      return ok(r, this.view(id), 202);
    });
    await page.route(/\/api\/runners\/[^/]+\/mcp(\/.*)?$/, r => {
      const req = r.request();
      const path = new URL(req.url()).pathname;
      const id = path.split('/')[3]!;
      this.requests.push({ method: req.method(), path, body: undefined });
      if (req.method() === 'GET') return ok(r, this.machine(id));
      return ok(r, this.machine(id, { probing: true }), 202);
    });
  }
}

async function noHScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

const dir = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

export function mcpSpecs(device: 'desktop' | 'phone') {
  for (const theme of ['dark', 'light'] as const) {
    test(`${device} ${theme}: MCP head, panel with every status, sign-in, sleeping, outdated agent, tree, «Машины»`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
      const hub = new MockHub({ tabs: [1] });
      const s1 = hub.session(1);
      s1.mcpProblems = 2;
      hub.session(4).mcpProblems = 1;
      // the agent of X1 speaks MCP (1.7); the outdated screen below turns it back to 0.2.0 / 1.6 over runner.status
      hub.runnerPatch.x1 = { agentVersion: '0.2.4', protocolVersion: '1.7' };
      await hub.install(page);
      await installMultiUser(page, hub);
      const mcp = new MockMcp(hub);
      await mcp.install(page);
      await page.goto('/');
      const phone = device === 'phone';
      if (phone) {
        await expect(page.getByRole('list', { name: 'Машины' })).toBeAttached();
        await expect(page.getByRole('img', { name: 'Проблемы MCP: 2' }).first()).toBeVisible();
        await noHScroll(page);
        await shot(page, `mcp-${device}-${theme}-1-tree`);
        await page.locator('.side-scroll .srow', { hasText: s1.title }).first().click();
        await expect(page.locator('.mbar')).toContainText(s1.title);
      }
      const btn = page.getByRole('button', { name: 'MCP: проблемных серверов 2' });
      await expect(btn).toBeVisible();
      await noHScroll(page);
      await shot(page, `mcp-${device}-${theme}-${phone ? '2-chat' : '1-head-tree'}`);
      if (phone) expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(40);

      await btn.click();
      const panel = page.getByRole('dialog', { name: 'MCP-серверы' });
      await expect(panel.getByRole('listitem', { name: 'codegraph: статус не сообщается' })).toBeVisible();
      if (phone) {
        const b = (await panel.boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(388);
        expect(b.y + b.height).toBeGreaterThanOrEqual(843);
        for (const el of await panel.getByRole('button').all()) if (await el.isVisible()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      }
      await noHScroll(page);
      await shot(page, `mcp-${device}-${theme}-3-panel`);
      if (dir) await panel.screenshot({ path: `${dir}/mcp-${device}-${theme}-3b-panel-full.png` }).catch(() => undefined);

      // sign-in through the hub's address
      const notion = panel.getByRole('listitem', { name: /^notion: / });
      await notion.getByRole('button', { name: 'Войти' }).click();
      await expect(notion.getByRole('link', { name: 'Открыть страницу входа' })).toBeVisible();
      await expect(notion.getByRole('link', { name: 'Открыть страницу входа' })).toHaveAttribute('target', '_blank');
      await notion.scrollIntoViewIfNeeded();
      await shot(page, `mcp-${device}-${theme}-4-auth-hub`);

      // the paste fallback, a wrong address refused by the hub
      const local = { server: 'notion', authUrl: 'https://auth.example.com/authorize?client_id=own&state=s-local', redirect: 'localhost', callbackPort: 53412, expiresAt: at(8) };
      mcp.set(s1.id, { authFlows: [local] });
      hub.push({ type: 'mcp.auth', sessionId: s1.id, server: 'notion', flow: local });
      const field = notion.getByLabel('Адрес страницы после входа');
      await expect(notion.getByRole('listitem')).toHaveCount(3); // the numbered steps
      await expect(notion.getByRole('button', { name: 'Переподключить' })).toHaveCount(0);
      // a phone: the hint about copying the address of a page opened from a messenger
      if (phone) await expect(notion.getByText('На телефоне: «Открыть в браузере» или «Поделиться → Скопировать».')).toBeVisible();
      const fieldBox = (await field.boundingBox())!;
      expect(Math.round(fieldBox.height)).toBe(phone ? 40 : 32);
      await field.fill('http://localhost:53412/callback?code=abc&state=other');
      await notion.getByRole('button', { name: 'Готово' }).click();
      await expect(notion.getByRole('alert')).toContainText('Адрес не от этой попытки входа');
      // the error sits under the field, above «Готово»
      const errBox = (await notion.getByRole('alert').boundingBox())!;
      expect(errBox.y).toBeGreaterThan((await field.boundingBox())!.y);
      expect(errBox.y).toBeLessThan((await notion.getByRole('button', { name: 'Готово' }).boundingBox())!.y);
      await notion.scrollIntoViewIfNeeded();
      await noHScroll(page);
      await shot(page, `mcp-${device}-${theme}-5-auth-localhost`);

      // a reconnect in flight, then a sleeping session
      mcp.set(s1.id, { authFlows: [], servers: MCP_SERVERS.map(s => (s.name === 'scanner-fleet' ? { ...s, pendingAction: 'reconnect' } : s)) });
      await expect(panel.getByRole('listitem', { name: 'scanner-fleet: подключается' })).toBeVisible();
      await expect(panel.getByRole('listitem', { name: /^scanner-fleet/ }).getByRole('button', { name: 'Переподключить' })).toHaveCount(0);
      await panel.getByRole('listitem', { name: /^scanner-fleet/ }).scrollIntoViewIfNeeded();
      await shot(page, `mcp-${device}-${theme}-6-reconnect`);
      mcp.set(s1.id, { live: false, servers: MCP_SERVERS });
      await expect(panel.getByText('Сессия спит. Любое действие разбудит её.')).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Обновить' })).toHaveCount(0);
      await panel.locator('.mcp-head').scrollIntoViewIfNeeded();
      await shot(page, `mcp-${device}-${theme}-7-sleeping`);
      const x1 = hub.runnerList().find(r => r.id === 'x1')!;
      hub.push({ type: 'runner.status', runner: { ...x1, agentVersion: '0.2.0', protocolVersion: '1.6', outdated: true } });
      mcp.set(s1.id, { live: true, available: false, reason: 'agent_outdated' });
      await expect(panel.getByText('Управление MCP требует обновления агента')).toBeVisible();
      await expect(panel.getByText('Агент на X1 сейчас 0.2.0 (протокол 1.6), для управления MCP нужен протокол 1.7 или новее.')).toBeVisible();
      await expect(panel.getByText('Агент обновится сам после текущего хода.')).toBeVisible();
      await shot(page, `mcp-${device}-${theme}-8-outdated`);
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);

      // «Машины»
      mcp.machine('hp', { online: false, observedAt: at(-180), source: 'session' });
      mcp.machine('vm', { probing: true, servers: [], observedAt: null, source: null, probeAt: null });
      await page.goto('/settings/machines');
      const block = page.getByRole('region', { name: 'MCP-серверы' }).first();
      await expect(block).toBeVisible();
      const signIn = block.getByRole('button', { name: 'Войти' });
      await expect(signIn).toBeVisible();
      // HP is offline: its list is what was last seen
      await expect(page.getByRole('listitem', { name: 'vaultwarden: был подключён' }).first()).toBeVisible();
      await noHScroll(page);
      await block.scrollIntoViewIfNeeded();
      await shot(page, `mcp-${device}-${theme}-9-machines`);
      if (dir) await page.screenshot({ path: `${dir}/mcp-${device}-${theme}-9b-machines-full.png`, fullPage: true });

      // «Войти» on «Машины»: the machine's live session with the MCP panel, the sign-in started
      const authPosts = () => mcp.requests.filter(r => r.method === 'POST' && r.path.endsWith('/mcp/auth')).length;
      const before = authPosts();
      await signIn.click();
      const panel2 = page.getByRole('dialog', { name: 'MCP-серверы' });
      await expect(panel2.getByRole('listitem', { name: /^notion: / }).getByRole('link', { name: 'Открыть страницу входа' })).toBeVisible();
      expect(authPosts()).toBe(before + 1);
      await shot(page, `mcp-${device}-${theme}-10-machines-signin`);
    });
  }
}
