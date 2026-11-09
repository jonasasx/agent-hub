/**
 * Web Push on this device (change web-push-notifications, design D8).
 * Requirement: Подписка устройства из настроек — the permission dialog only from a click (`enablePush`), restore on start
 * (`syncPush`), release on sign-out (`releasePush`). API: /api/push/subscriptions (see api/client.ts).
 */
import type { MeResponse } from '@agent-hub/shared';
import { api } from '../../api/client';
import { isDesktopApp } from '../voice/recorder';

export const PUSH_INTENT_KEY = 'agenthub.push.v1';
const READY_TIMEOUT_MS = 5000;

export type PushSupport = 'ok' | 'unsupported' | 'ios_install' | 'desktop_app';
export type PushStatus = 'not_configured' | 'denied' | 'on' | 'off' | Exclude<PushSupport, 'ok'>;

/** The pieces of the browser the logic reads; tests replace them. */
export interface PushEnv {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}

export function browserEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const displayStandalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  return {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || displayStandalone,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof Notification !== 'undefined',
  };
}

export function pushSupport(env: PushEnv = browserEnv()): PushSupport {
  if (isDesktopApp(env.userAgent)) return 'desktop_app';
  const ios = /iPad|iPhone|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
  if (ios && !env.standalone) return 'ios_install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  return 'ok';
}

/** sha256 hex of the endpoint: the same value the hub computes, it names «this device» in the list. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** base64url (the VAPID public key) → bytes for `applicationServerKey`. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(key: ArrayBuffer | null | undefined, vapid: string): boolean {
  if (!key) return false;
  const have = new Uint8Array(key);
  const want = urlBase64ToBytes(vapid);
  return have.length === want.length && have.every((b, i) => b === want[i]);
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('service_worker_not_ready')), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The browser's own subscription, or null (no support, no worker yet). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  try {
    const reg = await readyRegistration();
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function permission(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'default' : Notification.permission;
}

/** The page status (design D8): server configuration first, then the device, then the permission, then the subscription. */
export async function pushStatus(vapidPublicKey: string | null, hubHashes: string[], env: PushEnv = browserEnv()): Promise<{ status: PushStatus; hash: string | null }> {
  if (vapidPublicKey === null) return { status: 'not_configured', hash: null };
  const support = pushSupport(env);
  if (support !== 'ok') return { status: support, hash: null };
  if (permission() === 'denied') return { status: 'denied', hash: null };
  const sub = await currentSubscription();
  if (!sub) return { status: 'off', hash: null };
  const hash = await endpointHash(sub.endpoint);
  return { status: hubHashes.includes(hash) ? 'on' : 'off', hash };
}

/** The intent belongs to the user who turned push on: a shared browser must not subscribe the next user without a click. */
function setIntent(userId: string | null): void {
  try {
    if (userId) localStorage.setItem(PUSH_INTENT_KEY, userId);
    else localStorage.removeItem(PUSH_INTENT_KEY);
  } catch {
    // storage is unavailable: the subscription still works until the next key change
  }
}

function intentOwner(): string | null {
  try {
    return localStorage.getItem(PUSH_INTENT_KEY);
  } catch {
    return null;
  }
}

function toBody(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const json = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } };
}

/** Must run straight from a click handler: `requestPermission` is the first await, while the user gesture is alive. */
export async function enablePush(vapidPublicKey: string, userId: string): Promise<'enabled' | 'denied'> {
  const result = await Notification.requestPermission();
  if (result !== 'granted') return 'denied';
  const reg = await readyRegistration();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(vapidPublicKey) });
  try {
    await api.subscribePush(toBody(sub));
  } catch (err) {
    // do not leave a browser subscription the hub does not know
    await sub.unsubscribe().catch(() => false);
    throw err;
  }
  setIntent(userId);
  return 'enabled';
}

async function dropThisDevice(): Promise<void> {
  const sub = await currentSubscription();
  setIntent(null);
  if (!sub) return;
  const hash = await endpointHash(sub.endpoint);
  await api.deletePushByHash(hash).catch(() => undefined);
  await sub.unsubscribe().catch(() => false);
}

export async function disablePush(): Promise<void> {
  await dropThisDevice();
}

/** Sign-out: the hub and the browser lose this device before the session ends; never throws, never waits longer than `timeoutMs`. */
export async function releasePush(timeoutMs = 3000): Promise<void> {
  if (!intentOwner() && permission() !== 'granted') return;
  const work = dropThisDevice().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * On start after sign-in: restore a lost subscription or one made under another VAPID key, without a dialog. Silent on errors.
 * An intent of another user (a session that ended without the sign-out button) is not restored for this one: the stale
 * browser subscription is dropped locally (no hub call, the other user's session is gone) so that it stops receiving here.
 */
export async function syncPush(me: Pick<MeResponse, 'vapidPublicKey'> & { userId: string }): Promise<void> {
  const vapid = me.vapidPublicKey;
  const owner = intentOwner();
  if (!owner || permission() !== 'granted' || pushSupport() !== 'ok') return;
  if (owner !== me.userId) {
    setIntent(null);
    const stale = await currentSubscription().catch(() => null);
    await stale?.unsubscribe().catch(() => false);
    return;
  }
  if (!vapid) return;
  try {
    const reg = await readyRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, vapid)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(vapid) });
    await api.subscribePush(toBody(sub));
  } catch {
    // quiet: the next start tries again
  }
}
