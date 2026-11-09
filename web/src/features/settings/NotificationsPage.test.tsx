// Component test of «Настройки → Уведомления» (change web-push-notifications, tasks 3.3): every status, the permission
// dialog only from the click, the device list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PushDeviceView } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { VAPID, installPushBrowser, makeSub, removePushBrowser } from '../../test/pushBrowser';
import { endpointHash } from '../push/pushClient';
import { NotificationsPage } from './NotificationsPage';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ENDPOINT = 'https://push.example.org/a';

const signIn = (vapidPublicKey: string | null) =>
  useStore.setState({
    auth: {
      kind: 'signed_in',
      me: {
        user: { id: 'u1', email: 'a@b.c', role: 'user', name: null, provider: 'google' },
        vapidPublicKey,
        voiceInput: false,
        voiceTalk: false,
        locale: null,
        accountUrl: null,
        singleProvider: null,
      },
    },
  });

const device = (over: Partial<PushDeviceView>): PushDeviceView => ({
  id: 'd1',
  label: 'Chrome · Windows',
  endpointHash: 'f'.repeat(64),
  createdAt: '2026-11-01T10:00:00Z',
  lastSuccessAt: null,
  lastFailureAt: null,
  failureCount: 0,
  ...over,
});

const userAgent = (ua: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);

describe('NotificationsPage', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    userAgent(CHROME);
  });
  afterEach(() => {
    removePushBrowser();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('push is not configured on the server: the status says so, no buttons, no device list', async () => {
    signIn(null);
    installPushBrowser();
    mockFetch({ 'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: false, devices: [] } }) });
    render(<NotificationsPage />);
    expect(await screen.findByText('Push не настроен на сервере')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('off: «Включить» is the only trigger of the permission dialog; the dialog does not open on render', async () => {
    signIn(VAPID);
    const b = installPushBrowser();
    let devices: PushDeviceView[] = [];
    const newHash = await endpointHash('https://push.example.org/new');
    const calls = mockFetch({
      'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices } }),
      'POST /api/push/subscriptions': () => {
        devices = [device({ endpointHash: newHash })];
        return { status: 201, body: devices[0] };
      },
    });
    render(<NotificationsPage />);
    const enable = await screen.findByRole('button', { name: 'Включить push на этом устройстве' });
    expect(b.requestPermission).not.toHaveBeenCalled();
    await userEvent.click(enable);
    await waitFor(() => expect(b.requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url === '/api/push/subscriptions')).toBe(true));
    expect(await screen.findByText('Включено на этом устройстве')).toBeInTheDocument();
  });

  it('denied in the browser: explanation, no button', async () => {
    signIn(VAPID);
    installPushBrowser({ permission: 'denied' });
    mockFetch({ 'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices: [] } }) });
    render(<NotificationsPage />);
    expect(await screen.findByText('Запрещено в браузере')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Включить push на этом устройстве' })).not.toBeInTheDocument();
  });

  it('a refused dialog creates nothing and the status stays off', async () => {
    signIn(VAPID);
    const b = installPushBrowser({ grant: false });
    mockFetch({ 'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices: [] } }) });
    render(<NotificationsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Включить push на этом устройстве' }));
    await waitFor(() => expect(b.requestPermission).toHaveBeenCalled());
    expect(b.subscribe).not.toHaveBeenCalled();
  });

  it('unsupported browser', async () => {
    signIn(VAPID);
    mockFetch({ 'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices: [] } }) });
    render(<NotificationsPage />);
    expect(await screen.findByText('Этот браузер не поддерживает push-уведомления')).toBeInTheDocument();
  });

  it('iOS outside the Home Screen: the hint instead of the button, no permission request', async () => {
    signIn(VAPID);
    userAgent(IPHONE);
    const b = installPushBrowser();
    mockFetch({ 'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices: [] } }) });
    render(<NotificationsPage />);
    expect(await screen.findByText(/Добавьте Agent Hub на экран «Домой»/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Включить push на этом устройстве' })).not.toBeInTheDocument();
    expect(b.requestPermission).not.toHaveBeenCalled();
  });

  it('the desktop app: the explanation, never a subscription', async () => {
    signIn(VAPID);
    userAgent(`${CHROME} Electron/33.0.0`);
    const b = installPushBrowser();
    mockFetch({ 'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices: [] } }) });
    render(<NotificationsPage />);
    expect(await screen.findByText(/показывает свои системные уведомления/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Включить push на этом устройстве' })).not.toBeInTheDocument();
    expect(b.requestPermission).not.toHaveBeenCalled();
  });

  it('on: this device is marked, «Отправить тестовое» posts the hash, the list shows delivery and failures', async () => {
    signIn(VAPID);
    installPushBrowser({ permission: 'granted', sub: makeSub(ENDPOINT, VAPID) });
    const mine = await endpointHash(ENDPOINT);
    const calls = mockFetch({
      'GET /api/push/subscriptions': () => ({
        status: 200,
        body: {
          configured: true,
          devices: [device({ id: 'd1', endpointHash: mine, lastSuccessAt: '2026-11-05T10:00:00Z' }), device({ id: 'd2', label: 'Safari · iOS', endpointHash: '1'.repeat(64), failureCount: 3 })],
        },
      }),
      'POST /api/push/test': () => ({ status: 204 }),
    });
    render(<NotificationsPage />);
    expect(await screen.findByText('Включено на этом устройстве')).toBeInTheDocument();
    expect(screen.getByText('Это устройство')).toBeInTheDocument();
    expect(screen.getByText('Safari · iOS')).toBeInTheDocument();
    expect(screen.getByText('Пока ничего не доставлено')).toBeInTheDocument();
    expect(screen.getByText(/Доставка не удаётся: 3 подряд/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Отправить тестовое уведомление' }));
    await waitFor(() => expect(calls.find(c => c.url === '/api/push/test')?.body).toEqual({ endpointHash: mine }));
  });

  it('«Отключить» on another device deletes it by id', async () => {
    signIn(VAPID);
    installPushBrowser({ permission: 'granted', sub: makeSub(ENDPOINT, VAPID) });
    const mine = await endpointHash(ENDPOINT);
    let devices = [device({ id: 'd1', endpointHash: mine }), device({ id: 'd2', label: 'Safari · iOS', endpointHash: '1'.repeat(64) })];
    const calls = mockFetch({
      'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices } }),
      'DELETE /api/push/subscriptions/d2': () => {
        devices = devices.filter(d => d.id !== 'd2');
        return { status: 204 };
      },
    });
    render(<NotificationsPage />);
    await screen.findByText('Safari · iOS');
    await userEvent.click(screen.getByRole('button', { name: 'Отключить: Safari · iOS' }));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.url === '/api/push/subscriptions/d2')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Safari · iOS')).not.toBeInTheDocument());
  });

  it('«Отключить» on this device drops the browser subscription and the hub record', async () => {
    signIn(VAPID);
    const b = installPushBrowser({ permission: 'granted', sub: makeSub(ENDPOINT, VAPID) });
    const sub = b.sub!;
    const mine = await endpointHash(ENDPOINT);
    const calls = mockFetch({
      'GET /api/push/subscriptions': () => ({ status: 200, body: { configured: true, devices: [device({ endpointHash: mine })] } }),
      'DELETE /api/push/subscriptions': () => ({ status: 204 }),
    });
    render(<NotificationsPage />);
    await screen.findByText('Включено на этом устройстве');
    await userEvent.click(screen.getByRole('button', { name: 'Отключить: Chrome · Windows' }));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.url === `/api/push/subscriptions?endpointHash=${mine}`)).toBe(true));
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
});
