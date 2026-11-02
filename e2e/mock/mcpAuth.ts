/**
 * «Войти заново», «Выйти» and «Войти» of a 401 over MockHub (change mcp-auth-controls, design A6): the panel of a
 * session with an agent 1.8, the confirmation of «Выйти», «Выход…», and the same in the block on «Машины». No horizontal
 * scroll, buttons ≥ 40 px on the phone; screenshots when SHOTS_DIR is set (compared with docs/prototype.html,
 * ?mcp=authctl).
 */
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from './hub.js';
import { installMultiUser } from './multiuser.js';
import { MockMcp } from './mcp.js';

type Json = Record<string, unknown>;
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const srv = (over: Json): Json => ({ status: 'connected', transport: 'http', scope: 'user', toolCount: 0, persistence: 'project', canAuth: true, oauth: false, authError: false, ...over });

const SERVERS: Json[] = [
  srv({ name: 'krisp', status: 'failed', target: 'https://mcp.krisp.ai/mcp', oauth: true, authError: true, error: 'HTTP 401: Unauthorized' }),
  srv({ name: 'scanner-fleet', target: 'https://scanners.example.com/mcp', oauth: true, serverInfo: { name: 'scanner-fleet', version: '2.3.0' }, toolCount: 41 }),
  srv({ name: 'notion', target: 'https://mcp.notion.com/mcp', oauth: true, serverInfo: { name: 'notion-mcp', version: '1.2.0' }, toolCount: 14 }),
  srv({ name: 'grafana', target: 'https://grafana.example.com/mcp', scope: 'project', serverInfo: { name: 'grafana-mcp', version: '0.9.1' }, toolCount: 22 }),
  srv({
    name: 'vaultwarden',
    transport: 'stdio',
    canAuth: false,
    target: 'node C:/Users/alice/mcp/vaultwarden/dist/index.js --session •••',
    serverInfo: { name: 'vaultwarden-mcp', version: '1.4.0' },
    toolCount: 12,
  }),
];

async function noHScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

const dir = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const buttons = async (row: ReturnType<Page['getByRole']>) =>
  Promise.all((await row.getByRole('button').all()).map(async b => (await b.getAttribute('aria-label')) ?? (await b.textContent())!.trim()));
/** UI review H1/L7: the row's buttons on one line. */
async function oneLine(row: ReturnType<Page['getByRole']>) {
  const tops = await Promise.all((await row.locator('.mcp-actions > .btn, .mcp-actions .mcp-more-btn').all()).map(async b => Math.round((await b.boundingBox())!.y)));
  expect(new Set(tops).size, `one line: ${tops.join(',')}`).toBe(1);
}

export function mcpAuthSpecs(device: 'desktop' | 'phone') {
  for (const theme of ['dark', 'light'] as const) {
    test(`${device} ${theme}: «Войти заново», «Выйти» with the confirmation, «Войти» of a 401, «Машины»`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
      const hub = new MockHub({ tabs: [1] });
      const s1 = hub.session(1);
      s1.mcpProblems = 1;
      hub.runnerPatch.x1 = { agentVersion: '0.2.6', protocolVersion: '1.8' };
      await hub.install(page);
      await installMultiUser(page, hub);
      const mcp = new MockMcp(hub);
      mcp.view(s1.id, { servers: SERVERS, authControls: true });
      for (const r of ['x1', 'hp', 'vm']) mcp.machine(r, { servers: SERVERS.filter(s => s.scope === 'user'), authControls: true, source: 'session' });
      await mcp.install(page);
      // «Выйти» answers 202 with «Выход…», the new snapshot comes 1.5 s later over WS
      await page.route(/\/api\/sessions\/[^/]+\/mcp\/logout$/, r => {
        const id = new URL(r.request().url()).pathname.split('/')[3]!;
        const server = (r.request().postDataJSON() as Json).server;
        mcp.requests.push({ method: 'POST', path: new URL(r.request().url()).pathname, body: { server } });
        const v = mcp.view(id, { servers: (mcp.view(id).servers as Json[]).map(s => (s.name === server ? { ...s, pendingAction: 'logout' } : s)) });
        setTimeout(
          () =>
            mcp.set(id, {
              servers: (mcp.view(id).servers as Json[]).map(s => (s.name === server ? { ...s, pendingAction: undefined, status: 'needs-auth', serverInfo: undefined, toolCount: 0 } : s)),
            }),
          1500,
        );
        return r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(v) });
      });
      await page.goto('/');
      const phone = device === 'phone';
      if (phone) {
        await expect(page.getByRole('list', { name: 'Машины' })).toBeAttached();
        await page.locator('.side-scroll .srow', { hasText: s1.title }).first().click();
      }
      await page.getByRole('button', { name: /^MCP/ }).first().click();
      const panel = page.getByRole('dialog', { name: 'MCP-серверы' });
      const row = (n: string) => panel.getByRole('listitem', { name: new RegExp(`^${n}: `) });
      await expect(row('scanner-fleet')).toBeVisible();
      expect(await buttons(row('scanner-fleet'))).toEqual(['Переподключить', 'Войти заново', 'Действия с scanner-fleet']);
      expect(await buttons(row('krisp'))).toEqual(['Войти', 'Действия с krisp']);
      expect(await buttons(row('grafana'))).toEqual(['Переподключить', 'Выключить']);
      for (const n of ['scanner-fleet', 'notion', 'krisp', 'grafana']) await oneLine(row(n));
      // L8: every button of the rows ≥ 40 px on the phone
      if (phone) for (const el of await panel.locator('.mcp-actions button').all()) if (await el.isVisible()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await noHScroll(page);
      await shot(page, `auth-${device}-${theme}-1-panel`);

      // the «⋯» menu: «Выключить», «Выйти»
      const more = row('scanner-fleet').getByRole('button', { name: 'Действия с scanner-fleet' });
      await more.click();
      const menu = row('scanner-fleet').getByRole('menu');
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Выключить', 'Выйти']);
      if (phone) for (const el of await menu.getByRole('menuitem').all()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await noHScroll(page);
      await shot(page, `auth-${device}-${theme}-1b-menu`);
      // the confirmation of «Выйти»: Esc closes only it
      await menu.getByRole('menuitem', { name: 'Выйти' }).click();
      const confirm = row('scanner-fleet').getByRole('alertdialog');
      await expect(confirm).toContainText('Выйти из scanner-fleet на X1? Вход сбросится во всех сессиях X1 и в новых сессиях; токен будет отозван у провайдера.');
      await expect(confirm.getByRole('button', { name: 'Выйти и отозвать токен' })).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(confirm.getByRole('button', { name: 'Отмена' })).toBeFocused();
      if (phone) for (const el of await confirm.getByRole('button').all()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await row('scanner-fleet').scrollIntoViewIfNeeded();
      await noHScroll(page);
      await shot(page, `auth-${device}-${theme}-2-confirm`);
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveCount(0);
      await expect(panel).toBeVisible();

      // «Выйти» → «Выход…» → «нужен вход» with «Войти»
      await more.click();
      await menu.getByRole('menuitem', { name: 'Выйти' }).click();
      await confirm.getByRole('button', { name: 'Выйти и отозвать токен' }).click();
      await expect(row('scanner-fleet').getByText('Выход…')).toBeVisible();
      await shot(page, `auth-${device}-${theme}-3-signing-out`);
      await expect(panel.getByRole('listitem', { name: 'scanner-fleet: нужен вход' })).toBeVisible();
      await expect(row('scanner-fleet').getByRole('button', { name: 'Войти' })).toBeVisible();
      expect(mcp.requests.filter(r => r.path.endsWith('/mcp/logout'))).toHaveLength(1);
      await row('krisp').scrollIntoViewIfNeeded();
      await shot(page, `auth-${device}-${theme}-4-failed-401`);
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);

      // «Машины»: the same actions through the machine's live session
      await page.goto('/settings/machines');
      const block = page.getByRole('region', { name: 'MCP-серверы' }).first();
      await expect(block).toBeVisible();
      const mrow = (n: string) => block.getByRole('listitem', { name: new RegExp(`^${n}: `) });
      await expect(mrow('notion').getByRole('button', { name: 'Войти заново' })).toBeVisible();
      await expect(mrow('krisp').getByRole('button', { name: 'Войти' })).toBeVisible();
      await expect(mrow('krisp').getByRole('button', { name: 'Выйти' })).toHaveCount(0);
      // L9: the title and «Проверить» on one line
      const headTop = Math.round((await block.getByRole('heading', { name: 'MCP-серверы' }).boundingBox())!.y);
      const probeBox = (await block.getByRole('button', { name: 'Проверить' }).boundingBox())!;
      expect(Math.abs(headTop - Math.round(probeBox.y + probeBox.height / 2 - 10))).toBeLessThan(16);
      await mrow('notion').getByRole('button', { name: 'Выйти' }).click();
      await expect(mrow('notion').getByRole('alertdialog')).toContainText('Выйти из notion на X1? Вход сбросится во всех сессиях X1');
      if (phone) for (const el of await mrow('notion').getByRole('button').all()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await block.scrollIntoViewIfNeeded();
      await noHScroll(page);
      await shot(page, `auth-${device}-${theme}-5-machines`);
      if (dir) await block.screenshot({ path: `${dir}/auth-${device}-${theme}-5b-machines-block.png` });
      void at;
    });
  }
}
